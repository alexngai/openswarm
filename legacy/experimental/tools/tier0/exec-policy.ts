/**
 * Declarative execution policy engine (E1).
 *
 * Evaluates shell commands against configurable prefix rules loaded from
 * layered .rules.json files (system → project → user). Rules use prefix
 * matching with support for alternative tokens.
 *
 * Decisions: "allow" | "prompt" | "forbidden"
 * When multiple rules match, strictest wins (forbidden > prompt > allow).
 *
 * Integrates with existing bash-validation submodules — exec-policy runs
 * first, then bash-validation gates apply on top.
 *
 * Rule format (JSON):
 *   {
 *     "rules": [
 *       { "pattern": ["git", "push"], "decision": "prompt",
 *         "justification": "modifies remote state" },
 *       { "pattern": ["npm", ["install", "ci"]], "decision": "allow" },
 *       { "pattern": ["rm", "-rf"], "decision": "forbidden",
 *         "justification": "dangerous recursive delete" }
 *     ]
 *   }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyDecision = "allow" | "prompt" | "forbidden";

export interface PrefixRule {
  readonly pattern: readonly (string | readonly string[])[];
  readonly decision: PolicyDecision;
  readonly justification?: string;
}

export interface ExecPolicyConfig {
  readonly rules: readonly PrefixRule[];
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly matchedRule: PrefixRule | null;
  readonly justification?: string;
}

// ---------------------------------------------------------------------------
// Command tokenization
// ---------------------------------------------------------------------------

export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Prefix matching
// ---------------------------------------------------------------------------

export function matchesRule(tokens: readonly string[], rule: PrefixRule): boolean {
  const pattern = rule.pattern;
  if (pattern.length === 0) return false;
  if (tokens.length < pattern.length) return false;

  for (let i = 0; i < pattern.length; i++) {
    const element = pattern[i]!;
    const token = tokens[i]!;

    if (typeof element === "string") {
      if (basenameOf(token) !== basenameOf(element) && token !== element) {
        return false;
      }
    } else {
      const alternatives = element as readonly string[];
      const matched = alternatives.some(
        (alt) => basenameOf(token) === basenameOf(alt) || token === alt,
      );
      if (!matched) return false;
    }
  }

  return true;
}

function basenameOf(cmd: string): string {
  const slash = cmd.lastIndexOf("/");
  return slash >= 0 ? cmd.slice(slash + 1) : cmd;
}

// ---------------------------------------------------------------------------
// Decision severity ordering
// ---------------------------------------------------------------------------

const SEVERITY: Record<PolicyDecision, number> = {
  allow: 0,
  prompt: 1,
  forbidden: 2,
};

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

export class ExecPolicy {
  private readonly rules: readonly PrefixRule[];

  constructor(config: ExecPolicyConfig) {
    this.rules = config.rules;
  }

  evaluate(command: string): PolicyEvaluation {
    const effectiveTokens = canonicalizeCommand(command);
    if (effectiveTokens.length === 0) {
      return { decision: "allow", matchedRule: null };
    }

    let strictest: PrefixRule | null = null;
    let strictestSeverity = -1;

    for (const rule of this.rules) {
      if (matchesRule(effectiveTokens, rule)) {
        const sev = SEVERITY[rule.decision];
        if (sev > strictestSeverity) {
          strictest = rule;
          strictestSeverity = sev;
        }
      }
    }

    if (!strictest) {
      return { decision: "prompt", matchedRule: null };
    }

    return {
      decision: strictest.decision,
      matchedRule: strictest,
      justification: strictest.justification,
    };
  }

  get ruleCount(): number {
    return this.rules.length;
  }

  static empty(): ExecPolicy {
    return new ExecPolicy({ rules: [] });
  }
}

// ---------------------------------------------------------------------------
// Command canonicalization (E4)
// ---------------------------------------------------------------------------

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

/**
 * Canonicalize a command by stripping wrappers that obscure the real command.
 * Exported for direct use and testing.
 *
 * Handles:
 *   - Shell -c/-lc wrappers (bash -c "...", sh -lc "...")
 *   - env/sudo/nohup/nice prefixes
 *   - Interpreter -e wrappers (python -c, ruby -e, perl -e, node -e)
 *   - Heredoc removal (<<EOF...EOF)
 *   - Leading VAR=value assignments
 */
export function canonicalizeCommand(command: string): string[] {
  let tokens = tokenizeCommand(command);
  if (tokens.length === 0) return tokens;

  tokens = stripEnvVarPrefixes(tokens);
  tokens = stripCommandPrefixes(tokens);

  const unwrapped = unwrapShellCommand(tokens);
  if (unwrapped) return unwrapped;

  const interpreterUnwrap = unwrapInterpreter(tokens);
  if (interpreterUnwrap) return interpreterUnwrap;

  return stripHeredoc(tokens);
}

function unwrapShellCommand(tokens: readonly string[]): string[] | null {
  if (tokens.length < 3) return null;

  const cmd = basenameOf(tokens[0]!);
  if (!SHELL_COMMANDS.has(cmd)) return null;

  let flagIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === "-c" || tokens[i] === "-lc") {
      flagIdx = i;
      break;
    }
  }

  if (flagIdx < 0 || flagIdx + 1 >= tokens.length) return null;

  const inner = tokens.slice(flagIdx + 1).join(" ");
  return tokenizeCommand(inner);
}

const ENV_VAR_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

function stripEnvVarPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_VAR_PREFIX_RE.test(tokens[i]!)) {
    i++;
  }
  return i > 0 ? tokens.slice(i) : tokens;
}

const COMMAND_PREFIXES = new Set([
  "env", "sudo", "nohup", "nice", "ionice", "timeout",
  "strace", "ltrace", "time", "command", "builtin", "exec",
]);

function stripCommandPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const cmd = basenameOf(tokens[i]!);
    if (!COMMAND_PREFIXES.has(cmd)) break;
    i++;
    // Skip flags for these commands (e.g., sudo -u root, env -i)
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      i++;
      // Some flags take a value (sudo -u root)
      if (i < tokens.length && !tokens[i]!.startsWith("-") &&
          !COMMAND_PREFIXES.has(basenameOf(tokens[i]!))) {
        // Peek: if next token looks like a flag value, skip it
        const prev = tokens[i - 1];
        if (prev === "-u" || prev === "-g" || prev === "-C" || prev === "-D") {
          i++;
        }
      }
    }
  }
  return i > 0 ? tokens.slice(i) : tokens;
}

const INTERPRETER_COMMANDS = new Map<string, string>([
  ["python", "-c"], ["python3", "-c"], ["python2", "-c"],
  ["ruby", "-e"], ["perl", "-e"], ["node", "-e"],
]);

function unwrapInterpreter(tokens: readonly string[]): string[] | null {
  if (tokens.length < 3) return null;

  const cmd = basenameOf(tokens[0]!);
  const expectedFlag = INTERPRETER_COMMANDS.get(cmd);
  if (!expectedFlag) return null;

  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === expectedFlag && i + 1 < tokens.length) {
      return [cmd, expectedFlag, tokens.slice(i + 1).join(" ")];
    }
  }
  return null;
}

function stripHeredoc(tokens: string[]): string[] {
  const heredocIdx = tokens.findIndex((t) => /^<<-?'?[A-Za-z_]+/.test(t));
  if (heredocIdx < 0) return tokens;
  return tokens.slice(0, heredocIdx);
}

// ---------------------------------------------------------------------------
// Config loading (layered: system → project → user)
// ---------------------------------------------------------------------------

export interface LoadExecPolicyOptions {
  readonly cwd?: string;
  readonly homedir?: string;
  readonly envOverrides?: Record<string, string | undefined>;
}

export function loadExecPolicyConfig(
  opts: LoadExecPolicyOptions = {},
): ExecPolicyConfig {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homedir ?? os.homedir();
  const env = opts.envOverrides ?? process.env;

  const candidates: string[] = [];

  // System layer (lowest priority)
  candidates.push("/etc/openswarm/rules.json");

  // Project layer
  candidates.push(path.join(cwd, ".openswarm", "rules.json"));

  // User layer
  candidates.push(path.join(home, ".openswarm", "rules.json"));

  // Env override (highest priority)
  const envDir = env.OPENSWARM_CONFIG_DIR;
  if (envDir !== undefined && envDir.length > 0) {
    candidates.push(path.join(envDir, "rules.json"));
  }

  const allRules: PrefixRule[] = [];

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.rules)) {
        for (const r of parsed.rules) {
          const rule = validateRule(r);
          if (rule) allRules.push(rule);
        }
      }
    } catch {
      continue;
    }
  }

  return { rules: allRules };
}

function validateRule(raw: unknown): PrefixRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.pattern) || obj.pattern.length === 0) return null;

  const pattern: (string | string[])[] = [];
  for (const element of obj.pattern) {
    if (typeof element === "string") {
      pattern.push(element);
    } else if (Array.isArray(element) && element.every((e) => typeof e === "string")) {
      pattern.push(element as string[]);
    } else {
      return null;
    }
  }

  const decision = obj.decision;
  if (decision !== "allow" && decision !== "prompt" && decision !== "forbidden") {
    return null;
  }

  const justification =
    typeof obj.justification === "string" ? obj.justification : undefined;

  return { pattern, decision, justification };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _policy: ExecPolicy | undefined;

export function getExecPolicy(opts?: LoadExecPolicyOptions): ExecPolicy {
  if (!_policy) {
    const config = loadExecPolicyConfig(opts);
    _policy = new ExecPolicy(config);
  }
  return _policy;
}

export function setExecPolicy(policy: ExecPolicy): void {
  _policy = policy;
}

export function resetExecPolicy(): void {
  _policy = undefined;
}

// ---------------------------------------------------------------------------
// Auto-amendment (E2)
// ---------------------------------------------------------------------------

export interface AmendmentSuggestion {
  readonly rule: PrefixRule;
  readonly source: string;
}

export function deriveAmendment(command: string): AmendmentSuggestion | null {
  const effective = canonicalizeCommand(command);
  if (effective.length === 0) return null;

  const prefixLen = Math.min(effective.length, 3);
  const pattern = effective.slice(0, prefixLen);

  return {
    rule: { pattern, decision: "allow", justification: "auto-approved by user" },
    source: command,
  };
}

export function persistAmendment(
  amendment: AmendmentSuggestion,
  opts: LoadExecPolicyOptions = {},
): void {
  const home = opts.homedir ?? os.homedir();
  const filePath = path.join(home, ".openswarm", "rules.json");

  let existing: { rules: PrefixRule[] } = { rules: [] };
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (raw && Array.isArray(raw.rules)) {
        existing.rules = raw.rules;
      }
    }
  } catch {
    // start fresh
  }

  const isDuplicate = existing.rules.some(
    (r) => JSON.stringify(r.pattern) === JSON.stringify(amendment.rule.pattern) &&
      r.decision === amendment.rule.decision,
  );
  if (isDuplicate) return;

  existing.rules.push(amendment.rule);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");

  resetExecPolicy();
}
