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
  runTeamStatus,
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
import { SessionAllowRules } from "../permissions/session-rules.js";
import { readHeadlessApproval } from "../permissions/headless-prompt.js";
import {
  requestPermissionsTool,
  setPermissionRequestHandler,
  clearPermissionRequestHandler,
} from "../tools/tier0/request_permissions.js";
import { clampPermissionMode, permissionRank } from "../swarm/permission-order.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { subscribeSwarmViewEvents } from "../swarm/swarm-view-events.js";
import { tailDaemonSwarmView } from "../swarm/daemon-swarm-view.js";
import {
  startSessionRecorder,
  type SessionRecorder,
} from "../swarm/session-recorder.js";
import { normalizedEventToLaneType } from "../swarm/events.js";
import { computeTeamPaths } from "./team-paths.js";
import { combineSwarmSources, type SwarmEventSource } from "../ui/repl-solid/merge-swarm-events.js";
import type { PendingPermission } from "../ui/repl/state.js";
import { SessionStore } from "../session/store.js";
import { runHeadless } from "../ui/headless.js";
import { checkBudget } from "../core/budget.js";
// Note: the OpenTUI/Solid REPL (`src/ui/repl-solid/`) is lazy-loaded inside
// runPrompt only when the TTY path is taken, so its deps don't get pulled into
// non-TTY paths like `--version`, `--help`, `doctor`, `init`.
import type { CommonOpts } from "./argv.js";
import type { NormalizedEvent, AgentId } from "../core/types.js";
import type { RunConfig } from "../engine/index.js";
import { buildSystemPrompt, applyPlanMode } from "../engine/default-system-prompt.js";
import {
  loadProjectInstructions,
  formatInstructionsForSystemPrompt,
} from "../engine/project-instructions.js";
import {
  enrichTurnInputs,
  observeTurnEvents,
  endMemorySession,
  type TurnRecord,
} from "../memory/index.js";
import type { AgentEngine } from "../engine/index.js";
import { VERSION } from "../index.js";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `
openswarm v${VERSION}

Usage:
  openswarm [flags] <prompt-text>
  openswarm prompt [flags] <prompt-text>
  openswarm doctor [--output-format text|json]
  openswarm init [<dir>]
  openswarm swarm run <tasks-file> [--concurrency N] [--output <path>]
  openswarm acp                                  Serve over the Agent Client Protocol (stdio)
  openswarm host --port N [--host H]             Run as an OpenHive-hosted swarm (binds N, N+1, N+2)
                  [--map-server ws://hub]        ...or dial a configured OpenHive hub (outbound MAP + ACP)
  openswarm help
  openswarm version

Flags:
  --model <id>                   Model id or alias (e.g. sonnet, claude-sonnet-4-6)
  --resume <session-id|latest>   Resume a previous session
  --permission-mode <mode>       read-only | workspace-write | danger-full-access
                                 (default: workspace-write)
  --plan                         Read-only plan mode: investigate + design, no edits
                                 (forces read-only; toggle live with /plan)
  --output-format <fmt>          text | json (default: text)
  --headless                     Force JSONL output even on a TTY
  --no-plugins                   Disable plugin discovery at startup
  --no-skills                    Disable skill discovery at startup
  --no-mcp                       Disable MCP server discovery at startup
  --no-hooks                     Disable hook config discovery at startup
  --help, -h                     Show this message
  --version, -V                  Print version

Budget flags (single-agent; on exceed the run stops cleanly, exit 3):
  --max-tokens <n>               Token budget for the run
  --max-cost-usd <n>             Cost budget in USD (known models only)
  --max-turns <n>                Cap on model round-trips (no cap by default)
  --max-wall-clock <dur>         Wall-clock budget, e.g. 90s, 5m, 1h

swarm run flags:
  --concurrency N                Max parallel workers (default: 3)
  --output <path>                Results JSONL file (default: ./results.jsonl)
  --role <name>                  Default role applied to every task without a per-task override
  --dead-letter <path>           Dead-letter JSONL file (default: ./dead-letter.jsonl)
  --allow-dead-letter            Do not exit non-zero when this run appends to dead-letter

Examples:
  openswarm "explain this codebase"
  openswarm prompt --model sonnet "refactor src/foo.ts"
  openswarm --resume latest "continue where we left off"
  openswarm --permission-mode read-only "what does this code do?"
  openswarm --plan "design a fix for the flaky auth test"
  openswarm doctor
  openswarm init
  openswarm swarm run tasks.jsonl --concurrency 5 --output out.jsonl
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
): { events: AsyncIterable<NormalizedEvent>; hadError: () => boolean; hadBudgetStop: () => boolean } {
  let sawError = false;
  let sawBudgetStop = false;

  async function* gen(): AsyncGenerator<NormalizedEvent> {
    for await (const evt of source) {
      if (evt.type === "error") {
        sawError = true;
        // Claude SDK reports a turn-limit stop as an error (`error_max_turns`).
        // Treat it as a budget limit (exit 3), not a crash (exit 1).
        const m = (evt.error?.message ?? "").toLowerCase();
        if (m.includes("maxturns") || m.includes("max_turns") || m.includes("max turns")) {
          sawBudgetStop = true;
        }
      } else if (evt.type === "message_stop") {
        // Native/hardened engines emit a SOFT stop for turn / wall-clock
        // budgets — a clean budget limit, so map it to exit 3.
        if (
          evt.stopReason === "max_turns" ||
          evt.stopReason === "max_wall_clock"
        ) {
          sawBudgetStop = true;
        }
      }
      yield evt;
    }
  }

  return {
    events: gen(),
    hadError: () => sawError,
    hadBudgetStop: () => sawBudgetStop,
  };
}

/**
 * F2 — record a single-agent turn's events to the session transcript
 * (events.jsonl) while passing them through unchanged. Mirrors the swarm
 * worker's recording loop: each NormalizedEvent with a lane equivalent is
 * persisted as a LaneEvent so the transcript carries the semantic spine that
 * compaction's "read the full transcript at: …" pointer refers to. A no-op
 * passthrough when recording is disabled (recorder === null).
 */
async function* recordTurnEvents(
  events: AsyncIterable<NormalizedEvent>,
  recorder: SessionRecorder | null,
): AsyncGenerator<NormalizedEvent> {
  const agentId = "root" as AgentId;
  for await (const evt of events) {
    if (recorder !== null) {
      const laneType = normalizedEventToLaneType(evt.type);
      if (laneType !== undefined) {
        recorder.record({
          ts: Date.now(),
          agentId,
          type: laneType,
          payload: evt,
        });
      }
    }
    yield evt;
  }
}

// ---------------------------------------------------------------------------
// Session-end memory summary (Phase 3 B2, decision Q4)
// ---------------------------------------------------------------------------

/**
 * When OPENSWARM_MEMORY_SUMMARIZER=subagent, session-end archiving runs a
 * one-shot, tool-less subagent turn to produce the session summary instead of
 * the static final-text truncation. Returns undefined when not configured;
 * endMemorySession falls back to the static summary if the subagent fails.
 */
function buildSubagentSummarizer(
  engine: AgentEngine,
  base: RunConfig,
): ((turns: readonly TurnRecord[]) => Promise<string>) | undefined {
  if (process.env.OPENSWARM_MEMORY_SUMMARIZER !== "subagent") return undefined;
  return async (turns) => {
    const transcript = turns
      .map(
        (t) =>
          `Turn ${t.turnIndex + 1}${
            t.toolsUsed.length > 0 ? ` (tools: ${t.toolsUsed.join(", ")})` : ""
          }:\n${t.summary || "(no text)"}`,
      )
      .join("\n\n");
    let text = "";
    for await (const evt of engine.run({
      ...base,
      systemPrompt:
        "You summarize coding sessions for long-term memory. Reply with 3-6 " +
        "terse bullet points capturing what was done, key decisions, and " +
        "anything a future session should know. No preamble.",
      prompt: `Summarize this session:\n\n${transcript}`,
      tools: [],
      canUseTool: async () => ({ allow: false, reason: "summarizer has no tools" }),
      maxTurns: 1,
    })) {
      if (evt.type === "text_delta") text += evt.text;
    }
    return text.trim();
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
  // Plan mode narrows the effective starting mode to read-only while keeping
  // opts.permissionMode as the ceiling (so `/plan off` can restore write).
  let currentPermissionMode = opts.plan ? "read-only" : opts.permissionMode;
  // Live plan-mode flag (toggled by `/plan`); drives the plan-persona prompt.
  let currentPlanMode = opts.plan;
  const permissionBridge = new PermissionBridge();
  // Determined up-front so the gate and the UI route share one heuristic.
  // The interactive TUI needs bun (OpenTUI's bun:ffi). When running under plain
  // node (e.g. the launcher's node-bundle fallback on a platform without the
  // compiled binary), degrade the TUI to headless instead of crashing.
  const tuiUnavailable = !process.versions.bun;
  if (!opts.headless && process.stdout.isTTY && tuiUnavailable) {
    process.stderr.write(
      "[openswarm] interactive TUI requires the compiled binary (bun runtime); " +
        "falling back to headless output. Install the platform binary or pass --headless to silence this.\n",
    );
  }
  const useHeadless = opts.headless || !process.stdout.isTTY || tuiUnavailable;
  // Session-scoped bash "always allow" rules (Phase 3 B4): lives for this
  // runPrompt invocation, never persisted to disk.
  const sessionRules = new SessionAllowRules();
  const canUseTool = makeCanUseTool({
    dispatcher: rt.dispatcher,
    permEngine: rt.permEngine,
    bridge: permissionBridge,
    useHeadless,
    getCurrentMode: () => currentPermissionMode,
    cwd: process.cwd(),
    sessionRules,
  });

  // 9a. Phase 4.1e — wire the request_permissions escalation seam for the
  // single-agent REPL + headless paths, then register the tool so the model
  // can actually reach it. `parentMode` (the CLI ceiling) bounds elevation;
  // approval routes through the same prompt surface as any other permission
  // decision (bridge on a TTY, stdin when headless). Granting mutates the
  // live `currentPermissionMode`, which the gate reads on every call.
  const parentMode = opts.permissionMode;
  setPermissionRequestHandler({
    getCurrentMode: () => currentPermissionMode,
    requestElevation: async (requestedMode, reason) => {
      const target = clampPermissionMode(requestedMode, parentMode);
      // Ceiling blocks it (or it wouldn't raise the mode) — deny without a prompt.
      if (permissionRank(target) <= permissionRank(currentPermissionMode)) {
        return { granted: false, newMode: currentPermissionMode };
      }
      const pending: PendingPermission = {
        toolName: "request_permissions",
        input: { mode: requestedMode, reason },
        currentMode: currentPermissionMode,
        requiredPermission: "none",
        reason,
      };
      const decision = useHeadless
        ? await readHeadlessApproval(pending)
        : await permissionBridge.request(pending);
      if (!decision.allow) {
        return { granted: false, newMode: currentPermissionMode };
      }
      currentPermissionMode = target;
      return { granted: true, newMode: currentPermissionMode };
    },
  });
  // Register the tool on the dispatcher + advertise it to the engine now that
  // the handler is live. Kept out of buildTier0Tools() (which the ACP/worker
  // paths share) precisely so it's only offered where the seam is wired.
  rt.dispatcher.register(requestPermissionsTool);
  const engineTools = [...rt.tools, requestPermissionsTool];

  // 10. Build RunConfig.
  // SDK engine: empty string → falls back to the `claude_code` preset internally.
  // Native/hardened-native: use our default system prompt (Codex-parity baseline).
  // Native/hardened engines don't get CLAUDE.md/AGENTS.md from an SDK preset,
  // so load the project instruction files (ancestor walk) and fold them into
  // the system prompt. The same files are re-injected after compaction via the
  // engine's recontextualize() hook (F1).
  const systemPrompt =
    engine.id === "native" || engine.id === "hardened-native"
      ? buildSystemPrompt({
          cwd: process.cwd(),
          extensions: formatInstructionsForSystemPrompt(
            loadProjectInstructions(process.cwd()),
          ),
        })
      : "";
  const config: RunConfig = {
    systemPrompt,
    prompt: text,
    model: rt.resolvedModelId,
    auth: rt.auth,
    tools: engineTools,
    // Without this the native/hardened engines can offer tools but cannot
    // execute them (batch dispatch no-ops → every tool returns "tool failed").
    dispatcher: rt.dispatcher,
    canUseTool,
    permissionMode: currentPermissionMode,
    resumeFrom,
    hooks: rt.hooksConfig,
    ...(opts.enableWebSearch ? { enabledBuiltinTools: ["WebSearch"] } : {}),
    // Step budget (model round-trips) — the engine turn loop self-enforces this
    // (soft `stopReason: "max_turns"` on exhaust). No default cap when omitted.
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    // Wall-clock budget — engine emits soft `stopReason: "max_wall_clock"`.
    ...(opts.maxWallClockMs !== undefined
      ? { maxWallClockMs: opts.maxWallClockMs }
      : {}),
  };

  // 11. Route to UI.

  // Budget limits derived from CLI flags (v0.2.Q7).
  const budgetLimits = {
    maxTokens: opts.maxTokens,
    maxCostUsd: opts.maxCostUsd,
  };
  const hasBudgetLimits =
    budgetLimits.maxTokens !== undefined || budgetLimits.maxCostUsd !== undefined;

  // Phase 3 B1/B2 — memory lifecycle. Each turn's event stream is wrapped by
  // the observer (tools + final text + onAfterTurn + onCompaction); the
  // collected TurnRecords feed the session-end archive.
  const memoryTurns: TurnRecord[] = [];
  const recordTurn = (record: TurnRecord): void => {
    memoryTurns.push(record);
  };
  const memorySummarizer = buildSubagentSummarizer(engine, config);
  const finishMemorySession = async (): Promise<void> => {
    // Phase 4.1e — drop the module-level escalation handler so it can't leak
    // into a subsequent run (e.g. tests, or a later ACP session in-process).
    clearPermissionRequestHandler();
    await endMemorySession({
      sessionId,
      turns: memoryTurns,
      ...(memorySummarizer !== undefined && { summarize: memorySummarizer }),
    });
    // F2 — flush the single-agent transcript (best-effort).
    await sessionRecorder?.close();
  };

  // F2 — single-agent session transcript. When recording is enabled
  // (OPENSWARM_RECORD_SESSIONS=1 or OPENSWARM_SESSION_DIR), emit an
  // events.jsonl for this REPL/headless session and point the engine's
  // compaction continuation at it (the "read the full transcript at: …"
  // pointer). One recorder spans the whole process (REPL is multi-turn).
  const sessionRecorder = await startSessionRecorder({
    sessionId,
    agentId: "root",
    prompt: text ?? "",
    cwd: process.cwd(),
  });
  if (sessionRecorder !== null) {
    (
      engine as { setTranscriptPath?: (p: string) => void }
    ).setTranscriptPath?.(sessionRecorder.transcriptPath);
  }
  const recordEvents = (
    events: AsyncIterable<NormalizedEvent>,
  ): AsyncGenerator<NormalizedEvent> =>
    recordTurnEvents(events, sessionRecorder);

  if (useHeadless) {
    // Headless path: one-shot engine run → JSONL.
    // Surface memory (minimem + skills) into the orchestrator's one-shot run.
    const enriched = await enrichTurnInputs(config.systemPrompt, config.prompt, {
      query: text,
    });
    const planned = applyPlanMode(enriched.systemPrompt, enriched.prompt, currentPlanMode);
    const enrichedConfig: RunConfig = {
      ...config,
      systemPrompt: planned.systemPrompt,
      prompt: planned.prompt,
    };
    // When budget limits are set, wrap the event stream so we can abort
    // after each event and emit a budget_exceeded JSONL line before exit.
    const headlessAbort = new AbortController();
    const headlessConfig = hasBudgetLimits
      ? { ...enrichedConfig, abort: headlessAbort.signal }
      : enrichedConfig;
    const rawEvents = recordEvents(
      observeTurnEvents(engine.run(headlessConfig), {
        sessionId,
        turnIndex: 0,
        onRecord: recordTurn,
      }),
    );
    const { events, hadError, hadBudgetStop } = withErrorTracking(rawEvents);

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
      if (budgetViolation) {
        await finishMemorySession();
        return 3;
      }
    } else {
      await runHeadless(events);
    }
    // Phase 3 B1/B2 — archive the session (provider fan-out) before exit.
    await finishMemorySession();
    // A turn / wall-clock budget stop is a clean budget limit (like
    // --max-tokens' exit 3), not a generic error — so callers/eval classifiers
    // can tell "hit a budget" (solvable at a higher budget) apart from a real
    // crash (exit 1).
    if (hadBudgetStop()) return 3;
    return hadError() ? 1 : 0;
  }

  // TTY path: mount the state-machine REPL. `runRepl` owns the multi-turn
  // event loop — each user prompt triggers a fresh `engine.run(...)` with the
  // same RunConfig template (the `prompt`, `model`, and `permissionMode`
  // fields are read from locals so slash-commands can mutate them).
  // Lazy-loaded so OpenTUI deps don't get pulled into non-TTY paths.
  const { runRepl } = await import("../ui/repl-solid/index.js");
  // clampPermissionMode + parentMode are defined at step 9a (handler wiring).
  let currentModel = config.model;
  // currentPermissionMode is declared above (the gate closes over it).
  // resumeFrom for the next turn (set by /resume, cleared after one use).
  let pendingResumeFrom: { engineId: string; data: unknown } | undefined = resumeFrom;
  const turnAbort = new AbortController();
  // GitHub #15 — give the interactive REPL a live SwarmHost so the `agent`
  // Tier 2 tool can spawn members, and project member lifecycle into the
  // AgentTree (Ctrl+A) / TaskBoard (Ctrl+T) views. `parentMode` is the CLI
  // permission ceiling; the host clamps every spawned child against it. The
  // host is threaded into each turn's RunConfig (native/hardened engines read
  // `RunConfig.host` to inject `ctx.host`).
  const replSwarmHost = new StandaloneHost({ permissionMode: parentMode });
  const liveSwarmSource: SwarmEventSource = {
    subscribe: (sink: (evt: NormalizedEvent) => void) =>
      subscribeSwarmViewEvents(replSwarmHost, sink),
  };
  // GitHub #23 — when attaching to a detached daemon team, tail its
  // events.jsonl and project it into the same AgentTree/TaskBoard, combined
  // with the local live host so in-session `agent` spawns still render too.
  let swarmEventSource: SwarmEventSource = liveSwarmSource;
  if (opts.attachTeam !== undefined) {
    const eventsPath = computeTeamPaths(opts.attachTeam).eventsPath;
    const daemonSource: SwarmEventSource = {
      subscribe: (sink: (evt: NormalizedEvent) => void) =>
        tailDaemonSwarmView(eventsPath, sink),
    };
    swarmEventSource = combineSwarmSources(liveSwarmSource, daemonSource);
    process.stderr.write(
      `attached to team "${opts.attachTeam}" — live swarm view (Ctrl+A / Ctrl+T); ${eventsPath}\n`,
    );
  }
  await runRepl({
    engine,
    swarmEvents: swarmEventSource,
    buildRunConfig: async (prompt) => {
      const rf = pendingResumeFrom;
      // Resume applies once — clear after consuming.
      pendingResumeFrom = undefined;
      // Surface memory (minimem + skills) into this REPL turn.
      const enriched = await enrichTurnInputs(config.systemPrompt, prompt, {
        query: prompt,
      });
      const planned = applyPlanMode(enriched.systemPrompt, enriched.prompt, currentPlanMode);
      return {
        ...config,
        systemPrompt: planned.systemPrompt,
        prompt: planned.prompt,
        model: currentModel,
        permissionMode: currentPermissionMode,
        abort: turnAbort.signal,
        dispatcher: rt.dispatcher,
        resumeFrom: rf,
        // GitHub #15 — scoped to the interactive path (not the shared headless
        // config) so the `agent`/`task_*` Tier 2 tools resolve a host here.
        host: replSwarmHost,
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
      getPlanMode: () => currentPlanMode,
      setPlanMode: (on) => {
        currentPlanMode = on;
        // Plan on → read-only; plan off → restore the parent ceiling.
        currentPermissionMode = on
          ? clampPermissionMode("read-only", parentMode)
          : parentMode;
      },
      getUsage: () => engine.getCumulativeUsage(),
      abort: turnAbort,
      sessionLogPath: ".openswarm/sessions.log",
      pluginStore: rt.pluginStateStore,
      // Real /compact control for native/hardened engines (queued, runs at
      // the next turn boundary). SDK engine has no method → hint fallback.
      requestCompaction: (customInstructions?: string) => {
        const target = engine as {
          requestManualCompaction?: (instr?: string) => void;
        };
        if (typeof target.requestManualCompaction !== "function") return false;
        target.requestManualCompaction(customInstructions);
        return true;
      },
    },
    permissionBridge,
    // Phase 3 B1 — memory observer around each REPL turn (onAfterTurn +
    // onCompaction fire inside; records feed the session-end archive).
    wrapTurnEvents: (turn, turnIndex) =>
      recordEvents(
        observeTurnEvents(turn, { sessionId, turnIndex, onRecord: recordTurn }),
      ),
    getTokens: () => {
      const u = engine.getCumulativeUsage();
      // v0.2.Q7: check budget on every token poll. When exceeded, abort the
      // current turn so the REPL can surface the error and exit.
      if (hasBudgetLimits) {
        const budgetResult = checkBudget(u, budgetLimits, rt.resolvedModelId);
        if (budgetResult.exceeded && !turnAbort.signal.aborted) {
          process.stderr.write(
            `[openswarm] budget exceeded: ${budgetResult.reason ?? "limit reached"} — aborting\n`,
          );
          turnAbort.abort();
        }
      }
      return u.inputTokens + u.outputTokens;
    },
  });
  // Phase 3 B1/B2 — REPL exited; archive the session (provider fan-out).
  await finishMemorySession();
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
      // socket/pid/events/state paths from OPENSWARM_DAEMON_* env set by
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
        ...(parsed.model !== undefined ? { modelId: parsed.model } : {}),
        ...(parsed.traceOutput !== undefined ? { traceOutput: parsed.traceOutput } : {}),
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
        opentasks: parsed.opentasks,
        ...(parsed.opentasksSocket !== undefined && {
          opentasksSocket: parsed.opentasksSocket,
        }),
        agentInbox: parsed.agentInbox,
        gitCascade: parsed.gitCascade,
        cleanupWorktrees: parsed.cleanupWorktrees,
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
        ...(parsed.model !== undefined && { modelId: parsed.model }),
        ...(parsed.traceOutput !== undefined && { traceOutput: parsed.traceOutput }),
        opentasks: parsed.opentasks,
        ...(parsed.opentasksSocket !== undefined && {
          opentasksSocket: parsed.opentasksSocket,
        }),
        agentInbox: parsed.agentInbox,
        gitCascade: parsed.gitCascade,
        cleanupWorktrees: parsed.cleanupWorktrees,
      });

    case "team-logs":
      return runTeamLogs(parsed.name, { follow: parsed.follow });

    case "team-watch":
      return runTeamWatch(parsed.name, { plain: parsed.plain });

    case "team-send":
      return runTeamSend(parsed.name, parsed.prompt);

    case "team-list":
      return runTeamList();

    case "team-status":
      return runTeamStatus(parsed.name);

    case "team-stop":
      return runTeamStop(parsed.name);

    case "team-kill":
      return runTeamKill(parsed.name);

    case "login":
      return loginMain([
        "--provider",
        parsed.provider,
        ...(parsed.device ? ["--device"] : []),
      ]);

    case "logout":
      return logoutMain(["--provider", parsed.provider]);

    case "acp":
      return runAcp(parsed.opts);

    case "host": {
      const { runHost } = await import("./host.js");
      return runHost({
        port: parsed.port,
        ...(parsed.host !== undefined && { host: parsed.host }),
        ...(parsed.adapter !== undefined && { adapter: parsed.adapter }),
        ...(parsed.mapServer !== undefined && { mapServer: parsed.mapServer }),
        ...(parsed.mapScope !== undefined && { mapScope: parsed.mapScope }),
        ...(parsed.onboardToken !== undefined && { onboardToken: parsed.onboardToken }),
        ...(parsed.model !== undefined && { model: parsed.model }),
        permissionMode: parsed.permissionMode,
      });
    }

    case "error":
      process.stderr.write(`error: ${parsed.message}\n`);
      if (parsed.showHelp) {
        process.stderr.write('\nRun `openswarm help` for usage.\n');
      }
      return 2;

    case "prompt":
      return runPrompt(parsed.text, parsed.opts);
  }
}
