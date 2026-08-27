/**
 * acp.ts — thin CLI shim for the `acp` subcommand.
 *
 * Lazily imports the ACP module so the SDK + its transport are not pulled into
 * the hot CLI path (mirrors how `worktree` is lazy-loaded in main.ts).
 */

import type { CommonOpts } from "./argv.js";

export async function runAcp(opts: CommonOpts): Promise<number> {
  const { runAcp: run } = await import("../acp/index.js");
  return run(opts);
}
