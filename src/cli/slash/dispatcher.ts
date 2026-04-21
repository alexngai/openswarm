/**
 * dispatcher.ts — parse + dispatch a `/command [args...]` line.
 *
 * `dispatchSlashLine` is the single entry point the REPL uses. It:
 *   1. Parses the leading `/`, the command name, and whitespace-split args
 *   2. Validates the line is actually a slash command
 *   3. Looks up the command in the registry
 *   4. Checks state validity via the command's own `allowedInStates` if
 *      present, otherwise falls back to `slashCommandAllowedInState`
 *   5. Invokes the command's `execute` and returns its `SlashCommandResult`
 *
 * Errors are returned as `{ kind: "error", message }`; the caller renders
 * them in the transcript. The dispatcher never throws on user input.
 */

import {
  slashCommandAllowedInState,
  type ReplState,
} from "../../ui/repl/state.js";
import {
  buildSlashContext,
  type BuildDefaultRegistryDeps,
  type SlashCommandRegistry,
  type SlashCommandResult,
} from "./index.js";

/**
 * Parse a raw input line into `{ name, args }`. Returns `undefined` if the
 * line is not a slash command (no leading `/` or empty after the slash).
 */
export function parseSlashLine(
  line: string,
): { readonly name: string; readonly args: readonly string[] } | undefined {
  if (!line.startsWith("/")) return undefined;
  const stripped = line.slice(1).trim();
  if (stripped.length === 0) return undefined;
  const parts = stripped.split(/\s+/);
  const name = parts[0];
  if (name === undefined || name.length === 0) return undefined;
  return { name, args: parts.slice(1) };
}

/**
 * Dispatch a slash line. Never throws — returns a structured result.
 */
export async function dispatchSlashLine(
  line: string,
  state: ReplState,
  registry: SlashCommandRegistry,
  deps: BuildDefaultRegistryDeps = {},
): Promise<SlashCommandResult> {
  const parsed = parseSlashLine(line);
  if (parsed === undefined) {
    return {
      kind: "error",
      message: `malformed slash command: ${JSON.stringify(line)}`,
    };
  }

  const command = registry.get(parsed.name);
  if (command === undefined) {
    return { kind: "error", message: `unknown slash command: /${parsed.name}` };
  }

  // Per-command override trumps the global state table.
  const allowed =
    command.allowedInStates !== undefined
      ? command.allowedInStates.includes(state.name)
      : slashCommandAllowedInState(state, command.name);

  if (!allowed) {
    return {
      kind: "error",
      message: `/${command.name} is not allowed in state "${state.name}"`,
    };
  }

  const ctx = buildSlashContext(registry, state, parsed.args, deps);
  try {
    return await command.execute(ctx);
  } catch (err) {
    return {
      kind: "error",
      message: `/${command.name} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
