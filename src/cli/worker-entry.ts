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
import type { AgentEngine } from "../engine/index.js";
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
import type { AgentResult, TaskPacket } from "../swarm/host.js";
import type { IpcRequest } from "../swarm/ipc/protocol.js";
import { RunMoreParamsSchema } from "../swarm/ipc/protocol.js";
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

    const runConfig = {
      systemPrompt,
      prompt: task.prompt,
      model: "claude-sonnet-4-6",
      auth,
      tools: allTools,
      permissionMode,
      canUseTool: async (toolName: string, _input: unknown) => {
        const tool = dispatcher.get(toolName);
        if (!tool) {
          return { allow: false as const, reason: `unknown tool: ${toolName}` };
        }
        return permissionEngine.check(tool.spec);
      },
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
      // Forward every event as a lane_event (coarse).
      await transport.notify("lane_event", {
        ts: Date.now(),
        agentId,
        type: "text_delta",
        payload: evt,
        ...(parentToolUseId !== undefined && { parentToolUseId }),
      });
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
  const host = new WorkerHost(agentId, depth, permissionMode, transport, parentToolUseId);

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
      engine = new NativeEngine({ provider });
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
  if (initialResult.status === "success") {
    host.markFinished();
  } else {
    host.markFailed("panic", initialResult.status === "failure" ? initialResult.error : "non-success");
  }
  await transport.notify("task_result", initialResult);

  if (!longLived) {
    // Default behaviour (preserved): exit immediately after the initial task.
    transport.stopHeartbeat();
    transport.close();
    return initialResult.status === "success" ? 0 : 1;
  }

  // -------------------------------------------------------------------------
  // v0.4 stage 4D: long-lived loop — idle, await run_more or drain, repeat.
  // -------------------------------------------------------------------------

  // The lifecycle state machine doesn't allow finished → idle, so reset the
  // host to a fresh state machine for each long-lived turn. Long-lived workers
  // emit per-turn lifecycle events but the WORKER process state is implicit
  // (idle ↔ running) — we don't try to model it through the state file.
  // Future: a proper "post-finished restart" transition rather than reusing
  // the per-turn machine.
  let exitCode = 0;
  while (true) {
    // Notify orchestrator we're idle.
    const idleAt = Date.now();
    await transport.notify("worker_idle", {
      agentId,
      readyForRunMoreAt: idleAt,
    });

    // Wait for either run_more, drain, or the idle timeout.
    const next = await new Promise<
      { kind: "run_more"; frame: IpcRequest }
      | { kind: "drain"; frame: IpcRequest }
      | { kind: "timeout" }
      | { kind: "close" }
    >((resolve) => {
      const onRequest = (frame: IpcRequest): void => {
        if (frame.method === "run_more") {
          cleanup();
          resolve({ kind: "run_more", frame });
        } else if (frame.method === "drain") {
          cleanup();
          resolve({ kind: "drain", frame });
        }
      };
      const onClose = (): void => {
        cleanup();
        resolve({ kind: "close" });
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "timeout" });
      }, idleTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof timer.unref === "function") timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        transport.off("request", onRequest);
        transport.off("close", onClose);
      };
      transport.on("request", onRequest);
      transport.once("close", onClose);
    });

    if (next.kind === "close") {
      // Parent transport closed without a clean drain — exit.
      exitCode = 0;
      break;
    }

    if (next.kind === "drain" || next.kind === "timeout") {
      // Idle drain (parent requested OR auto-timeout) — graceful exit.
      if (next.kind === "drain") {
        transport.respond(next.frame.id, { acknowledged: true });
      }
      await transport.notify("worker_drained", { agentId });
      break;
    }

    // run_more: ack and execute the next turn.
    const params = RunMoreParamsSchema.safeParse(next.frame.params);
    if (!params.success) {
      transport.respondError(next.frame.id, "invalid_params", params.error.message);
      continue;
    }
    transport.respond(next.frame.id, { accepted: true });

    const turnTask: TaskPacket = {
      id: params.data.taskId ?? `${initialTask.id}-${Date.now()}`,
      prompt: params.data.prompt,
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    };
    const result = await executeTurn(ctx, turnTask);
    await transport.notify("task_result", result);
    if (result.status !== "success") {
      // Per-turn failure does not exit the worker — the orchestrator decides
      // whether to drain or send another run_more. Note it for stderr.
      process.stderr.write(
        `[swarm-harness] long-lived worker turn failed (agentId=${agentId}): ${
          result.status === "failure" ? result.error : result.status
        }\n`,
      );
    }
    // loop back to idle.
  }

  transport.stopHeartbeat();
  transport.close();
  return exitCode;
}
