/**
 * Bash command validation — command intent classifier.
 *
 * Ports claw's `CommandIntent` enum and `classify_command` function.
 * claw source: rust/crates/runtime/src/bash_validation.rs:28-44, 529-583
 */

import {
  SEMANTIC_READ_ONLY_COMMANDS,
  ALWAYS_DESTRUCTIVE_COMMANDS,
  WRITE_COMMANDS,
  NETWORK_COMMANDS,
  PROCESS_COMMANDS,
  PACKAGE_COMMANDS,
  SYSTEM_ADMIN_COMMANDS,
  GIT_READ_ONLY_SUBCOMMANDS,
} from "./constants.js";
import { extractFirstCommand } from "./utils.js";

/**
 * Semantic classification of a bash command's intent.
 *
 * 8-variant string union matching claw's `CommandIntent` enum
 * (bash_validation.rs:28-44).
 */
export type CommandIntent =
  | "read-only"
  | "write"
  | "destructive"
  | "network"
  | "process-management"
  | "package-management"
  | "system-admin"
  | "unknown";

/**
 * Classify the git command's intent by its subcommand.
 */
function classifyGit(command: string): CommandIntent {
  const parts = command.split(/\s+/);
  // Skip "git" and any flags (e.g. "git -C /path log")
  const subcommand = parts.slice(1).find((p) => !p.startsWith("-"));
  if (subcommand !== undefined && (GIT_READ_ONLY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return "read-only";
  }
  return "write";
}

/**
 * Classify the semantic intent of a bash command.
 *
 * Corresponds to claw's `classify_command` (bash_validation.rs:529-535).
 */
export function classifyCommand(command: string): CommandIntent {
  const first = extractFirstCommand(command);

  if ((SEMANTIC_READ_ONLY_COMMANDS as readonly string[]).includes(first)) {
    // sed -i is a write, even though sed is otherwise read-only.
    if (first === "sed" && / -i/.test(command)) {
      return "write";
    }
    return "read-only";
  }

  if ((ALWAYS_DESTRUCTIVE_COMMANDS as readonly string[]).includes(first) || first === "rm") {
    return "destructive";
  }

  if ((WRITE_COMMANDS as readonly string[]).includes(first)) {
    return "write";
  }

  if ((NETWORK_COMMANDS as readonly string[]).includes(first)) {
    return "network";
  }

  if ((PROCESS_COMMANDS as readonly string[]).includes(first)) {
    return "process-management";
  }

  if ((PACKAGE_COMMANDS as readonly string[]).includes(first)) {
    return "package-management";
  }

  if ((SYSTEM_ADMIN_COMMANDS as readonly string[]).includes(first)) {
    return "system-admin";
  }

  if (first === "git") {
    return classifyGit(command);
  }

  return "unknown";
}
