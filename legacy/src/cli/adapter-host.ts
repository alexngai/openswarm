/**
 * adapter-host.ts — shared StandaloneHost assembly for the ecosystem adapter
 * flags (--opentasks / --agent-inbox / --git-cascade / --cleanup-worktrees).
 *
 * Used by `swarm run`, `topology`, and `team start` so all three entry points
 * accept the same flags and produce identically-wired hosts. Adapters are
 * best-effort at runtime (failures don't block the run), but a missing
 * opentasks socket is a configuration error surfaced before any work starts.
 */

import { StandaloneHost } from "../swarm/standalone-host.js";
import type { PermissionMode } from "../core/types.js";
import type { TaskAPI } from "../swarm/host.js";
import type { InboxBackend } from "../swarm/inbox.js";
import {
  OpenTasksClient,
  findOpenTasksSocket,
} from "../swarm/adapters/opentasks-client.js";
import { OpenTasksTaskRegistry } from "../swarm/adapters/opentasks-task-registry.js";
import { AgentInboxBackend } from "../swarm/adapters/agent-inbox-backend.js";
import {
  GitCascadeBranchPolicyAdapter,
  type BranchPolicyAdapter,
} from "../swarm/adapters/git-cascade-branch-policy.js";

export interface AdapterHostOptions {
  readonly permissionMode: PermissionMode;
  /** Mirror task create/update into an opentasks daemon (best-effort). */
  readonly opentasks?: boolean;
  /** Explicit opentasks socket path; auto-discovered when unset. */
  readonly opentasksSocket?: string;
  /** Use the agent-inbox library as the InboxBackend (threading + persistence). */
  readonly agentInbox?: boolean;
  /** Wire GitCascadeBranchPolicyAdapter (worktree-per-member for stream/fork). */
  readonly gitCascade?: boolean;
  /** Remove git-cascade worktrees on exit (requires gitCascade). */
  readonly cleanupWorktrees?: boolean;
  /**
   * Force host construction even when no adapter flag is set (e.g. the caller
   * needs a host to attach a lane trace).
   */
  readonly forceHost?: boolean;
}

export type AdapterHostResult =
  | { readonly ok: true; readonly host: StandaloneHost | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Assemble a StandaloneHost with the requested ecosystem adapters. Returns
 * `host: undefined` when nothing was requested (caller lets the Orchestrator
 * build its default host). Emits the same stderr notices from every entry
 * point so operators see identical enablement lines.
 */
export function buildAdapterHost(opts: AdapterHostOptions): AdapterHostResult {
  const wantsHost =
    opts.opentasks === true ||
    opts.agentInbox === true ||
    opts.gitCascade === true ||
    opts.forceHost === true;
  if (!wantsHost) return { ok: true, host: undefined };

  let taskWrapper: ((inner: TaskAPI) => TaskAPI) | undefined;
  if (opts.opentasks === true) {
    const sockPath = opts.opentasksSocket ?? findOpenTasksSocket(process.cwd());
    if (sockPath === null) {
      return {
        ok: false,
        message:
          "error: --opentasks set but no daemon socket found. Start the daemon with `opentasks daemon start` " +
          "or pass --opentasks-socket <path>.\n",
      };
    }
    const client = new OpenTasksClient(sockPath);
    taskWrapper = (inner) => new OpenTasksTaskRegistry(inner, client);
    process.stderr.write(`[openswarm] --opentasks enabled (socket: ${sockPath})\n`);
  }

  let inboxBackend: InboxBackend | undefined;
  if (opts.agentInbox === true) {
    inboxBackend = new AgentInboxBackend();
    process.stderr.write(`[openswarm] --agent-inbox enabled (in-memory storage)\n`);
  }

  let branchPolicyAdapter: BranchPolicyAdapter | undefined;
  if (opts.gitCascade === true) {
    branchPolicyAdapter = new GitCascadeBranchPolicyAdapter({
      repoPath: process.cwd(),
      ...(opts.cleanupWorktrees === true && { cleanupOnDispose: true }),
    });
    process.stderr.write(
      `[openswarm] --git-cascade enabled (worktrees under ${process.cwd()}/.openswarm/worktrees/${opts.cleanupWorktrees === true ? "; auto-cleanup on exit" : ""})\n`,
    );
  }

  return {
    ok: true,
    host: new StandaloneHost({
      permissionMode: opts.permissionMode,
      ...(taskWrapper !== undefined && { taskWrapper }),
      ...(inboxBackend !== undefined && { inboxBackend }),
      ...(branchPolicyAdapter !== undefined && { branchPolicyAdapter }),
    }),
  };
}
