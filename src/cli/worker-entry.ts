import * as path from "node:path";
import type { AgentId } from "../core/types.js";
import { ParentTransport } from "../swarm/ipc/parent-transport.js";
import { WorkerHost } from "../swarm/worker-host.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { CodexFrameworkEngine } from "../engine/codex-framework.js";
import { NativeEngine } from "../engine/native.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
import { filterCodexPeerTools } from "../tools/codex-peer-tools.js";
import { resolveProvider } from "../providers/routing.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import type { AgentEngine, PermissionDecision } from "../engine/index.js";
import type { FrameworkChoice } from "./argv.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { buildTier2Tools } from "../tools/tier2/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import {
  BUILTIN_ROLES,
  RoleRegistry,
  loadCustomRoles,
} from "../swarm/roles.js";
import { normalizedEventToLaneType } from "../swarm/events.js";
import type {
  AgentResult,
  TaskPacket,
  PermissionRequest,
  PermissionDecisionResponse,
} from "../swarm/host.js";
import type { IpcRequest } from "../swarm/ipc/protocol.js";
import { RunMoreParamsSchema, IPC_ERROR_CODES } from "../swarm/ipc/protocol.js";
import type { PermissionMode, Usage } from "../core/types.js";
import type { ToolExecutionContext, ToolImpl } from "../tools/types.js";

/**
 * Combine the parent's base system prompt with the role's system-prompt
 * suffix. Role suffix APPENDS to base (role wins on conflicts because it
 * lands last — matches the plan §6.6 "last-writer-wins" guidance).
 *
 * Exported so unit tests can assert the join behavior without standing up
 * a full worker IPC process (M1 regression).
 */
export function composeSystemPrompt(
  basePrompt: string | undefined,
  roleSuffix: string | undefined,
): string {
  return [basePrompt ?? "", roleSuffix ?? ""]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Per-turn execution context built once at worker startup and reused across
 * runs in long-lived mode. The engine, dispatcher, and auth are all
 * preserved across turns so we don't rebuild them between prompts.
 */
interface TurnContext {
  readonly agentId: AgentId;
  readonly host: WorkerHost;
  readonly transport: ParentTransport;
  readonly engine: AgentEngine;
  readonly auth: AnthropicEnvAuth;
  readonly dispatcher: ToolDispatcher;
  readonly permissionMode: PermissionMode;
  readonly permissionEngine: PermissionEngine;
  readonly roleSuffix: string;
  readonly resolvedAllowedTools: readonly string[] | undefined;
  readonly parentToolUseId: string | undefined;
}

/**
 * Build a worker's `canUseTool` gate. Mode-based first; when a tool is denied
 * under the current mode AND escalation is enabled (an `escalate` callback is
 * provided — the ACP team path), the denied call is routed to the orchestrator
 * (which forwards it to the ACP client). Without `escalate`, a mode denial is
 * returned directly — identical to the prior behavior. Exported for testing.
 */
export function buildWorkerCanUseTool(deps: {
  dispatcher: ToolDispatcher;
  permissionEngine: PermissionEngine;
  permissionMode: PermissionMode;
  escalate?: (req: PermissionRequest) => Promise<PermissionDecisionResponse>;
}): (toolName: string, input: unknown) => Promise<PermissionDecision> {
  return async (toolName, input) => {
    const tool = deps.dispatcher.get(toolName);
    if (tool === undefined) {
      return { allow: false, reason: `unknown tool: ${toolName}` };
    }
    const decision = deps.permissionEngine.check(tool.spec);
    if (decision.allow || deps.escalate === undefined) {
      return decision;
    }
    const res = await deps.escalate({
      toolName,
      input,
      requiredPermission: tool.spec.requiredPermission,
      currentMode: deps.permissionMode,
    });
    return res.outcome === "allow"
      ? { allow: true }
      : { allow: false, reason: res.reason ?? "denied by operator" };
  };
}

/**
 * Run one turn against the engine and emit the resulting AgentResult.
 * Reused for the initial run AND each subsequent `run_more` in long-lived
 * mode. Lifecycle transitions are handled by the caller.
 */
async function executeTurn(
  ctx: TurnContext,
  task: TaskPacket,
): Promise<AgentResult> {
  const { agentId, transport, engine, auth, dispatcher, permissionMode,
    permissionEngine, roleSuffix, resolvedAllowedTools, parentToolUseId } = ctx;

  const startedAt = Date.now();
  let finalText = "";
  let errMsg: string | undefined;
  let usage: Usage | undefined;

  try {
    // Build the tool list the engine sees. When an allowlist is in effect,
    // only tools that survived dispatcher filtering are advertised —
    // dispatcher.list() is the source of truth.
    const allImpls: readonly ToolImpl[] = [
      ...buildTier0Tools(),
      ...buildTier2Tools(),
    ];
    const filtered = allImpls.filter((t) => dispatcher.get(t.spec.name) !== undefined);
    const allTools = filtered.map((t) => ({
      ...t,
      execute: async (input: unknown, ec: ToolExecutionContext) => {
        // Inject SwarmHost into the execution context for Tier 2 tools.
        return t.execute(input, { ...ec, host: ctx.host });
      },
    }));

    const basePrompt = process.env.SWARM_HARNESS_BASE_SYSTEM_PROMPT ?? "";
    const systemPrompt = composeSystemPrompt(basePrompt, roleSuffix);

    // Long-lived workers resume the prior turn's session so conversation
    // context carries across run_more (the engine tracks its latest session id).
    // undefined on the first turn -> a fresh conversation (docs/33 B0.5).
    const priorSessionId = engine.getSessionId?.();

    const runConfig = {
      systemPrompt,
      prompt: task.prompt,
      model: "claude-sonnet-4-6",
      auth,
      tools: allTools,
      permissionMode,
      ...(priorSessionId !== undefined && {
        resumeFrom: {
          engineId: engine.id,
          data: { sessionId: priorSessionId },
        },
      }),
      canUseTool: buildWorkerCanUseTool({
        dispatcher,
        permissionEngine,
        permissionMode,
        // Escalate denied calls to the orchestrator only when the ACP team path
        // enabled it (env flag set on the spawned worker); else deny directly.
        ...(process.env.SWARM_HARNESS_PERMISSION_ESCALATION === "1"
          ? { escalate: (req: PermissionRequest) => ctx.host.requestPermission(req) }
          : {}),
      }),
      ...(resolvedAllowedTools !== undefined && {
        allowedTools: resolvedAllowedTools,
      }),
    };

    for await (const evt of engine.run(runConfig)) {
      if (evt.type === "text_delta") {
        finalText += evt.text;
      } else if (evt.type === "error") {
        errMsg = evt.error.message;
      } else if (evt.type === "message_stop") {
        usage = evt.usage;
      }
      // Forward each engine event as a lane_event, preserving its real type so
      // events.jsonl records the semantic spine and the ACP layer can translate
      // member activity (docs/33 B0.2). Events with no lane equivalent are
      // dropped (they were never usefully consumed).
      const laneType = normalizedEventToLaneType(evt.type);
      if (laneType !== undefined) {
        await transport.notify("lane_event", {
          ts: Date.now(),
          agentId,
          type: laneType,
          payload: evt,
          ...(parentToolUseId !== undefined && { parentToolUseId }),
        });
      }
    }
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }

  const wallClockMs = Date.now() - startedAt;
  const result: AgentResult = errMsg
    ? { status: "failure", error: errMsg, wallClockMs, ...(usage && { usage }) }
    : {
        status: "success",
        output: finalText,
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        wallClockMs,
      };
  return result;
}

export async function runWorkerEntry(): Promise<number> {
  const agentId = (process.env.SWARM_HARNESS_AGENT_ID ?? "unknown") as AgentId;
  const depthStr = process.env.SWARM_HARNESS_DEPTH ?? "0";
  const depth = Number.parseInt(depthStr, 10);
  const parentToolUseId = process.env.SWARM_HARNESS_PARENT_TOOL_USE_ID;

  const heartbeatIntervalMs = process.env.SWARM_HARNESS_HEARTBEAT_MS
    ? Number.parseInt(process.env.SWARM_HARNESS_HEARTBEAT_MS, 10)
    : undefined;
  const transport = new ParentTransport({ agentId, heartbeatIntervalMs });
  const permissionMode = (process.env.SWARM_HARNESS_PERMISSION_MODE ??
    "workspace-write") as PermissionMode;
  // v0.4 stage 4M.7: WorkerHost reads team scope from env so its scopeOf()
  // can resolve the worker's own scope when the agent tool spawns a peer
  // via team: "self". Falls back to "swarm:default" when unset.
  const teamScope = process.env.SWARM_HARNESS_TEAM_SCOPE;
  const host = new WorkerHost(
    agentId,
    depth,
    permissionMode,
    transport,
    parentToolUseId,
    undefined,
    teamScope,
  );

  // v0.4 stage 4D: opt-in long-lived worker mode.
  const longLived = process.env.SWARM_HARNESS_LONG_LIVED === "1";
  const idleTimeoutRaw = process.env.SWARM_HARNESS_IDLE_TIMEOUT_MS;
  const idleTimeoutMs =
    idleTimeoutRaw !== undefined && /^\d+$/.test(idleTimeoutRaw)
      ? Number.parseInt(idleTimeoutRaw, 10)
      : 600_000;

  // Announce readiness.
  await transport.notify("worker_ready", {
    agentId,
    depth,
    pid: process.pid,
  });
  host.markReadyForPrompt();
  transport.startHeartbeat();

  // Await the run request.
  const runReq = await new Promise<IpcRequest>((resolve) => {
    transport.once("run", resolve);
  });
  const initialTask = runReq.params as TaskPacket;

  // Ack the run immediately.
  transport.respond(runReq.id, { accepted: true });
  host.markRunning(initialTask.id);

  // M3a Phase 6: role overlay + allowedTools filter.
  // `SWARM_HARNESS_ROLE` names a role; we look it up in a worker-local
  // RoleRegistry (built-ins + custom roles loaded fresh from cwd).
  // `SWARM_HARNESS_ALLOWED_TOOLS` carries an explicit JSON array that wins
  // over the role-derived list when both are present. The system prompt
  // suffix is appended to RunConfig.systemPrompt (role suffix wins on
  // conflicts per the plan).
  const roleName = process.env.SWARM_HARNESS_ROLE;
  let roleSuffix = "";
  let resolvedAllowedTools: readonly string[] | undefined;
  if (roleName !== undefined && roleName.length > 0) {
    const roleReg = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roleReg.register(r);
    try {
      const custom = await loadCustomRoles(
        path.join(process.cwd(), ".swarm-harness", "roles.json"),
      );
      for (const r of custom) roleReg.register(r);
    } catch {
      // loader is fault-tolerant — any surprise error is swallowed to
      // keep the worker alive.
    }
    const role = roleReg.get(roleName);
    if (role !== undefined) {
      roleSuffix = role.systemPromptSuffix;
      resolvedAllowedTools = role.allowedTools;
    } else {
      process.stderr.write(
        `[swarm-harness] worker: unknown role "${roleName}" — proceeding without role overlay\n`,
      );
    }
  }
  const envAllowed = process.env.SWARM_HARNESS_ALLOWED_TOOLS;
  if (envAllowed !== undefined && envAllowed.length > 0) {
    try {
      const parsed = JSON.parse(envAllowed);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        resolvedAllowedTools = parsed as readonly string[];
      }
    } catch {
      // keep role-derived list if env is malformed
    }
  }

  // Build tools + permission engine. When a role allowlist is in effect,
  // the dispatcher filters tools at registration — the model never sees
  // tools outside the list.
  const dispatcher = new ToolDispatcher(
    resolvedAllowedTools !== undefined
      ? { allowedTools: resolvedAllowedTools }
      : {},
  );
  for (const tool of [...buildTier0Tools(), ...buildTier2Tools()]) {
    dispatcher.register(tool);
  }
  const permissionEngine = new PermissionEngine(permissionMode);
  const auth = new AnthropicEnvAuth();

  // Engine selection: read SWARM_HARNESS_FRAMEWORK env var (default: "auto").
  const frameworkEnv = (process.env.SWARM_HARNESS_FRAMEWORK ?? "auto") as FrameworkChoice;
  const workerModel = "claude-sonnet-4-6";

  let engine: AgentEngine;
  if (process.env.SWARM_HARNESS_TEST_SCRIPT) {
    engine = new ScriptedTestEngine();
  } else if (frameworkEnv === "claude-agent-sdk") {
    engine = new ClaudeAgentSdkEngine();
  } else if (frameworkEnv === "codex-chatgpt") {
    // V0.4.Q11: register the 8-tool peer subset with the codex agent as
    // host dynamicTools. Routed back through this worker's SwarmHost so
    // calls into send_message / team_members / etc. observe the same
    // team scope as a claude-agent-sdk worker would.
    const tier2 = buildTier2Tools();
    const codexPeerTools = filterCodexPeerTools(tier2);
    engine = new CodexFrameworkEngine({
      tools: codexPeerTools,
      host,
    });
  } else if (frameworkEnv === "native") {
    const resolved = resolveProvider(workerModel);
    if (resolved.kind === "native") {
      const nativeAuth = new OpenAIEnvAuth();
      const provider = await resolved.providerFactory!(nativeAuth, resolved.modelId!);
      // Use agentId as the per-worker cache routing key. Each worker gets a
      // unique randomUUID-based agentId from the host; reusing it as the
      // OpenAI prompt_cache_key keeps THIS worker's cache warm across its
      // turns without coupling sibling workers to the same backend.
      engine = new NativeEngine({ provider, sessionId: agentId });
    } else {
      // Fallback: native requested but model resolves to sdk — use sdk.
      engine = new ClaudeAgentSdkEngine();
    }
  } else {
    // auto — default to ClaudeAgentSdkEngine (worker model is always claude).
    engine = new ClaudeAgentSdkEngine();
  }

  const ctx: TurnContext = {
    agentId,
    host,
    transport,
    engine,
    auth,
    dispatcher,
    permissionMode,
    permissionEngine,
    roleSuffix,
    resolvedAllowedTools,
    parentToolUseId,
  };

  // Run the initial task.
  const initialResult = await executeTurn(ctx, initialTask);
  if (!longLived) {
    // Default (non-long-lived): mark terminal; the FSM stays in finished/
    // failed and the worker exits below.
    if (initialResult.status === "success") {
      host.markFinished();
    } else {
      host.markFailed(
        "panic",
        initialResult.status === "failure" ? initialResult.error : "non-success",
      );
    }
    await transport.notify("task_result", initialResult);
    // Default behaviour (preserved): exit immediately after the initial task.
    transport.stopHeartbeat();
    transport.close();
    return initialResult.status === "success" ? 0 : 1;
  }

  // -------------------------------------------------------------------------
  // v0.4 stages 4D + 4M.3: long-lived loop with proper FSM transitions and
  // persistent request listener (no race window between worker_idle notify
  // and listener re-attach).
  // -------------------------------------------------------------------------

  // M5: long-lived workers transition `running → idle` after each turn,
  // NOT `running → finished`. The FSM allows `idle → prompt_accepted →
  // running` for re-entry on run_more. Pure-failure turns still keep the
  // worker available for retry — the orchestrator decides whether to drain
  // or retry; failure status surfaces via task_result + per-turn stderr.
  if (initialResult.status === "success") {
    host.markIdle();
  } else {
    // Per-turn failure in long-lived mode: still go idle (the orchestrator
    // can decide retry vs drain). The state-file failureClass/reason fields
    // would lie if we marked failed here; instead the failure is encoded
    // in the task_result payload.
    host.markIdle();
    process.stderr.write(
      `[swarm-harness] long-lived worker initial turn failed (agentId=${agentId}): ${
        initialResult.status === "failure" ? initialResult.error : initialResult.status
      }\n`,
    );
  }
  await transport.notify("task_result", initialResult);

  // M6: install the request listener ONCE at top-level. Frames arrive
  // synchronously from ParentTransport.handleFrame; without a persistent
  // listener, frames between iterations would be dropped on the floor.
  // Buffer pending frames; each loop iteration drains the buffer first.
  const pendingFrames: IpcRequest[] = [];
  type Wakeup = { kind: "frame"; frame: IpcRequest } | { kind: "close" };
  let pendingResolve: ((wakeup: Wakeup) => void) | undefined;
  const onRequest = (frame: IpcRequest): void => {
    if (frame.method !== "run_more" && frame.method !== "drain") return;
    if (pendingResolve !== undefined) {
      const resolver = pendingResolve;
      pendingResolve = undefined;
      resolver({ kind: "frame", frame });
    } else {
      pendingFrames.push(frame);
    }
  };
  let closeFired = false;
  const onClose = (): void => {
    closeFired = true;
    if (pendingResolve !== undefined) {
      const resolver = pendingResolve;
      pendingResolve = undefined;
      resolver({ kind: "close" });
    }
  };
  transport.on("request", onRequest);
  transport.once("close", onClose);

  let exitCode = 0;
  while (true) {
    // Notify orchestrator we're idle.
    const idleAt = Date.now();
    await transport.notify("worker_idle", {
      agentId,
      readyForRunMoreAt: idleAt,
    });

    // If the close listener already fired, exit cleanly.
    if (closeFired) {
      exitCode = 0;
      break;
    }

    // Wait for either a buffered frame, the next request, the idle timeout,
    // or close. The persistent listener guarantees no race window.
    const next = await new Promise<
      { kind: "run_more"; frame: IpcRequest }
      | { kind: "drain"; frame: IpcRequest }
      | { kind: "timeout" }
      | { kind: "close" }
    >((resolve) => {
      // Drain any buffered frame first (non-blocking).
      if (pendingFrames.length > 0) {
        const frame = pendingFrames.shift()!;
        if (frame.method === "run_more") {
          resolve({ kind: "run_more", frame });
        } else if (frame.method === "drain") {
          resolve({ kind: "drain", frame });
        }
        return;
      }
      // Otherwise await the next frame OR the idle timeout OR close.
      const timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "timeout" });
      }, idleTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        pendingResolve = undefined;
      };
      pendingResolve = (wakeup: Wakeup): void => {
        cleanup();
        if (wakeup.kind === "close") {
          resolve({ kind: "close" });
        } else if (wakeup.frame.method === "run_more") {
          resolve({ kind: "run_more", frame: wakeup.frame });
        } else if (wakeup.frame.method === "drain") {
          resolve({ kind: "drain", frame: wakeup.frame });
        }
      };
    });

    if (next.kind === "close") {
      // Parent transport closed without a clean drain — exit.
      exitCode = 0;
      break;
    }

    if (next.kind === "drain" || next.kind === "timeout") {
      // Idle drain (parent requested OR auto-timeout) — graceful exit.
      // M5: transition idle → drained for a proper FSM record.
      if (next.kind === "drain") {
        transport.respond(next.frame.id, { acknowledged: true });
      }
      try {
        host.markDrained();
      } catch {
        // If we're not currently in idle (shouldn't happen given the loop
        // structure), swallow — the FSM is best-effort for long-lived
        // workers anyway.
      }
      await transport.notify("worker_drained", { agentId });
      break;
    }

    // run_more: validate params, ack, execute the next turn.
    const params = RunMoreParamsSchema.safeParse(next.frame.params);
    if (!params.success) {
      transport.respondError(
        next.frame.id,
        IPC_ERROR_CODES.INVALID_PARAMS,
        params.error.message,
      );
      // M5: re-emit worker_idle so the orchestrator knows we're still
      // available after rejecting a malformed run_more (otherwise it
      // could wait indefinitely for the next worker_idle notification
      // because we already sent one before the request arrived).
      await transport.notify("worker_idle", {
        agentId,
        readyForRunMoreAt: Date.now(),
      });
      continue;
    }
    transport.respond(next.frame.id, { accepted: true });

    // M5: transition idle → prompt_accepted → running for the new turn.
    host.markRunning(params.data.taskId);

    const turnTask: TaskPacket = {
      id: params.data.taskId ?? `${initialTask.id}-${Date.now()}`,
      prompt: params.data.prompt,
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    };
    const result = await executeTurn(ctx, turnTask);

    // M5: after each long-lived turn, transition running → idle (NOT
    // finished/failed). Failures stay in the FSM as `idle` — the failure
    // is encoded in the task_result payload; the orchestrator decides
    // whether to retry via run_more or drain.
    host.markIdle();
    await transport.notify("task_result", result);
    if (result.status !== "success") {
      process.stderr.write(
        `[swarm-harness] long-lived worker turn failed (agentId=${agentId}): ${
          result.status === "failure" ? result.error : result.status
        }\n`,
      );
    }
    // Loop back to top; will re-emit worker_idle and await next request.
  }

  // Clean up the persistent listener.
  transport.off("request", onRequest);
  transport.off("close", onClose);

  transport.stopHeartbeat();
  transport.close();
  return exitCode;
}
