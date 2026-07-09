/**
 * handoff.ts — lossless multi-agent handoff helpers (docs/52 Phase A).
 *
 * The cascade and critic-loop share one workspace `cwd`, so the applied change lives in
 * the working tree — one `git diff` away. These helpers materialize it for a receiving
 * agent (escalated tier / reviewing critic) so the handoff carries the ACTUAL patch, not
 * a prose summary of it. Best-effort: no exec / not a git repo / empty diff → undefined,
 * and callers render a placeholder.
 */
import type { ExecFn } from "./escalation-evaluator.js";

/** Cap injected diffs so a huge change can't blow up the receiving agent's prompt. */
const MAX_DIFF_CHARS = 20_000;

/**
 * The shared workspace's applied change as a unified diff (tracked edits) plus a list of
 * new/untracked files. Returns undefined when unavailable so callers degrade gracefully.
 */
export async function captureWorkspaceDiff(exec: ExecFn | undefined): Promise<string | undefined> {
  if (exec === undefined) return undefined;
  const r = await exec(
    "git --no-pager diff 2>/dev/null; " +
      "git status --short --untracked-files=all 2>/dev/null | sed -n 's/^?? /new file: /p'",
    { timeoutMs: 30_000 },
  ).catch(() => undefined);
  const out = r?.stdout?.trim();
  if (!out) return undefined;
  return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated]` : out;
}

/** Render a diff (or a placeholder) as a fenced block for a handoff prompt. */
export function diffBlock(diff: string | undefined): string {
  return diff !== undefined
    ? `\`\`\`diff\n${diff}\n\`\`\``
    : "(no diff captured — inspect the working tree directly)";
}
