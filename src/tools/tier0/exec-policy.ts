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
    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) {
      return { decision: "allow", matchedRule: null };
    }

    // Unwrap shell -c wrappers: bash -c "...", sh -c "..."
    const unwrapped = unwrapShellCommand(tokens);
    const effectiveTokens = unwrapped ?? tokens;

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
// Shell -c unwrapping (E4 lite)
// ---------------------------------------------------------------------------

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

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
  candidates.push("/etc/swarm-harness/rules.json");

  // Project layer
  candidates.push(path.join(cwd, ".swarm-harness", "rules.json"));

  // User layer
  candidates.push(path.join(home, ".swarm-harness", "rules.json"));

  // Env override (highest priority)
  const envDir = env.SWARM_HARNESS_CONFIG_DIR;
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
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return null;

  const unwrapped = unwrapShellCommand(tokens);
  const effective = unwrapped ?? tokens;

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
  const filePath = path.join(home, ".swarm-harness", "rules.json");

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
