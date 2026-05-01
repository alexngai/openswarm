/**
 * Bash command validation — sed in-place validation submodule.
 *
 * Detects `sed -i` or `sed --in-place` without an explicit backup-extension
 * argument, which silently modifies files in-place.
 *
 * Corresponds to claw's `validate_sed` (bash_validation.rs:336-350).
 */

import type { ValidationResult } from "./types.js";

const SUBMODULE = "sed";

/**
 * Detect whether `sed -i` is used without a backup extension.
 *
 * `sed -i.bak` (GNU) and `sed -i ''` (BSD) both provide a backup; bare
 * `sed -i` on GNU overwrites silently. We warn in either case because the
 * semantics differ between platforms and the intent is potentially lossy.
 *
 * Returns `{kind: "warn"}` if the pattern is detected.
 * Submodule label: "sed".
 */
export function validateSed(command: string): ValidationResult {
  // Only applies to sed invocations.
  const first = command.trimStart().split(/\s+/)[0] ?? "";
  if (first !== "sed") return { kind: "allow" };

  // Detect -i / --in-place with no immediately-attached extension.
  // Examples that warn:
  //   sed -i 's/a/b/' file
  //   sed --in-place 's/a/b/' file
  //   sed -i -e 's/a/b/' file
  // Examples that allow:
  //   sed -i.bak 's/a/b/' file
  //   sed -i '' 's/a/b/' file   (BSD empty-string backup)
  const hasInPlace = / --in-place/.test(command) || / -i(?!\S)/.test(command);
  if (!hasInPlace) return { kind: "allow" };

  // Allow if an extension is directly attached: -i.bak, -i~, etc.
  // Pattern: -i followed immediately by a non-space, non-quote character.
  if (/ -i[^\s'"]/.test(command)) return { kind: "allow" };

  return {
    kind: "warn",
    message:
      "sed -i modifies files in-place without a backup — verify the target file and expression are correct",
    submodule: SUBMODULE,
  };
}
