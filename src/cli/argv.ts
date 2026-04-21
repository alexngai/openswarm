/**
 * argv.ts — hand-rolled CLI argument parser for swarm-coder.
 *
 * Parses process.argv.slice(2). No external dependencies.
 *
 * Subcommands: prompt, doctor, init, help, version, swarm
 * Bare positional (not a flag, not a known subcommand) → treated as prompt text.
 *
 * Flags:
 *   --model <str>
 *   --resume <session-id | "latest">
 *   --permission-mode <read-only | workspace-write | danger-full-access>
 *   --output-format <text | json>
 *   --headless
 *   --help / -h
 *   --version / -V
 *
 * swarm subcommand:
 *   swarm run <tasks-file> [--concurrency N] [--output <path>] [--permission-mode <mode>]
 */

import type { PermissionMode } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CommonOpts {
  model?: string;
  resume?: string;
  permissionMode: PermissionMode;
  outputFormat: "text" | "json";
  headless: boolean;
  /** When false, plugin discovery is disabled at startup. Default: true. */
  plugins: boolean;
  /** When false, skill discovery is disabled at startup. Default: true. */
  skills: boolean;
  /** When false, MCP server discovery is disabled at startup. Default: true. */
  mcp: boolean;
  /** When false, hook config discovery is disabled at startup. Default: true. */
  hooks: boolean;
}

export type ParsedArgs =
  | { kind: "prompt"; text: string; opts: CommonOpts }
  | { kind: "doctor"; outputFormat: "text" | "json" }
  | { kind: "init"; cwd?: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "worker" }
  | {
      kind: "swarm-run";
      tasksFile: string;
      concurrency: number;
      output: string;
      permissionMode: PermissionMode;
    }
  | { kind: "error"; message: string; showHelp: boolean };

// ---------------------------------------------------------------------------
// Known subcommands
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set(["prompt", "doctor", "init", "help", "version", "swarm"]);

const VALID_PERMISSION_MODES = new Set<string>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const VALID_OUTPUT_FORMATS = new Set<string>(["text", "json"]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse argv. Pass process.argv.slice(2) — node and script path excluded.
 */
export function parseArgv(args: string[]): ParsedArgs {
  // Expand --flag=value into --flag value pairs.
  const expanded = expandEquals(args);

  let i = 0;

  // Defaults for CommonOpts.
  let model: string | undefined;
  let resume: string | undefined;
  let permissionMode: PermissionMode = "workspace-write";
  let outputFormat: "text" | "json" = "text";
  let headless = false;
  let plugins = true;
  let skills = true;
  let mcp = true;
  let hooks = true;

  // Defaults for swarm-run (consumed when subcommand === "swarm").
  let swarmConcurrency = 3;
  let swarmOutput = "./results.jsonl";

  // First pass: scan for early-exit flags (--help, -h, --version, -V) and
  // collect flags that precede the subcommand / positional.
  // We do a single-pass left-to-right parse so flags can appear anywhere.

  let subcommand: string | undefined;
  const positionals: string[] = [];

  while (i < expanded.length) {
    const tok = expanded[i]!;

    if (tok === "--help" || tok === "-h") {
      return { kind: "help" };
    }

    if (tok === "--version" || tok === "-V") {
      return { kind: "version" };
    }

    // Internal worker flags — not advertised in --help.
    if (tok === "--worker") {
      return { kind: "worker" };
    }

    if (tok === "--agent-id" || tok.startsWith("--agent-id=")) {
      // Accept and ignore — agentId is read from SWARM_CODER_AGENT_ID env var.
      // The flag exists only for process-listing clarity.
      if (tok === "--agent-id") {
        i += 2; // skip the value token too
      } else {
        i++;
      }
      continue;
    }

    if (tok === "--headless") {
      headless = true;
      i++;
      continue;
    }

    if (tok === "--no-plugins") {
      plugins = false;
      i++;
      continue;
    }

    if (tok === "--plugins") {
      plugins = true;
      i++;
      continue;
    }

    if (tok === "--no-skills") {
      skills = false;
      i++;
      continue;
    }

    if (tok === "--skills") {
      skills = true;
      i++;
      continue;
    }

    if (tok === "--no-mcp") {
      mcp = false;
      i++;
      continue;
    }

    if (tok === "--mcp") {
      mcp = true;
      i++;
      continue;
    }

    if (tok === "--no-hooks") {
      hooks = false;
      i++;
      continue;
    }

    if (tok === "--hooks") {
      hooks = true;
      i++;
      continue;
    }

    if (tok === "--model") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--model requires a value",
          showHelp: true,
        };
      }
      model = val;
      i += 2;
      continue;
    }

    if (tok === "--resume") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--resume requires a value",
          showHelp: true,
        };
      }
      resume = val;
      i += 2;
      continue;
    }

    if (tok === "--permission-mode") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--permission-mode requires a value",
          showHelp: true,
        };
      }
      if (!VALID_PERMISSION_MODES.has(val)) {
        return {
          kind: "error",
          message: `invalid --permission-mode "${val}". Valid values: read-only, workspace-write, danger-full-access`,
          showHelp: true,
        };
      }
      permissionMode = val as PermissionMode;
      i += 2;
      continue;
    }

    if (tok === "--output-format") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--output-format requires a value",
          showHelp: true,
        };
      }
      if (!VALID_OUTPUT_FORMATS.has(val)) {
        return {
          kind: "error",
          message: `invalid --output-format "${val}". Valid values: text, json`,
          showHelp: true,
        };
      }
      outputFormat = val as "text" | "json";
      i += 2;
      continue;
    }

    // Swarm-specific flags: accepted by the main loop so they don't trip the
    // unknown-flag guard. The swarm-run dispatch branch re-reads them from
    // the captured values below.
    if (tok === "--concurrency") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--concurrency requires a value",
          showHelp: true,
        };
      }
      const n = Number.parseInt(val, 10);
      if (Number.isNaN(n) || n < 1) {
        return {
          kind: "error",
          message: `--concurrency must be a positive integer, got "${val}"`,
          showHelp: true,
        };
      }
      swarmConcurrency = n;
      i += 2;
      continue;
    }

    if (tok === "--output") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--output requires a value",
          showHelp: true,
        };
      }
      swarmOutput = val;
      i += 2;
      continue;
    }

    // Unknown flag.
    if (tok.startsWith("-")) {
      return {
        kind: "error",
        message: `unknown flag: ${tok}`,
        showHelp: true,
      };
    }

    // Non-flag token — subcommand or positional.
    if (subcommand === undefined && SUBCOMMANDS.has(tok)) {
      subcommand = tok;
    } else {
      positionals.push(tok);
    }
    i++;
  }

  // ---------------------------------------------------------------------------
  // Dispatch on resolved subcommand.
  // ---------------------------------------------------------------------------

  const opts: CommonOpts = {
    model,
    resume,
    permissionMode,
    outputFormat,
    headless,
    plugins,
    skills,
    mcp,
    hooks,
  };

  switch (subcommand) {
    case "help":
      return { kind: "help" };

    case "version":
      return { kind: "version" };

    case "doctor":
      return { kind: "doctor", outputFormat };

    case "init": {
      // Optional positional after init is the cwd.
      const cwd = positionals[0];
      return { kind: "init", cwd };
    }

    case "prompt": {
      const text = positionals.join(" ").trim();
      if (text.length === 0) {
        return {
          kind: "error",
          message: 'prompt requires text, e.g. swarm-coder prompt "say hi"',
          showHelp: true,
        };
      }
      return { kind: "prompt", text, opts };
    }

    case "swarm": {
      // swarm run <tasks-file> [--concurrency N] [--output <path>]
      const subSub = positionals[0];
      if (subSub !== "run") {
        return {
          kind: "error",
          message:
            subSub === undefined
              ? 'swarm requires a sub-subcommand, e.g. swarm run <tasks-file>'
              : `unknown swarm sub-subcommand: ${subSub}`,
          showHelp: true,
        };
      }
      const tasksFile = positionals[1];
      if (tasksFile === undefined) {
        return {
          kind: "error",
          message: "swarm run requires a tasks file path",
          showHelp: true,
        };
      }
      // --concurrency / --output / --permission-mode were consumed by the
      // main flag loop into swarmConcurrency / swarmOutput / permissionMode.
      // positionals[2..] should be empty; surface anything unexpected.
      if (positionals.length > 2) {
        return {
          kind: "error",
          message: `unexpected extra positional for swarm run: ${positionals[2]}`,
          showHelp: true,
        };
      }
      const concurrency = swarmConcurrency;
      const output = swarmOutput;
      const swarmPermissionMode: PermissionMode = permissionMode;

      return {
        kind: "swarm-run",
        tasksFile,
        concurrency,
        output,
        permissionMode: swarmPermissionMode,
      };
    }

    case undefined: {
      // No subcommand — if there are positionals, treat as bare prompt.
      if (positionals.length > 0) {
        const text = positionals.join(" ").trim();
        return { kind: "prompt", text, opts };
      }
      // Nothing at all — show help.
      return { kind: "help" };
    }

    default:
      // Should never reach here since we gate on SUBCOMMANDS.has().
      return {
        kind: "error",
        message: `unknown subcommand: ${subcommand}`,
        showHelp: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Expand --flag=value tokens into ["--flag", "value"] pairs.
 * Short flags (-h, -V) are left as-is.
 */
function expandEquals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      out.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}
