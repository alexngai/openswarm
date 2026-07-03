/**
 * daemon-swarm-view.ts — project a detached team daemon's `events.jsonl` into
 * the REPL swarm-view NormalizedEvents (GitHub #23).
 *
 * The team daemon (`team start --detach`) deliberately exposes NO socket
 * subscribe RPC; its per-team `events.jsonl` IS the blessed follow contract
 * (see events-log.ts / team-daemon-protocol.ts). `team watch` tails that file
 * for a terminal board; this module tails the same file but feeds each recorded
 * LaneEvent through the shared #15 `SwarmViewTranslator`, producing the
 * `agent_spawned` / `agent_status` / `task_update` NormalizedEvents that drive
 * the interactive REPL's AgentTree (Ctrl+A) and TaskBoard (Ctrl+T) views.
 *
 * Two layers:
 *   - `DaemonSwarmViewProjector` — pure, stateful: give it the full current
 *     `events.jsonl` blob and it returns only the view events produced by the
 *     lines it hasn't seen yet. The translator instance persists across calls,
 *     so a member spawned early keeps receiving status/task updates on later
 *     ingests (cross-turn persistence). Directly unit-testable, no I/O.
 *   - `tailDaemonSwarmView` — wires the projector onto a live file via
 *     fs.watch + a poll fallback (mirrors team-watch's tail loop), forwarding
 *     produced events to a sink. Returns an unsubscribe function.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { NormalizedEvent } from "../core/types.js";
import { parseTeamEventsLog } from "./events-log.js";
import { SwarmViewTranslator } from "./swarm-view-events.js";

/**
 * Stateful projector from `events.jsonl` snapshots to REPL view events.
 *
 * Feed it the WHOLE file content on each change; it tracks how many recorded
 * lane events it has already translated and returns only the view events from
 * the new tail. The internal `SwarmViewTranslator` is not given an
 * `orchestratorId`: a daemon's orchestrator is never itself a `worker_spawned`
 * member, so members spawned directly by it render as tree roots naturally
 * (buildTree roots come from `parentId == null`), and the orchestrator's own
 * lifecycle events are dropped because it is not a tracked member.
 */
export class DaemonSwarmViewProjector {
  private translator = new SwarmViewTranslator();
  private processed = 0;

  /**
   * Ingest the full current `events.jsonl` blob; return the view events from
   * lines not yet seen. Detects truncation/rotation (fewer parsed events than
   * already processed) by resetting the translator and replaying from the top.
   */
  ingest(content: string): NormalizedEvent[] {
    const { events } = parseTeamEventsLog(content);
    if (events.length < this.processed) {
      // File shrank — a rotation or truncation. Rebuild view state from scratch.
      this.translator = new SwarmViewTranslator();
      this.processed = 0;
    }
    const out: NormalizedEvent[] = [];
    for (let i = this.processed; i < events.length; i += 1) {
      for (const view of this.translator.onLaneEvent(events[i]!)) out.push(view);
    }
    this.processed = events.length;
    return out;
  }
}

export interface TailDaemonSwarmViewOptions {
  /** Poll interval (ms) backing up fs.watch. Default 250. */
  readonly pollMs?: number;
}

/**
 * Tail a team daemon's `events.jsonl`, forwarding translated swarm-view events
 * to `sink`. Returns an unsubscribe function that stops watching/polling.
 *
 * Waits gracefully if the file does not exist yet (the daemon may not have
 * written its first event), like `team watch`.
 */
export function tailDaemonSwarmView(
  eventsPath: string,
  sink: (evt: NormalizedEvent) => void,
  opts: TailDaemonSwarmViewOptions = {},
): () => void {
  const projector = new DaemonSwarmViewProjector();
  const dir = path.dirname(eventsPath);
  const fileName = path.basename(eventsPath);
  const pollMs = opts.pollMs ?? 250;

  let stopped = false;
  let lastSize = -1;
  let draining = false;

  const drain = async (): Promise<void> => {
    if (stopped || draining) return;
    draining = true;
    try {
      let size: number;
      try {
        size = (await fsp.stat(eventsPath)).size;
      } catch {
        return; // not present yet — keep waiting
      }
      if (size === lastSize) return;
      lastSize = size;
      let content: string;
      try {
        content = await fsp.readFile(eventsPath, "utf8");
      } catch {
        return;
      }
      for (const evt of projector.ingest(content)) {
        if (stopped) return;
        sink(evt);
      }
    } finally {
      draining = false;
    }
  };

  // Initial read, then fs.watch (fast path) + interval poll (fallback for
  // platforms/filesystems where watch misses appends).
  void drain();

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir);
    watcher.on("change", (_event, changed) => {
      if (typeof changed === "string" && changed !== fileName) return;
      void drain();
    });
    watcher.on("error", () => {
      /* fall back to the poll loop */
    });
  } catch {
    /* directory may not exist yet — poll loop still covers it */
  }

  const timer = setInterval(() => {
    void drain();
  }, pollMs);
  // Don't keep the process alive solely for this poll (REPL owns the lifecycle).
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}
