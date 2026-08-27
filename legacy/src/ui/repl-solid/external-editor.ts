/**
 * external-editor.ts — edit the prompt in $VISUAL/$EDITOR (doc 49 Phase E2).
 *
 * Ctrl+G writes the current input to a temp file, launches the user's editor
 * with the TUI suspended (so the editor owns the terminal), then reads the file
 * back. The renderer must be suspended around the blocking child process and
 * resumed afterward, or the alt-screen fights the editor.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SuspendableRenderer {
  suspend?: () => void;
  resume?: () => void;
}

export type EditResult = { readonly value: string } | { readonly error: string };

/** The configured editor command, or undefined when neither var is set. */
export function editorCommand(): string | undefined {
  const cmd = process.env.VISUAL ?? process.env.EDITOR;
  return cmd !== undefined && cmd.trim().length > 0 ? cmd : undefined;
}

/**
 * Open `initial` in the user's editor and return the edited text. Suspends the
 * renderer around the blocking editor process when it supports it. Returns an
 * `{ error }` result (never throws) so the caller can surface a system message.
 */
export function editTextInEditor(
  initial: string,
  renderer?: SuspendableRenderer,
): EditResult {
  const editor = editorCommand();
  if (editor === undefined) {
    return { error: "$VISUAL / $EDITOR not set" };
  }

  let file: string;
  try {
    const dir = mkdtempSync(join(tmpdir(), "openswarm-edit-"));
    file = join(dir, "prompt.md");
    writeFileSync(file, initial, "utf-8");
  } catch (err) {
    return { error: `could not create temp file: ${err}` };
  }

  const canSuspend =
    renderer !== undefined &&
    typeof renderer.suspend === "function" &&
    typeof renderer.resume === "function";

  try {
    if (canSuspend) renderer!.suspend!();
    const parts = editor.split(/\s+/);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), file];
    const res = spawnSync(cmd, args, { stdio: "inherit" });
    if (canSuspend) renderer!.resume!();
    if (res.error !== undefined) {
      return { error: `editor failed: ${res.error}` };
    }
    const value = readFileSync(file, "utf-8");
    return { value };
  } catch (err) {
    if (canSuspend) {
      try {
        renderer!.resume!();
      } catch {
        /* best effort */
      }
    }
    return { error: `editor failed: ${err}` };
  }
}
