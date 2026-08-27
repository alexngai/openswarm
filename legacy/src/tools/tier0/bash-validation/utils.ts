/**
 * Shared utilities for bash-validation submodules.
 */

/**
 * Parses the leading bash command from a string, skipping env-var assignments.
 *
 * Strips any leading `KEY=value` tokens (e.g. `FOO=bar cmd arg` → `cmd`) and
 * returns the first executable token. Returns an empty string when the input
 * contains only env-var assignments or is empty.
 *
 * Used by all submodules (read-only, destructive, mode, intent) to identify
 * the first executable command before checking it against allow/block lists.
 */
export function extractFirstCommand(command: string): string {
  let remaining = command.trimStart();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const eqPos = remaining.indexOf("=");
    if (eqPos === -1) break;
    const beforeEq = remaining.slice(0, eqPos);
    if (beforeEq.length > 0 && /^[A-Za-z0-9_]+$/.test(beforeEq)) {
      const afterEq = remaining.slice(eqPos + 1);
      const spaceIdx = afterEq.search(/\s/);
      if (spaceIdx === -1) return "";
      remaining = afterEq.slice(spaceIdx).trimStart();
      continue;
    }
    break;
  }
  return remaining.split(/\s+/)[0] ?? "";
}
