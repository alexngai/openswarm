/**
 * tool-call-repair — recover a dispatchable tool call from a malformed one.
 *
 * Frontier models emit tool calls the provider SDK can parse without help.
 * Open-weight models served behind an OpenAI-compatible endpoint (vLLM, SGLang,
 * llama.cpp, Ollama, LiteLLM) frequently do not: the serving layer's tool-call
 * parser is model-family specific, and when it mis-fires the call arrives with
 * an aliased name, an extra envelope around the arguments, or an argument
 * string that is not valid JSON. Today every one of those cases ends the same
 * way — the call never materialises as a `tool-call` event, the turn looks
 * "terminal", and the agent stops after one turn having narrated a tool call it
 * never made (docs/63-tool-call-repair.md §1).
 *
 * This module holds the pure, provider-agnostic primitives for that recovery.
 * Everything here is deterministic and dependency-free — no extra model round
 * trip. Policy (when to attempt repair, how aggressive to be) lives in
 * `src/engine/tool-call-recovery.ts`; the engines call that, not this.
 *
 * Repair NEVER bypasses validation. A repaired call is handed back to the
 * normal path — `canUseTool` gate, then `ToolDispatcher.dispatch`, which still
 * validates against the tool's Zod schema. Repair only buys the model's intent
 * a chance to reach that gate instead of being silently dropped.
 */

// ---------------------------------------------------------------------------
// Tool-name aliases
// ---------------------------------------------------------------------------

/**
 * Canonical alias → real tool name. These are the names open-weight models
 * actually hallucinate: generic verbs (`run`, `execute`), other harnesses'
 * tool names (`str_replace_editor` from Anthropic computer-use, `apply_patch`
 * from Codex), and language-specific runners (`python`, `pytest`).
 *
 * An alias is only ever applied when the requested name is NOT itself a
 * registered tool, so a real `apply_patch` tool always wins over the alias
 * that maps `apply_patch` → `edit_file`.
 */
export const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // shell
  cmd: "bash",
  command: "bash",
  exec: "bash",
  execute: "bash",
  execute_command: "bash",
  run: "bash",
  run_command: "bash",
  run_shell_command: "bash",
  run_terminal_cmd: "bash",
  shell: "bash",
  sh: "bash",
  terminal: "bash",
  console: "bash",
  python: "bash",
  python3: "bash",
  pytest: "bash",
  npm: "bash",
  node: "bash",

  // editing
  edit: "edit_file",
  patch: "edit_file",
  replace: "edit_file",
  str_replace: "edit_file",
  str_replace_editor: "edit_file",
  str_replace_based_edit_tool: "edit_file",
  apply_patch: "edit_file",
  edit_files: "edit_file",
  modify_file: "edit_file",
  update_file: "edit_file",

  // reading
  read: "read_file",
  cat: "read_file",
  open: "read_file",
  open_file: "read_file",
  view: "read_file",
  view_file: "read_file",
  get_file: "read_file",
  file_read: "read_file",

  // writing
  write: "write_file",
  create: "write_file",
  create_file: "write_file",
  new_file: "write_file",
  save_file: "write_file",
  file_write: "write_file",

  // search
  find: "glob",
  find_files: "glob",
  list_files: "glob",
  list_dir: "glob",
  ls: "glob",
  search: "grep",
  search_files: "grep",
  grep_search: "grep",
  ripgrep: "grep",
  rg: "grep",

  // planning
  todo: "todo_write",
  todos: "todo_write",
  todowrite: "todo_write",
  update_todo: "todo_write",
  update_plan: "todo_write",
  plan: "todo_write",
});

/**
 * Namespace prefixes some servers and chat templates prepend to tool names
 * (`functions.bash`, `default_api.read_file`). Stripped before matching.
 */
const NAME_PREFIXES: readonly string[] = [
  "functions.",
  "functions:",
  "tools.",
  "tool.",
  "default_api.",
  "namespace.",
];

/** Keys under which models wrap the real argument object. */
const ARGUMENT_ENVELOPE_KEYS: readonly string[] = [
  "arguments",
  "parameters",
  "input",
  "inputs",
  "args",
  "tool_input",
  "kwargs",
  "properties",
];

/** Lowercase + strip everything that isn't a letter or digit. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip a leading namespace prefix, if present. */
function stripNamePrefix(name: string): string {
  for (const prefix of NAME_PREFIXES) {
    if (name.toLowerCase().startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

/**
 * Levenshtein distance, bounded: returns `max + 1` as soon as it is certain the
 * true distance exceeds `max`, so a long-string comparison stays cheap.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    // Every remaining path goes through this row — if the whole row already
    // exceeds the budget, the final distance does too.
    if (rowMin > max) return max + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length]!;
}

export interface NameRepair {
  /** The resolved, registered tool name. */
  readonly name: string;
  /** Human-readable description of the transform, or `undefined` if exact. */
  readonly repair?: string;
}

/**
 * Resolve a model-supplied tool name against the registered tool surface.
 *
 * Ladder, most-confident first:
 *   1. exact match                      → no repair
 *   2. namespace-prefix strip           → `functions.bash` → `bash`
 *   3. case-insensitive match           → `Bash` → `bash`
 *   4. alias table                       → `shell` → `bash`
 *   5. punctuation-insensitive match     → `edit-file` / `editFile` → `edit_file`
 *   6. unique nearest neighbour (edit distance ≤ 2)
 *
 * Returns `undefined` when nothing resolves — the caller then falls back to the
 * existing `invalid_tool_name` feedback, which is still the better outcome for
 * a genuinely invented tool.
 */
export function repairToolName(
  requested: string,
  available: readonly string[],
): NameRepair | undefined {
  if (available.length === 0) return undefined;
  const availableSet = new Set(available);

  // 1. Exact.
  if (availableSet.has(requested)) return { name: requested };

  // 2. Namespace prefix.
  const unprefixed = stripNamePrefix(requested);
  if (unprefixed !== requested && availableSet.has(unprefixed)) {
    return { name: unprefixed, repair: `stripped namespace prefix from "${requested}"` };
  }

  // 3. Case-insensitive.
  const lower = unprefixed.toLowerCase();
  for (const candidate of available) {
    if (candidate.toLowerCase() === lower) {
      return { name: candidate, repair: `case-corrected "${requested}"` };
    }
  }

  // 4. Alias table — only when the alias target is actually registered.
  const aliased = TOOL_NAME_ALIASES[lower];
  if (aliased !== undefined && availableSet.has(aliased)) {
    return { name: aliased, repair: `aliased "${requested}" → "${aliased}"` };
  }

  // 5. Punctuation-insensitive (snake/kebab/camel drift).
  const normalized = normalizeName(unprefixed);
  const punctuationMatches = available.filter(
    (candidate) => normalizeName(candidate) === normalized,
  );
  if (punctuationMatches.length === 1) {
    return {
      name: punctuationMatches[0]!,
      repair: `normalized "${requested}" → "${punctuationMatches[0]!}"`,
    };
  }

  // 6. Unique nearest neighbour. Require a unique winner so an ambiguous
  //    typo is reported as unknown rather than silently routed to one of two
  //    equally-close tools.
  const MAX_DISTANCE = 2;
  let best: string | undefined;
  let bestDistance = MAX_DISTANCE + 1;
  let tied = false;
  for (const candidate of available) {
    const distance = boundedEditDistance(normalized, normalizeName(candidate), MAX_DISTANCE);
    if (distance > MAX_DISTANCE) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }
  if (best !== undefined && !tied) {
    return { name: best, repair: `fuzzy-matched "${requested}" → "${best}"` };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Argument-string coercion
// ---------------------------------------------------------------------------

/** Strip a markdown code fence (```json … ```) if the whole string is one. */
function stripCodeFence(raw: string): string | undefined {
  const match = /^\s*```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return match ? match[1]! : undefined;
}

/** Strip tool-call wrapper tags a mis-configured template leaves in the string. */
function stripWrapperTags(raw: string): string | undefined {
  const stripped = raw
    .replace(/<\|?(?:python_tag|tool_call|tool▁call|function_call)\|?>/gi, "")
    .replace(/<\/\|?(?:tool_call|tool▁call|function_call)\|?>/gi, "")
    .replace(/<\|(?:eom_id|eot_id|im_end)\|>/gi, "")
    .trim();
  return stripped === raw.trim() ? undefined : stripped;
}

/**
 * Extract the first balanced `{…}` (or `[…]`) region, respecting string
 * literals and escapes. When the region never closes — a stream truncated by
 * `max_tokens`, the single most common open-weight failure — the unterminated
 * remainder is returned so `closeUnbalanced` can finish it.
 */
export function extractFirstJsonRegion(raw: string): string | undefined {
  const start = raw.search(/[{[]/);
  if (start === -1) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) {
        stack.pop();
        if (stack.length === 0) return raw.slice(start, i + 1);
      } else {
        // Mismatched closer — give up on structural extraction.
        return raw.slice(start);
      }
    }
  }
  // Never closed — truncated.
  return raw.slice(start);
}

/**
 * Close an unterminated JSON fragment. Walks the fragment tracking string state
 * and open brackets, then closes what is still open. A dangling key or trailing
 * comma is trimmed back to the last complete value first, since `{"a":1,"b":`
 * cannot be closed into anything valid.
 */
export function closeUnbalanced(fragment: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }

  if (stack.length === 0 && !inString) return undefined; // nothing to close

  let body = fragment;
  if (inString) body += '"';
  // Drop a dangling `,` / `:` / `"key":` tail that no closer can rescue.
  body = body.replace(/,\s*$/, "").replace(/[,{[]?\s*"[^"]*"\s*:\s*$/, (m) =>
    m.trimStart().startsWith(",") ? "" : m.startsWith("{") ? "{" : m.startsWith("[") ? "[" : "",
  );
  return body + stack.reverse().join("");
}

/** Replace Python/JS literals that models leak into "JSON". */
function normalizeLiterals(raw: string): string | undefined {
  const replaced = raw
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\b(?:None|undefined|NaN)\b/g, "null");
  return replaced === raw ? undefined : replaced;
}

/** Remove trailing commas before a closer. */
function stripTrailingCommas(raw: string): string | undefined {
  const replaced = raw.replace(/,(\s*[}\]])/g, "$1");
  return replaced === raw ? undefined : replaced;
}

/**
 * Convert single-quoted to double-quoted. Only attempted when the fragment
 * contains no double quotes at all — otherwise the transform is far too likely
 * to corrupt a legitimate string containing an apostrophe.
 */
function normalizeSingleQuotes(raw: string): string | undefined {
  if (raw.includes('"') || !raw.includes("'")) return undefined;
  return raw.replace(/'/g, '"');
}

/** Quote bare object keys: `{path: "x"}` → `{"path": "x"}`. */
function quoteBareKeys(raw: string): string | undefined {
  const replaced = raw.replace(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,
    '$1"$2"$3',
  );
  return replaced === raw ? undefined : replaced;
}

export interface ArgumentCoercion {
  readonly value: unknown;
  readonly repairs: readonly string[];
}

const MAX_ARGUMENT_CHARS = 512 * 1024;

/**
 * Coerce a model-supplied argument string into a JSON value.
 *
 * Transforms are applied cumulatively — each one is kept only if it is a
 * strict improvement (i.e. the accumulated string parses, or the transform
 * changed something and later steps may still rescue it). After every step the
 * candidate is re-parsed, so the first success wins and no further mangling
 * happens. Returns `undefined` when nothing parses.
 */
export function coerceArgumentJson(raw: string): ArgumentCoercion | undefined {
  if (raw.length > MAX_ARGUMENT_CHARS) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const repairs: string[] = [];
  let candidate = trimmed;

  const attempt = (): ArgumentCoercion | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      // A double-encoded argument object — `"{\"path\":\"x\"}"` — parses to a
      // string on the first pass. Unwrap once.
      if (typeof parsed === "string") {
        try {
          const inner: unknown = JSON.parse(parsed);
          if (inner !== null && typeof inner === "object") {
            return { value: inner, repairs: [...repairs, "decoded double-encoded JSON string"] };
          }
        } catch {
          /* not double-encoded — fall through */
        }
      }
      return { value: parsed, repairs };
    } catch {
      return undefined;
    }
  };

  const steps: readonly (readonly [string, (s: string) => string | undefined])[] = [
    ["unwrapped markdown code fence", stripCodeFence],
    ["stripped tool-call wrapper tags", stripWrapperTags],
    ["extracted embedded JSON object", extractFirstJsonRegion],
    ["normalized Python/JS literals", normalizeLiterals],
    ["removed trailing commas", stripTrailingCommas],
    ["quoted bare object keys", quoteBareKeys],
    ["converted single quotes", normalizeSingleQuotes],
    ["closed truncated JSON", closeUnbalanced],
  ];

  let result = attempt();
  if (result !== undefined) return result;

  for (const [label, transform] of steps) {
    const next = transform(candidate);
    if (next === undefined || next === candidate) continue;
    candidate = next;
    repairs.push(label);
    result = attempt();
    if (result !== undefined) return result;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Argument-envelope unwrapping
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface EnvelopeUnwrap {
  readonly value: unknown;
  readonly repair: string;
}

/**
 * Unwrap the `{ "arguments": { … } }` / `{ "name": …, "parameters": { … } }`
 * envelopes models emit when they echo the tool-call schema into the argument
 * slot itself.
 *
 * Only unwraps when the envelope is unambiguous: the object's keys must be a
 * subset of `{name, <envelope key>}` and the envelope value must be an object
 * (or a JSON string that decodes to one). A tool that legitimately takes an
 * `input` parameter alongside others is therefore never unwrapped.
 */
export function unwrapArgumentEnvelope(value: unknown): EnvelopeUnwrap | undefined {
  if (!isPlainObject(value)) return undefined;

  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 2) return undefined;

  const envelopeKey = keys.find((k) => ARGUMENT_ENVELOPE_KEYS.includes(k.toLowerCase()));
  if (envelopeKey === undefined) return undefined;
  // With two keys the other one must be the tool name — anything else means
  // this is a real argument object that happens to have an `input` field.
  if (keys.length === 2) {
    const other = keys.find((k) => k !== envelopeKey)!;
    if (other.toLowerCase() !== "name" && other.toLowerCase() !== "tool") return undefined;
  }

  let inner = value[envelopeKey];
  if (typeof inner === "string") {
    const coerced = coerceArgumentJson(inner);
    if (coerced === undefined || !isPlainObject(coerced.value)) return undefined;
    inner = coerced.value;
  }
  if (!isPlainObject(inner)) return undefined;

  return { value: inner, repair: `unwrapped "${envelopeKey}" envelope` };
}

// ---------------------------------------------------------------------------
// Combined repair
// ---------------------------------------------------------------------------

export interface ToolCallRepairInput {
  /** Tool name as the model produced it. */
  readonly name: string;
  /** Parsed input, when the transport managed to produce one. */
  readonly input?: unknown;
  /** Raw argument string, when the transport did not. */
  readonly rawArguments?: string;
  /** Registered tool names — the resolution target. */
  readonly availableTools: readonly string[];
}

export interface ToolCallRepairResult {
  readonly name: string;
  readonly input: unknown;
  /** Ordered audit trail; empty means the call was already well-formed. */
  readonly repairs: readonly string[];
  /** Present when the name changed. */
  readonly originalName?: string;
}

/**
 * Full repair pass over one tool call: resolve the name, then coerce and
 * unwrap the arguments. Returns `undefined` only when the name cannot be
 * resolved to a registered tool — an unresolvable name is better served by the
 * existing `invalid_tool_name` feedback than by a guess.
 *
 * Arguments that cannot be coerced are returned as `{}` with a recorded
 * repair: dispatching with empty arguments produces a precise
 * `invalid_tool_arguments` schema error the model can act on, which beats
 * dropping the call entirely.
 */
export function repairToolCall(args: ToolCallRepairInput): ToolCallRepairResult | undefined {
  const nameRepair = repairToolName(args.name, args.availableTools);
  if (nameRepair === undefined) return undefined;

  const repairs: string[] = [];
  if (nameRepair.repair !== undefined) repairs.push(nameRepair.repair);

  let input: unknown = args.input;

  if (input === undefined && args.rawArguments !== undefined) {
    const coerced = coerceArgumentJson(args.rawArguments);
    if (coerced === undefined) {
      repairs.push("could not parse arguments; dispatching empty object");
      input = {};
    } else {
      input = coerced.value;
      repairs.push(...coerced.repairs);
    }
  }

  // A transport may hand back a string input when the model double-encoded it.
  if (typeof input === "string") {
    const coerced = coerceArgumentJson(input);
    if (coerced !== undefined && isPlainObject(coerced.value)) {
      input = coerced.value;
      repairs.push(...coerced.repairs, "decoded string-encoded arguments");
    }
  }

  const unwrapped = unwrapArgumentEnvelope(input);
  if (unwrapped !== undefined) {
    input = unwrapped.value;
    repairs.push(unwrapped.repair);
  }

  if (input === undefined || input === null) {
    input = {};
    repairs.push("substituted empty arguments for missing input");
  }

  return {
    name: nameRepair.name,
    input,
    repairs,
    ...(nameRepair.name !== args.name ? { originalName: args.name } : {}),
  };
}
