/**
 * macro-methods.ts — docs/44 P8 (H5). MAP extension handlers OpenHive invokes
 * over the MAP server to control the swarm:
 *
 *   _macro/spawnAgent     spawn a coordinator/agent → StandaloneHost.spawn
 *   _macro/terminateAgent terminate a spawned agent  → handle.kill()
 *
 * Registered as `additionalHandlers` on the MAPServer (request/response).
 * Mirrors macro-agent's `src/map/server.ts` `_macro/*` surface; param names
 * match so an OpenHive client speaks to either backend unchanged.
 */

import { randomUUID } from "node:crypto";
import type { AgentHandle, TaskPacket } from "../swarm/host.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import type { PermissionMode } from "../core/types.js";

/** Minimal Handler shape (matches the MAP SDK's `Handler` without importing it). */
type Handler = (params: unknown, ctx?: unknown) => Promise<unknown>;
export type MacroHandlerRegistry = Record<string, Handler>;

export interface MacroMethods {
  /** Merge into the MAPServer's `additionalHandlers`. */
  readonly handlers: MacroHandlerRegistry;
  /** Kill every agent spawned via `_macro/spawnAgent` (host shutdown). */
  dispose(): Promise<void>;
}

export interface CreateMacroMethodsOptions {
  readonly host: StandaloneHost;
  /** Default cwd for spawned agents (the hosted workspace / data dir). */
  readonly defaultCwd: string;
  /** Default permission mode when the caller doesn't specify one. */
  readonly permissionMode: PermissionMode;
  readonly log?: (msg: string) => void;
}

interface SpawnAgentParams {
  readonly task?: string;
  readonly role?: string;
  readonly cwd?: string;
  readonly permissionMode?: PermissionMode;
  readonly model?: string;
}

interface TerminateAgentParams {
  readonly agentId?: string;
  readonly reason?: string;
}

export function createMacroMethods(
  opts: CreateMacroMethodsOptions,
): MacroMethods {
  const log = opts.log ?? (() => {});
  // agentId → live handle, so terminate can kill and shutdown can reap.
  const handles = new Map<string, AgentHandle>();

  const handlers: MacroHandlerRegistry = {
    "_macro/spawnAgent": async (params) => {
      const p = (params ?? {}) as SpawnAgentParams;
      const role = p.role ?? "coordinator";
      const task: TaskPacket = {
        id: randomUUID(),
        prompt: p.task ?? "Spawned via MAP (_macro/spawnAgent)",
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
        role,
      };
      const handle = await opts.host.spawn({
        task,
        permissionMode: p.permissionMode ?? opts.permissionMode,
        role,
        cwd: p.cwd ?? opts.defaultCwd,
        ...(p.model !== undefined && { model: p.model }),
        // MAP-spawned agents are long-lived: the hub drives them via mail/ACP
        // rather than a one-shot task that exits.
        longLived: true,
      });
      handles.set(handle.agentId, handle);
      log(`[macro] spawned ${role} ${handle.agentId} via _macro/spawnAgent`);
      // Reap the map entry when the agent exits on its own.
      void handle
        .wait()
        .catch(() => {})
        .finally(() => handles.delete(handle.agentId));
      return {
        agent: { id: handle.agentId, localId: handle.agentId, role },
      };
    },

    "_macro/terminateAgent": async (params) => {
      const p = (params ?? {}) as TerminateAgentParams;
      if (p.agentId === undefined || p.agentId === "") {
        return { success: false, error: "agentId is required" };
      }
      const handle = handles.get(p.agentId);
      if (handle === undefined) {
        return { success: false, error: `unknown agent ${p.agentId}` };
      }
      try {
        await handle.kill();
        handles.delete(p.agentId);
        log(`[macro] terminated ${p.agentId} (${p.reason ?? "cancelled"})`);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  };

  return {
    handlers,
    async dispose(): Promise<void> {
      const live = [...handles.values()];
      handles.clear();
      await Promise.all(live.map((h) => h.kill().catch(() => {})));
    },
  };
}
