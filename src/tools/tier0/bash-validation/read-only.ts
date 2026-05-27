/**
 * Bash command validation — read-only mode submodule.
 *
 * Blocks write-like commands when the permission mode is "read-only".
 * Corresponds to claw's `validate_read_only` (bash_validation.rs:99-160).
 */

import type { PermissionMode } from "../../../core/types.js";
import type { ValidationResult } from "./types.js";
import {
  WRITE_COMMANDS,
  STATE_MODIFYING_COMMANDS,
  WRITE_REDIRECTIONS,
  GIT_READ_ONLY_SUBCOMMANDS,
} from "./constants.js";

import { extractFirstCommand } from "./utils.js";

const SUBMODULE = "read-only";

/** Extract the command following "sudo" (skip sudo flags). */
function extractSudoInner(command: string): string {
  const parts = command.split(/\s+/);
  const sudoIdx = parts.indexOf("sudo");
  if (sudoIdx === -1) return "";
  const rest = parts.slice(sudoIdx + 1);
  const inner = rest.find((p) => !p.startsWith("-"));
  if (inner === undefined) return "";
  const offset = command.indexOf(inner);
  return command.slice(offset);
}

/** Validate git subcommands in read-only mode. */
function validateGitReadOnly(command: string): ValidationResult {
  const parts = command.split(/\s+/);
  const subcommand = parts.slice(1).find((p) => !p.startsWith("-"));
  if (subcommand === undefined) {
    // bare "git" is fine
    return { kind: "allow" };
  }
  if ((GIT_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return { kind: "allow" };
  }
  return {
    kind: "block",
    reason: `Git subcommand '${subcommand}' modifies repository state and is not allowed in read-only mode`,
    submodule: SUBMODULE,
  };
}

/**
 * Validate that a command is allowed under read-only mode.
 *
 * Returns Allow for any mode other than "read-only".
 * Submodule label: "read-only".
 */
export function validateReadOnly(
  command: string,
  mode: PermissionMode,
): ValidationResult {
  if (mode !== "read-only") {
    return { kind: "allow" };
  }

  const first = extractFirstCommand(command);

  // Check write commands.
  if ((WRITE_COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: "block",
      reason: `Command '${first}' modifies the filesystem and is not allowed in read-only mode`,
      submodule: SUBMODULE,
    };
  }

  // Check state-modifying commands.
  if ((STATE_MODIFYING_COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: "block",
      reason: `Command '${first}' modifies system state and is not allowed in read-only mode`,
      submodule: SUBMODULE,
    };
  }

  // Check for sudo wrapping write commands.
  if (first === "sudo") {
    const inner = extractSudoInner(command);
    if (inner.length > 0) {
      const innerResult = validateReadOnly(inner, mode);
      if (innerResult.kind !== "allow") return innerResult;
    }
  }

  // Check for write redirections.
  for (const redir of WRITE_REDIRECTIONS) {
    if (command.includes(redir)) {
      return {
        kind: "block",
        reason: `Command contains write redirection '${redir}' which is not allowed in read-only mode`,
        submodule: SUBMODULE,
      };
    }
  }

  // Check git subcommands.
  if (first === "git") {
    return validateGitReadOnly(command);
  }

  return { kind: "allow" };
}
