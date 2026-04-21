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
import { runSwarm } from "./swarm.js";
import { detectAuth } from "../auth/status.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
import { SessionStore } from "../session/store.js";
import { runHeadless } from "../ui/headless.js";
import { PluginRegistry } from "../plugins/registry.js";
import { ClaudeCodeSource } from "../plugins/claude-code-source.js";
import { SkillRegistry } from "../skills/registry.js";
import { ClaudeCodeSource as ClaudeCodeSkillSource } from "../skills/claude-code-source.js";
import { buildTier1Tools } from "../tools/tier1/index.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpStdioClient } from "../mcp/client.js";
import { buildMcpToolImpl } from "../mcp/bridge.js";
import { loadHooksConfig, countEvents, countMatchers } from "../hooks/config.js";
import { HookRuntime } from "../hooks/runtime.js";
// Note: the ink REPL (`src/ui/repl/`) is lazy-loaded inside runPrompt only
// when the TTY path is taken. ink-markdown is CJS and requires() ink (which
// has top-level await) — pulling it in eagerly crashes non-TTY paths like
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
  swarm-coder swarm run <tasks-file> [--concurrency N] [--output <path>]
  swarm-coder help
  swarm-coder version

Flags:
  --model <id>                   Model id or alias (e.g. sonnet, claude-sonnet-4-6)
  --resume <session-id|latest>   Resume a previous session
  --permission-mode <mode>       read-only | workspace-write | danger-full-access
                                 (default: workspace-write)
  --output-format <fmt>          text | json (default: text)
  --headless                     Force JSONL output even on a TTY
  --no-plugins                   Disable plugin discovery at startup
  --no-skills                    Disable skill discovery at startup
  --no-mcp                       Disable MCP server discovery at startup
  --no-hooks                     Disable hook config discovery at startup
  --help, -h                     Show this message
  --version, -V                  Print version

swarm run flags:
  --concurrency N                Max parallel workers (default: 3)
  --output <path>                Results JSONL file (default: ./results.jsonl)
  --role <name>                  Default role applied to every task without a per-task override
  --dead-letter <path>           Dead-letter JSONL file (default: ./dead-letter.jsonl)
  --allow-dead-letter            Do not exit non-zero when this run appends to dead-letter

Examples:
  swarm-coder "explain this codebase"
  swarm-coder prompt --model sonnet "refactor src/foo.ts"
  swarm-coder --resume latest "continue where we left off"
  swarm-coder --permission-mode read-only "what does this code do?"
  swarm-coder doctor
  swarm-coder init
  swarm-coder swarm run tasks.jsonl --concurrency 5 --output out.jsonl
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
  // 1. Validate auth. In scripted-test mode (SWARM_CODER_TEST_SCRIPT set) we
  // skip the auth check — the scripted engine never calls the API.
  const scriptedMode = !!process.env.SWARM_CODER_TEST_SCRIPT;
  if (!scriptedMode) {
    const authStatus = await detectAuth();
    if (authStatus.state === "none") {
      process.stderr.write(
        "error: no auth found.\n" +
          "  Run `claude auth login` or set ANTHROPIC_API_KEY.\n",
      );
      return 1;
    }
  }

  // 2. Load hook config (before building the dispatcher so we can thread the
  //    HookRuntime into its constructor — covers Tier 2 tools per rev-2 Major M6).
  let hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>> = { config: {} };
  if (opts.hooks) {
    try {
      hooksConfig = await loadHooksConfig({ cwd: process.cwd() });
    } catch (err) {
      process.stderr.write(
        `[swarm-coder] hooks config error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const n = countMatchers(hooksConfig.config);
    if (n > 0 && hooksConfig.resolvedPath !== undefined) {
      process.stderr.write(
        `[swarm-coder] hooks loaded from ${hooksConfig.resolvedPath} (${n} matchers across ${countEvents(hooksConfig.config)} events)\n`,
      );
    }
  }
  const hookRuntime = new HookRuntime(hooksConfig.config);

  // Build tool dispatcher and register Tier 0 tools. When hooks are present
  // the dispatcher fires PreToolUse/PostToolUse for every tier (the SDK's
  // hook path covers its own tool dispatch; Tier 2 tools bypass it, so the
  // dispatcher owns uniform coverage).
  const dispatcher = new ToolDispatcher({ hooks: hookRuntime });
  for (const tool of buildTier0Tools()) {
    dispatcher.register(tool);
  }

  // 2a. Discover and register plugin tools (opt-in via --plugins, default enabled).
  const pluginTools: import("../tools/types.js").ToolImpl[] = [];
  if (opts.plugins) {
    const pluginRegistry = new PluginRegistry();
    pluginRegistry.registerSource(new ClaudeCodeSource());
    process.stderr.write("[swarm-coder] discovering plugins...\n");
    try {
      const discovered = await pluginRegistry.buildPluginTools();
      for (const tool of discovered) {
        try {
          dispatcher.register(tool);
          pluginTools.push(tool);
        } catch {
          // Name collision with higher-priority tool — skip silently (collision
          // already warned by ToolDispatcher or registry).
        }
      }
    } catch (err) {
      process.stderr.write(
        `[swarm-coder] plugin discovery error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 2b. Build skill registry and Tier 1 tools (opt-in via --skills, default enabled).
  let skillRegistry: SkillRegistry | undefined;
  const tier1Tools: import("../tools/types.js").ToolImpl[] = [];
  if (opts.skills) {
    skillRegistry = new SkillRegistry();
    skillRegistry.registerSource(new ClaudeCodeSkillSource());
  }
  for (const tool of buildTier1Tools({ skillRegistry })) {
    try {
      dispatcher.register(tool);
      tier1Tools.push(tool);
    } catch {
      // Name collision — skip silently.
    }
  }

  // 2c. Discover and register MCP tools (opt-in via --mcp, default enabled).
  // Fail-soft: a server that hangs / errors within its 10s connect budget is
  // logged to stderr and its tools are skipped.
  const mcpTools: import("../tools/types.js").ToolImpl[] = [];
  const mcpClients: McpStdioClient[] = [];
  if (opts.mcp) {
    let loaded: Awaited<ReturnType<typeof loadMcpConfig>>;
    try {
      loaded = await loadMcpConfig();
    } catch (err) {
      process.stderr.write(
        `[swarm-coder] mcp config load error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      loaded = { configs: [] };
    }
    if (loaded.resolvedPath !== undefined) {
      process.stderr.write(
        `[swarm-coder] mcp config: ${loaded.resolvedPath}\n`,
      );
    }
    if (loaded.configs.length > 0) {
      const results = await Promise.allSettled(
        loaded.configs.map(async (cfg) => {
          const client = new McpStdioClient(cfg);
          await client.connect();
          return client;
        }),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const cfg = loaded.configs[i]!;
        if (r.status === "rejected") {
          process.stderr.write(
            `[swarm-coder] mcp server '${cfg.name}' failed to connect: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`,
          );
          continue;
        }
        const client = r.value;
        mcpClients.push(client);
        try {
          const descriptors = await client.listTools();
          for (const descriptor of descriptors) {
            const toolImpl = buildMcpToolImpl(client, descriptor);
            try {
              dispatcher.register(toolImpl);
              mcpTools.push(toolImpl);
            } catch {
              // Name collision — keep first-registered copy, skip silently.
            }
          }
        } catch (err) {
          process.stderr.write(
            `[swarm-coder] mcp server '${cfg.name}' listTools failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  // Cleanup hook: best-effort close on process exit (synchronous handler —
  // cannot await; the SDK's transport sends SIGTERM via close()).
  if (mcpClients.length > 0) {
    process.on("exit", () => {
      for (const c of mcpClients) {
        // Fire-and-forget: we cannot await in a synchronous exit handler.
        void c.close().catch(() => {});
      }
    });
  }

  // 2d. --dump-tools: print registered tools as JSON and exit 0. Useful for
  // smoke scripts and integration tests verifying plugin / MCP registration.
  // Intentionally placed after all tool registrations so the dump reflects
  // the real runtime state.
  if (opts.dumpTools) {
    const dumped = dispatcher.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      requiredPermission: spec.requiredPermission,
    }));
    process.stdout.write(JSON.stringify(dumped) + "\n");
    // Close any opened MCP clients so we exit cleanly.
    for (const c of mcpClients) {
      try {
        await c.close();
      } catch {
        // swallow — best effort
      }
    }
    return 0;
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

  // 6. Build the engine. SWARM_CODER_TEST_SCRIPT toggles the scripted engine
  // for offline smoke / integration tests; no live API traffic.
  const engine = scriptedMode
    ? new ScriptedTestEngine()
    : new ClaudeAgentSdkEngine();

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
    tools: [...Array.from(buildTier0Tools()), ...tier1Tools, ...pluginTools, ...mcpTools],
    canUseTool,
    permissionMode: opts.permissionMode,
    resumeFrom,
    hooks: hooksConfig.config,
    ...(opts.enableWebSearch ? { enabledBuiltinTools: ["WebSearch"] } : {}),
  };

  // 9. Route to UI.
  const useHeadless = opts.headless || !process.stdout.isTTY;
  if (useHeadless) {
    // Headless path: one-shot engine run → JSONL.
    const rawEvents = engine.run(config);
    const { events, hadError } = withErrorTracking(rawEvents);
    await runHeadless(events);
    return hadError() ? 1 : 0;
  }

  // TTY path: mount the state-machine REPL. `runRepl` owns the multi-turn
  // event loop — each user prompt triggers a fresh `engine.run(...)` with the
  // same RunConfig template (the `prompt`, `model`, and `permissionMode`
  // fields are read from locals so slash-commands can mutate them).
  // Lazy-loaded so ink / ink-markdown don't get pulled into non-TTY paths.
  const { runRepl } = await import("../ui/repl/index.js");
  const { clampPermissionMode } = await import("../swarm/permission-order.js");
  const parentMode = opts.permissionMode;
  let currentModel = config.model;
  let currentPermissionMode = opts.permissionMode;
  // resumeFrom for the next turn (set by /resume, cleared after one use).
  let pendingResumeFrom: { engineId: string; data: unknown } | undefined = resumeFrom;
  const turnAbort = new AbortController();
  await runRepl({
    engine,
    buildRunConfig: (prompt) => {
      const rf = pendingResumeFrom;
      // Resume applies once — clear after consuming.
      pendingResumeFrom = undefined;
      return {
        ...config,
        prompt,
        model: currentModel,
        permissionMode: currentPermissionMode,
        abort: turnAbort.signal,
        dispatcher,
        resumeFrom: rf,
      };
    },
    initialPrompt: text,
    model: currentModel,
    permissionMode: currentPermissionMode,
    onSessionId: (sessionId) => {
      // /resume emits a session-id reducer event. Wire it into the next RunConfig.
      pendingResumeFrom = { engineId: engine.id, data: { sessionId } };
    },
    slashDeps: {
      getModel: () => currentModel,
      setModel: (m) => {
        currentModel = m;
      },
      getPermissionMode: () => currentPermissionMode,
      setPermissionMode: (m) => {
        currentPermissionMode = clampPermissionMode(m, parentMode);
      },
      getUsage: () => engine.getCumulativeUsage(),
      abort: turnAbort,
      sessionLogPath: ".swarm-coder/sessions.log",
    },
    getTokens: () => {
      const u = engine.getCumulativeUsage();
      return u.inputTokens + u.outputTokens;
    },
  });
  return 0;
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

    case "swarm-run":
      return runSwarm({
        tasksFile: parsed.tasksFile,
        concurrency: parsed.concurrency,
        output: parsed.output,
        permissionMode: parsed.permissionMode,
        ...(parsed.deadLetter !== undefined ? { deadLetter: parsed.deadLetter } : {}),
        ...(parsed.allowDeadLetter !== undefined
          ? { allowDeadLetter: parsed.allowDeadLetter }
          : {}),
        ...(parsed.role !== undefined ? { defaultRole: parsed.role } : {}),
      });

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
