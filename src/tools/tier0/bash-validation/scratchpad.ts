/**
 * Bash command validation — scratchpad exemption helper.
 *
 * The session scratchpad (see src/engine/scratchpad.ts) lives under the
 * system temp dir — `/var/folders/...` on macOS, `/tmp/...` on Linux — so
 * the path/mode heuristics would otherwise flag every command touching it
 * as an outside-workspace write and trigger an approval prompt. Stripping
 * scratchpad-rooted path tokens from the command before running those
 * heuristics makes the scratchpad permission-exempt without loosening the
 * checks for any other path.
 *
 * Blocking checks (hot files, destructive patterns) intentionally run on
 * the ORIGINAL command — the exemption only silences warnings.
 */

const SCRATCHPAD_ENV_VAR = "OPENSWARM_SCRATCHPAD_DIR";

/** The session scratchpad root, when one is active. */
export function scratchpadRoot(): string | undefined {
  const dir = process.env[SCRATCHPAD_ENV_VAR];
  return dir !== undefined && dir.length > 0 ? dir : undefined;
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Remove every scratchpad-rooted path token (the root plus any non-delimiter
 * tail, so subpaths are covered) from a command string. Returns the command
 * unchanged when no scratchpad is active or it isn't referenced.
 */
export function stripScratchpadPaths(command: string): string {
  const root = scratchpadRoot();
  if (root === undefined || !command.includes(root)) return command;
  const escaped = root.replace(REGEX_SPECIALS, "\\$&");
  return command.replace(new RegExp(`${escaped}[^\\s'"\`;|&<>)]*`, "g"), "");
}
