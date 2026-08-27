/**
 * Bash command validation — destructive command warning submodule.
 *
 * Always-applicable (any permission mode). Warns when a command matches known
 * destructive patterns or is inherently destructive.
 *
 * Detects destructive command patterns.
 */

import type { ValidationResult } from "./types.js";
import { DESTRUCTIVE_PATTERNS, ALWAYS_DESTRUCTIVE_COMMANDS } from "./constants.js";

import { extractFirstCommand } from "./utils.js";

const SUBMODULE = "destructive";

/**
 * Warn if a command looks destructive.
 *
 * Returns `{kind: "warn"}` for any dangerous command regardless of mode.
 * Always-warn semantics — even danger-full-access surfaces these.
 * Submodule label: "destructive".
 */
export function validateDestructive(command: string): ValidationResult {
  // Check known destructive patterns.
  for (const [pattern, warning] of DESTRUCTIVE_PATTERNS) {
    if (!destructivePatternMatches(command, pattern)) continue;
    {
      return {
        kind: "warn",
        message: `Destructive command detected: ${warning}`,
        submodule: SUBMODULE,
      };
    }
  }

  // Check always-destructive commands.
  const first = extractFirstCommand(command);
  if ((ALWAYS_DESTRUCTIVE_COMMANDS as readonly string[]).includes(first)) {
    return {
      kind: "warn",
      message: `Command '${first}' is inherently destructive and may cause data loss`,
      submodule: SUBMODULE,
    };
  }

  // Flag any remaining "rm -rf" as a warning (the specific dangerous patterns
  // above already caught rm -rf / and rm -rf ~).
  const targets = rmRfTargets(command);
  if (targets.length > 0) {
    if (targets.length > 0 && targets.every(isSafeTempSubpath)) {
      return { kind: "allow" };
    }
    return {
      kind: "warn",
      message: "Recursive forced deletion detected — verify the target path is correct",
      submodule: SUBMODULE,
    };
  }

  return { kind: "allow" };
}

function destructivePatternMatches(command: string, pattern: string): boolean {
  if (pattern === "rm -rf /") return rmRfTargets(command).some((target) => target === "/");
  if (pattern === "rm -rf ~") return rmRfTargets(command).some((target) => target === "~" || target.startsWith("~/"));
  if (pattern === "rm -rf *") return rmRfTargets(command).some((target) => target === "*");
  if (pattern === "rm -rf .") return rmRfTargets(command).some((target) => target === "." || target === "./");
  return command.includes(pattern);
}

function rmRfTargets(command: string): string[] {
  const tokens = shellishTokens(command);
  const targets: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== "rm") continue;
    let recursive = false;
    let force = false;
    const localTargets: string[] = [];
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j]!;
      if (isCommandSeparator(token)) break;
      if (token.startsWith("-") && token !== "--") {
        recursive ||= token.includes("r") || token.includes("R");
        force ||= token.includes("f");
        continue;
      }
      if (token === "--") continue;
      localTargets.push(stripOuterQuotes(token));
    }
    if (recursive && force) targets.push(...localTargets);
  }
  return targets;
}

function shellishTokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripOuterQuotes(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  return token;
}

function isCommandSeparator(token: string): boolean {
  return token === "&&" || token === "||" || token === ";" || token === "|";
}

function isSafeTempSubpath(target: string): boolean {
  return /^\/(?:tmp|var\/tmp)\/[^/.\s][\s\S]*$/.test(target);
}
