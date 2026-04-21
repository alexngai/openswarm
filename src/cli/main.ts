/**
 * main.ts — CLI entry point.
 *
 * Dispatches parsed argv to the appropriate handler.
 * Wires together auth, tools, permissions, session, engine, and UI.
 */

import { parseArgv } from "./argv.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runWorkerEntry } from "./worker-entry.js";
import { detectAuth } from "../auth/status.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { SessionStore } from "../session/store.js";
import { runHeadless } from "../ui/headless.js";
// Note: ink / ink-markdown are lazy-loaded inside runPrompt only when the
// TTY path is taken. ink-markdown is CJS and requires() ink (which has
// top-level await) — pulling it in eagerly crashes non-TTY paths like
// `--version`, `--help`, `doctor`, `init`.
import type { CommonOpts } from "./argv.js";
import type { NormalizedEvent } from "../core/types.js";
import type { PermissionGate, RunConfig } from "../engine/index.js";
import { VERSION } from "../index.js";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
swarm-coder v${VERSION}

Usage:
  swarm-coder [flags] <prompt-text>
  swarm-coder prompt [flags] <prompt-text>
  swarm-coder doctor [--output-format text|json]
  swarm-coder init [<dir>]
  swarm-coder help
  swarm-coder version

Flags:
  --model <id>                   Model id or alias (e.g. sonnet, claude-sonnet-4-6)
  --resume <session-id|latest>   Resume a previous session
  --permission-mode <mode>       read-only | workspace-write | danger-full-access
                                 (default: workspace-write)
  --output-format <fmt>          text | json (default: text)
  --headless                     Force JSONL output even on a TTY
  --help, -h                     Show this message
  --version, -V                  Print version

Examples:
  swarm-coder "explain this codebase"
  swarm-coder prompt --model sonnet "refactor src/foo.ts"
  swarm-coder --resume latest "continue where we left off"
  swarm-coder --permission-mode read-only "what does this code do?"
  swarm-coder doctor
  swarm-coder init
`.trimStart();

export function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

export function printVersion(): void {
  process.stdout.write(`${VERSION}\n`);
}

// ---------------------------------------------------------------------------
// Default model
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// Event tee — inspect for errors while streaming to UI
// ---------------------------------------------------------------------------

/**
 * Wrap an AsyncIterable<NormalizedEvent> so we can track whether any `error`
 * events were emitted. Returns the wrapped iterable and a function that
 * returns true if an error was seen after iteration completes.
 */
function withErrorTracking(
  source: AsyncIterable<NormalizedEvent>,
): { events: AsyncIterable<NormalizedEvent>; hadError: () => boolean } {
  let sawError = false;

  async function* gen(): AsyncGenerator<NormalizedEvent> {
    for await (const evt of source) {
      if (evt.type === "error") {
        sawError = true;
      }
      yield evt;
    }
  }

  return {
    events: gen(),
    hadError: () => sawError,
  };
}

// ---------------------------------------------------------------------------
// runPrompt
// ---------------------------------------------------------------------------

async function runPrompt(text: string, opts: CommonOpts): Promise<number> {
  // 1. Validate auth.
  const authStatus = await detectAuth();
  if (authStatus.state === "none") {
    process.stderr.write(
      "error: no auth found.\n" +
        "  Run `claude auth login` or set ANTHROPIC_API_KEY.\n",
    );
    return 1;
  }

  // 2. Build tool dispatcher and register Tier 0 tools.
  const dispatcher = new ToolDispatcher();
  for (const tool of buildTier0Tools()) {
    dispatcher.register(tool);
  }

  // 3. Build permission engine.
  const permEngine = new PermissionEngine(opts.permissionMode);

  // 4. Build auth source.
  const auth = new AnthropicEnvAuth();

  // 5. Resolve session if --resume was specified.
  let resumeFrom: { engineId: string; data: unknown } | undefined;
  if (opts.resume !== undefined) {
    const store = new SessionStore();
    let sessionId: string | undefined;
    if (opts.resume === "latest") {
      sessionId = await store.resolveLatest(process.cwd());
      if (sessionId === undefined) {
        process.stderr.write("warning: no previous sessions found; starting fresh\n");
      }
    } else {
      sessionId = opts.resume;
    }
    if (sessionId !== undefined) {
      resumeFrom = store.buildSnapshot(sessionId);
    }
  }

  // 6. Build the engine.
  const engine = new ClaudeAgentSdkEngine();

  // 7. Build permission gate.
  const canUseTool: PermissionGate = async (toolName, input) => {
    const toolImpl = dispatcher.get(toolName);
    if (toolImpl === undefined) {
      return { allow: false, reason: `unknown tool: ${toolName}` };
    }
    return permEngine.check(toolImpl.spec, input);
  };

  // 8. Build RunConfig.
  const config: RunConfig = {
    systemPrompt: "",
    prompt: text,
    model: opts.model ?? DEFAULT_MODEL,
    auth,
    tools: Array.from(buildTier0Tools()),
    canUseTool,
    permissionMode: opts.permissionMode,
    resumeFrom,
  };

  // 9. Run engine.
  const rawEvents = engine.run(config);
  const { events, hadError } = withErrorTracking(rawEvents);

  // 10. Route to UI.
  const useHeadless = opts.headless || !process.stdout.isTTY;
  if (useHeadless) {
    await runHeadless(events);
  } else {
    // Lazy import so ink / ink-markdown are only loaded on TTY paths.
    // See note near the top-of-file imports.
    const { renderInkApp } = await import("../ui/ink/index.js");
    await renderInkApp(events, { prompt: text });
  }

  return hadError() ? 1 : 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);

  switch (parsed.kind) {
    case "help":
      printHelp();
      return 0;

    case "version":
      printVersion();
      return 0;

    case "doctor":
      return runDoctor(parsed.outputFormat);

    case "init":
      return runInit(parsed.cwd ?? process.cwd());

    case "worker":
      return runWorkerEntry();

    case "error":
      process.stderr.write(`error: ${parsed.message}\n`);
      if (parsed.showHelp) {
        process.stderr.write('\nRun `swarm-coder help` for usage.\n');
      }
      return 2;

    case "prompt":
      return runPrompt(parsed.text, parsed.opts);
  }
}
