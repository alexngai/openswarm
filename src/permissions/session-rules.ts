/**
 * SessionAllowRules — session-scoped "always allow" rules for bash commands.
 *
 * Phase 3 B4 (remediation plan): when the user approves a bash Warn prompt
 * with session scope ("always allow"), the command's prefix is remembered so
 * identical-prefix commands skip the prompt for the rest of the session.
 *
 * Guardrails (decision Q7):
 *   - Rules live in memory only — nothing is persisted to disk. A new
 *     session starts clean.
 *   - Rule creation is vetted by `checkBannedPrefix` (Codex execpolicy
 *     mirror): overly-broad prefixes (`bash`, `python`, `bash -c`, ...) are
 *     refused. The triggering call is still allowed once; only the standing
 *     rule is refused.
 *   - `danger-full-access` mode bypasses the banned-prefix veto (the
 *     explicit yolo config).
 *   - Rules only silence repeat Warn prompts. They never override Block
 *     results or permission-mode denial (enforced by the call site in
 *     bash-gate.ts, which consults rules only on the Warn path).
 */

import { checkBannedPrefix } from "../tools/tier0/banned-prefixes.js";
import type { PermissionMode } from "../core/types.js";

/**
 * Derive the rule prefix recorded for a command: its first two tokens
 * (or one, for single-token commands). "git push origin main" → "git push";
 * "ls" → "ls". Coarse enough to be useful across invocations, narrow enough
 * that `checkBannedPrefix` can veto interpreter/shell escapes ("bash -c").
 */
export function deriveRulePrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

export type AddRuleResult =
  | { readonly added: true; readonly prefix: string }
  | { readonly added: false; readonly prefix: string; readonly reason: string };

export class SessionAllowRules {
  private readonly prefixes = new Set<string>();

  /**
   * Try to record a session allow rule for `command`. Refuses banned-broad
   * prefixes unless `mode` is danger-full-access.
   */
  tryAdd(command: string, mode: PermissionMode): AddRuleResult {
    const prefix = deriveRulePrefix(command);
    if (prefix.length === 0) {
      return { added: false, prefix, reason: "empty command" };
    }

    if (mode !== "danger-full-access") {
      const banned = checkBannedPrefix(prefix);
      if (banned !== null) {
        return {
          added: false,
          prefix,
          reason:
            `"${prefix}" is too broad to always-allow (${banned} can run arbitrary code). ` +
            `Approved this once; you'll be asked again next time.`,
        };
      }
    }

    this.prefixes.add(prefix);
    return { added: true, prefix };
  }

  /**
   * Does `command` match a previously recorded session rule? Checks both the
   * 1-token and 2-token prefixes, so a rule recorded from a single-token
   * command (only possible in danger-full-access) still matches longer
   * invocations of that binary.
   */
  matches(command: string): boolean {
    const tokens = command.trim().split(/\s+/);
    if (tokens.length === 0 || tokens[0]!.length === 0) return false;
    if (this.prefixes.has(tokens[0]!)) return true;
    return tokens.length >= 2 && this.prefixes.has(`${tokens[0]} ${tokens[1]}`);
  }

  /** Snapshot of active rules (for display/testing). */
  list(): readonly string[] {
    return [...this.prefixes];
  }
}
