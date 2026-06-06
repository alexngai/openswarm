/**
 * main.ts — CLI entry point.
 *
 * Dispatches parsed argv to the appropriate handler.
 * Wires together auth, tools, permissions, session, engine, and UI.
 *
 * The single-agent runtime assembly (auth, hooks, dispatcher, tools, permission
 * engine, engine selection) lives in ./runtime.ts so the ACP adapter can reuse
 * it; the permission gate body lives in ../permissions/gate.ts for the same
 * reason. runPrompt is the CLI-specific glue: session resolution + UI routing.
 */

import * as crypto from "node:crypto";
import { parseArgv } from "./argv.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { runWorkerEntry } from "./worker-entry.js";
import { runTeamDaemonEntry } from "./team-daemon-entry.js";
import { runTeamLogs } from "./team-logs.js";
import { runTeamWatch } from "./team-watch.js";
import { runSwarm } from "./swarm.js";
import {
  runTeamStart,
  runTopology,
  runTeamSend,
  runTeamList,
  runTeamStop,
  runTeamKill,
} from "./team.js";
import { pluginMain } from "./plugin.js";
import { logoutMain } from "./logout.js";
import { loginMain } from "./login.js";
import { runAcp } from "./acp.js";
import { buildAgentRuntime } from "./runtime.js";
import { makeCanUseTool } from "../permissions/gate.js";
import { PermissionBridge } from "../permissions/bridge.js";
import { SessionStore } from "../session/store.js";
import { runHeadless } from "../ui/headless.js";
import { checkBudget } from "../core/budget.js";
// Note: the OpenTUI/Solid REPL (`src/ui/repl-solid/`) is lazy-loaded inside
// runPrompt only when the TTY path is taken, so its deps don't get pulled into
// non-TTY paths like `--version`, `--help`, `doctor`, `init`.
import type { CommonOpts } from "./argv.js";
import type { NormalizedEvent } from "../core/types.js";
import type { RunConfig } from "../engine/index.js";
import { buildSystemPrompt } from "../engine/default-system-prompt.js";
import { VERSION } from "../index.js";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
swarm-harness v${VERSION}

Usage:
  swarm-harness [flags] <prompt-text>
  swarm-harness prompt [flags] <prompt-text>
  swarm-harness doctor [--output-format text|json]
  swarm-harness init [<dir>]
  swarm-harness swarm run <tasks-file> [--concurrency N] [--output <path>]
  swarm-harness acp                              Serve over the Agent Client Protocol (stdio)
  swarm-harness help
  swarm-harness version

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
  swarm-harness "explain this codebase"
  swarm-harness prompt --model sonnet "refactor src/foo.ts"
  swarm-harness --resume latest "continue where we left off"
  swarm-harness --permission-mode read-only "what does this code do?"
  swarm-harness doctor
  swarm-harness init
  swarm-harness swarm run tasks.jsonl --concurrency 5 --output out.jsonl
`.trimStart();

export function printHelp(): void {
  process.stdout.write(HELP_TEXT);
}

export function printVersion(): void {
  process.stdout.write(`${VERSION}\n`);
}

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
  // 1–6. Shared runtime assembly (auth, hooks, tools, permission engine,
  // engine plan). Short-circuits for auth failure (1), --dump-tools (0), and
  // engine/framework mismatch (2).
  const built = await buildAgentRuntime(opts);
  if (built.kind === "exit") return built.code;
  const rt = built.runtime;

  // 7. Resolve session if --resume was specified. Session identity is
  // CLI-specific (ACP supplies its own per `session/new`), so it stays here.
  // `sessionId` is forwarded to NativeEngine so the OpenAI transport can pass
  // it as `prompt_cache_key`. Resumed sessions inherit the previous id; new
  // sessions get a fresh UUID.
  let resumeFrom: { engineId: string; data: unknown } | undefined;
  let sessionId: string | undefined;
  if (opts.resume !== undefined) {
    const store = new SessionStore();
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
  if (sessionId === undefined) {
    sessionId = crypto.randomUUID();
  }

  // 8. Construct the engine for this session.
  const { engine, providerId } = await rt.makeEngine(sessionId);

  // --dump-engine: print engine info as JSON and exit 0 (smoke tests only).
  if (opts.dumpEngine) {
    process.stdout.write(
      JSON.stringify({
        engineId: engine.id,
        ...(providerId !== undefined && { providerId }),
        modelId: rt.resolvedModelId,
      }) + "\n",
    );
    return 0;
  }

  // 9. Build permission gate. The shared body lives in ../permissions/gate.ts.
  // `currentPermissionMode` is the live mutable binding updated by /permissions
  // across turns; the gate reads it fresh on every call.
  let currentPermissionMode = opts.permissionMode;
  const permissionBridge = new PermissionBridge();
  // Determined up-front so the gate and the UI route share one heuristic.
  const useHeadless = opts.headless || !process.stdout.isTTY;
  const canUseTool = makeCanUseTool({
    dispatcher: rt.dispatcher,
    permEngine: rt.permEngine,
    bridge: permissionBridge,
    useHeadless,
    getCurrentMode: () => currentPermissionMode,
    cwd: process.cwd(),
  });

  // 10. Build RunConfig.
  // SDK engine: empty string → falls back to the `claude_code` preset internally.
  // Native/hardened-native: use our default system prompt (Codex-parity baseline).
  const systemPrompt =
    engine.id === "native" || engine.id === "hardened-native"
      ? buildSystemPrompt({ cwd: process.cwd() })
      : "";
  const config: RunConfig = {
    systemPrompt,
    prompt: text,
    model: rt.resolvedModelId,
    auth: rt.auth,
    tools: rt.tools,
    canUseTool,
    permissionMode: opts.permissionMode,
    resumeFrom,
    hooks: rt.hooksConfig,
    ...(opts.enableWebSearch ? { enabledBuiltinTools: ["WebSearch"] } : {}),
  };

  // 11. Route to UI.

  // Budget limits derived from CLI flags (v0.2.Q7).
  const budgetLimits = {
    maxTokens: opts.maxTokens,
    maxCostUsd: opts.maxCostUsd,
  };
  const hasBudgetLimits =
    budgetLimits.maxTokens !== undefined || budgetLimits.maxCostUsd !== undefined;

  if (useHeadless) {
    // Headless path: one-shot engine run → JSONL.
    // When budget limits are set, wrap the event stream so we can abort
    // after each event and emit a budget_exceeded JSONL line before exit.
    const headlessAbort = new AbortController();
    const headlessConfig = hasBudgetLimits
      ? { ...config, abort: headlessAbort.signal }
      : config;
    const rawEvents = engine.run(headlessConfig);
    const { events, hadError } = withErrorTracking(rawEvents);

    if (hasBudgetLimits) {
      // Wrap the event stream: after each event, check budget.
      // On exceed: write budget_exceeded JSONL line, abort, then drain.
      let budgetViolation = false;
      async function* budgetWrapped(): AsyncGenerator<NormalizedEvent> {
        for await (const evt of events) {
          yield evt;
          const budgetResult = checkBudget(
            engine.getCumulativeUsage(),
            budgetLimits,
            rt.resolvedModelId,
          );
          if (budgetResult.exceeded && !budgetViolation) {
            budgetViolation = true;
            // Emit budget_exceeded as a JSONL line to stdout.
            const budgetEvent = {
              type: "budget_exceeded",
              limit: budgetResult.reason?.includes("token") ? "tokens" : "cost",
              usedTokens: budgetResult.usedTokens,
              usedCostUsd: budgetResult.usedCostUsd,
              reason: budgetResult.reason,
              modelId: rt.resolvedModelId,
            };
            process.stdout.write(JSON.stringify(budgetEvent) + "\n");
            headlessAbort.abort();
            break;
          }
        }
      }
      await runHeadless(budgetWrapped());
      if (budgetViolation) return 3;
    } else {
      await runHeadless(events);
    }
    return hadError() ? 1 : 0;
  }

  // TTY path: mount the state-machine REPL. `runRepl` owns the multi-turn
  // event loop — each user prompt triggers a fresh `engine.run(...)` with the
  // same RunConfig template (the `prompt`, `model`, and `permissionMode`
  // fields are read from locals so slash-commands can mutate them).
  // Lazy-loaded so OpenTUI deps don't get pulled into non-TTY paths.
  const { runRepl } = await import("../ui/repl-solid/index.js");
  const { clampPermissionMode } = await import("../swarm/permission-order.js");
  const parentMode = opts.permissionMode;
  let currentModel = config.model;
  // currentPermissionMode is declared above (the gate closes over it).
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
        dispatcher: rt.dispatcher,
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
      sessionLogPath: ".swarm-harness/sessions.log",
      pluginStore: rt.pluginStateStore,
    },
    permissionBridge,
    getTokens: () => {
      const u = engine.getCumulativeUsage();
      // v0.2.Q7: check budget on every token poll. When exceeded, abort the
      // current turn so the REPL can surface the error and exit.
      if (hasBudgetLimits) {
        const budgetResult = checkBudget(u, budgetLimits, rt.resolvedModelId);
        if (budgetResult.exceeded && !turnAbort.signal.aborted) {
          process.stderr.write(
            `[swarm-harness] budget exceeded: ${budgetResult.reason ?? "limit reached"} — aborting\n`,
          );
          turnAbort.abort();
        }
      }
      return u.inputTokens + u.outputTokens;
    },
  });
  // Exit code 3 if budget was exceeded (abort signal was fired by budget check).
  if (hasBudgetLimits && turnAbort.signal.aborted) return 3;
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

    case "team-daemon-entry":
      // v0.5 stage 5E.3: forked per-team daemon entry. Reads its TeamSpec +
      // socket/pid/events/state paths from SWARM_HARNESS_DAEMON_* env set by
      // the parent forker (`team start --detach`).
      return runTeamDaemonEntry();

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
        opentasks: parsed.opentasks,
        ...(parsed.opentasksSocket !== undefined && {
          opentasksSocket: parsed.opentasksSocket,
        }),
        agentInbox: parsed.agentInbox,
        gitCascade: parsed.gitCascade,
        cleanupWorktrees: parsed.cleanupWorktrees,
      });

    case "plugin":
      return pluginMain(parsed.pluginArgv);

    case "worktree": {
      const { worktreeMain } = await import("./worktree.js");
      return worktreeMain(parsed.worktreeArgv);
    }

    case "team-start":
      return runTeamStart(parsed.template, {
        permissionMode: parsed.permissionMode,
        concurrency: parsed.concurrency,
        output: parsed.output,
        ...(parsed.mapUrl !== undefined && { mapUrl: parsed.mapUrl }),
        detach: parsed.detach,
      });

    case "topology":
      return runTopology({
        topologyKind: parsed.topologyKind,
        specPath: parsed.specPath,
        permissionMode: parsed.permissionMode,
        concurrency: parsed.concurrency,
        output: parsed.output,
        ...(parsed.mapUrl !== undefined && { mapUrl: parsed.mapUrl }),
        ...(parsed.maxTokens !== undefined && { maxTokens: parsed.maxTokens }),
        ...(parsed.maxCostUsd !== undefined && { maxCostUsd: parsed.maxCostUsd }),
      });

    case "team-logs":
      return runTeamLogs(parsed.name, { follow: parsed.follow });

    case "team-watch":
      return runTeamWatch(parsed.name);

    case "team-send":
      return runTeamSend(parsed.name, parsed.prompt);

    case "team-list":
      return runTeamList();

    case "team-stop":
      return runTeamStop(parsed.name);

    case "team-kill":
      return runTeamKill(parsed.name);

    case "login":
      return loginMain(["--provider", parsed.provider]);

    case "logout":
      return logoutMain(["--provider", parsed.provider]);

    case "acp":
      return runAcp(parsed.opts);

    case "error":
      process.stderr.write(`error: ${parsed.message}\n`);
      if (parsed.showHelp) {
        process.stderr.write('\nRun `swarm-harness help` for usage.\n');
      }
      return 2;

    case "prompt":
      return runPrompt(parsed.text, parsed.opts);
  }
}
