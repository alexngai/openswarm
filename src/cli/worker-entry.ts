import * as path from "node:path";
import type { AgentId } from "../core/types.js";
import { ParentTransport } from "../swarm/ipc/parent-transport.js";
import { WorkerHost } from "../swarm/worker-host.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
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
import type { PermissionMode, Usage } from "../core/types.js";
import type { ToolExecutionContext, ToolImpl } from "../tools/types.js";

export async function runWorkerEntry(): Promise<number> {
  const agentId = (process.env.SWARM_CODER_AGENT_ID ?? "unknown") as AgentId;
  const depthStr = process.env.SWARM_CODER_DEPTH ?? "0";
  const depth = Number.parseInt(depthStr, 10);
  const parentToolUseId = process.env.SWARM_CODER_PARENT_TOOL_USE_ID;

  const heartbeatIntervalMs = process.env.SWARM_CODER_HEARTBEAT_MS
    ? Number.parseInt(process.env.SWARM_CODER_HEARTBEAT_MS, 10)
    : undefined;
  const transport = new ParentTransport({ agentId, heartbeatIntervalMs });
  const permissionMode = (process.env.SWARM_CODER_PERMISSION_MODE ??
    "workspace-write") as PermissionMode;
  const host = new WorkerHost(agentId, depth, permissionMode, transport, parentToolUseId);

  // Announce readiness.
  await transport.notify("worker_ready", {
    agentId,
    depth,
    pid: process.pid,
  });
  transport.startHeartbeat();

  // Await the run request.
  const runReq = await new Promise<IpcRequest>((resolve) => {
    transport.once("run", resolve);
  });
  const task = runReq.params as TaskPacket;

  // Ack the run immediately.
  transport.respond(runReq.id, { accepted: true });

  // M3a Phase 6: role overlay + allowedTools filter.
  // `SWARM_CODER_ROLE` names a role; we look it up in a worker-local
  // RoleRegistry (built-ins + custom roles loaded fresh from cwd).
  // `SWARM_CODER_ALLOWED_TOOLS` carries an explicit JSON array that wins
  // over the role-derived list when both are present. The system prompt
  // suffix is appended to RunConfig.systemPrompt (role suffix wins on
  // conflicts per the plan).
  const roleName = process.env.SWARM_CODER_ROLE;
  let roleSuffix = "";
  let resolvedAllowedTools: readonly string[] | undefined;
  if (roleName !== undefined && roleName.length > 0) {
    const roleReg = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roleReg.register(r);
    try {
      const custom = await loadCustomRoles(
        path.join(process.cwd(), ".swarm-coder", "roles.json"),
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
        `[swarm-coder] worker: unknown role "${roleName}" — proceeding without role overlay\n`,
      );
    }
  }
  const envAllowed = process.env.SWARM_CODER_ALLOWED_TOOLS;
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
  const engine = process.env.SWARM_CODER_TEST_SCRIPT
    ? new ScriptedTestEngine()
    : new ClaudeAgentSdkEngine();

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
      execute: async (input: unknown, ctx: ToolExecutionContext) => {
        // Inject SwarmHost into the execution context for Tier 2 tools.
        return t.execute(input, { ...ctx, host });
      },
    }));

    // Append the role suffix (if any) to the base system prompt. Role suffix
    // wins on conflicts because it lands last — matches the plan's
    // "last-writer-wins on model-perceived directives" guidance.
    const systemPrompt = roleSuffix.length > 0 ? roleSuffix : "";

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

  await transport.notify("task_result", result);
  transport.stopHeartbeat();
  transport.close();

  return result.status === "success" ? 0 : 1;
}
