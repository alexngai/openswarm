/**
 * team-watch.ts — `openswarm team watch <name>`.
 *
 * Default (issue #16): a live multi-pane board of a team daemon's
 * events.jsonl — per-member lanes (`[role]`-attributed activity) plus a task
 * board — reusing the shared `RichRenderer` (src/acp/rich-view.ts). The board
 * is a full re-projection of the recorded spine on each change: the same
 * `events.jsonl` → lane-translator → RichRenderer pipeline the ACP replay path
 * (`replayTeamSpine`) already uses, so the watch renders identically to a
 * `session/load` of the team. See docs/25 §13.
 *
 * Coarseness (inherited from the recorded-event contract, events-log.ts):
 * live-only high-frequency deltas (`text_delta` / `tool_use_input` /
 * `heartbeat`) are filtered out at write time, so lanes surface `[role]`-tagged
 * tool calls + results rather than streamed narration. Lanes appear for members
 * with recorded activity; the task board lists every roster member's state.
 *
 * `--plain` / `--raw` falls back to the legacy v0.5 stage 5D one-line tail:
 * "<HH:MM:SS.mmm> <colored TYPE> <agent-id-prefix> <summary>" per LaneEvent.
 * Colors apply only when stdout is a TTY.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  AgentSideConnection,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { LaneEvent, TeamUsagePayload } from "../swarm/events.js";
import { parseTeamEventsLog } from "../swarm/events-log.js";
import { RichRenderer } from "../acp/rich-view.js";
import { formatRichView } from "../acp/rich-format.js";
import { replayTeamSpine } from "../acp/team-history.js";
import { computeTeamPaths } from "./team-paths.js";

export interface TeamWatchOptions {
  /** Disable color output even on a TTY. Useful for piping to a file. */
  readonly noColor?: boolean;
  /** Legacy one-line-per-event tail instead of the multi-pane board. */
  readonly plain?: boolean;
}

export async function runTeamWatch(
  name: string,
  opts: TeamWatchOptions = {},
): Promise<number> {
  const paths = computeTeamPaths(name);
  const useColor = opts.noColor !== true && (process.stdout.isTTY ?? false);

  if (opts.plain === true) {
    return await runPlainTail(name, paths.eventsPath, useColor);
  }
  return await runBoard(name, paths.eventsPath, useColor);
}

// ---------------------------------------------------------------------------
// Multi-pane board (issue #16) — reuses RichRenderer via the ACP replay path
// ---------------------------------------------------------------------------

/**
 * Project a recorded event stream into the shared `RichView` (per-member lanes
 * + task board), reusing the exact `events.jsonl` → lane-translator →
 * RichRenderer pipeline as `replayTeamSpine`. Pure: events in, terminal lines
 * out — the tail loop just repaints these. Exported for tests.
 */
export async function renderEventLogBoard(
  events: readonly LaneEvent[],
): Promise<string[]> {
  const renderer = new RichRenderer();
  const conn: Pick<AgentSideConnection, "sessionUpdate"> = {
    sessionUpdate: async (n: SessionNotification): Promise<void> => {
      renderer.apply(n.update);
    },
  };
  await replayTeamSpine(conn, "team-watch", events);
  return formatRichView(renderer.view(), latestTeamUsage(events));
}

/**
 * The most recent `team_usage` (#17) snapshot in the stream, if any. The daemon
 * emits these periodically/on-demand as cumulative roll-ups, so the last one
 * wins — earlier snapshots are superseded.
 */
function latestTeamUsage(
  events: readonly LaneEvent[],
): TeamUsagePayload | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "team_usage") {
      return events[i]!.payload as TeamUsagePayload;
    }
  }
  return undefined;
}

async function runBoard(
  name: string,
  filePath: string,
  useColor: boolean,
): Promise<number> {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  await fsp.mkdir(dir, { recursive: true });

  let stopped = false;
  let lastSize = -1;
  const onSig = (): void => {
    stopped = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const header = useColor
    ? `\x1b[1;36mwatching team "${name}" — ${filePath}\x1b[0m`
    : `watching team "${name}" — ${filePath}`;

  const repaint = async (): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      if (lastSize === -1) {
        lastSize = 0;
        paint([
          header,
          "",
          "(events.jsonl not yet present; waiting for the daemon…)",
        ]);
      }
      return;
    }
    // Repaint on any size change (append or truncation).
    if (stat.size === lastSize) return;
    lastSize = stat.size;
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch {
      return;
    }
    const { events } = parseTeamEventsLog(content);
    const board = await renderEventLogBoard(events);
    paint([header, "", ...board]);
  };

  const paint = (lines: string[]): void => {
    if (useColor) process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${lines.join("\n")}\n`);
  };

  await repaint();

  const watcher = fs.watch(dir);
  watcher.on("change", (_event, changed) => {
    if (typeof changed === "string" && changed !== fileName) return;
    void repaint();
  });
  watcher.on("error", () => {
    stopped = true;
  });

  while (!stopped) {
    await new Promise((r) => setTimeout(r, 250));
    await repaint();
  }
  watcher.close();
  process.off("SIGINT", onSig);
  process.off("SIGTERM", onSig);
  return 0;
}

// ---------------------------------------------------------------------------
// Legacy one-line tail (`--plain`/`--raw`) — v0.5 stage 5D MVP
// ---------------------------------------------------------------------------

async function runPlainTail(
  name: string,
  filePath: string,
  useColor: boolean,
): Promise<number> {
  const fmt = makeFormatter(useColor);

  // Print a header so the operator knows what they're watching.
  process.stdout.write(
    fmt.header(`watching team "${name}" — ${filePath}\n`),
  );

  let initialOffset = 0;
  try {
    const buf = await fsp.readFile(filePath, "utf8");
    initialOffset = Buffer.byteLength(buf, "utf8");
    for (const line of buf.split("\n")) {
      if (line.length > 0) {
        process.stdout.write(formatLine(line, fmt));
      }
    }
  } catch {
    // Daemon may not have started writing yet — start tailing from 0.
    process.stdout.write(
      fmt.dim(`(events.jsonl not yet present; tailing for new events…)\n`),
    );
  }

  return await tailFollow(filePath, initialOffset, fmt);
}

// ---------------------------------------------------------------------------
// Tail loop (mirrors team-logs.ts but emits formatted lines)
// ---------------------------------------------------------------------------

async function tailFollow(
  filePath: string,
  offset: number,
  fmt: Formatter,
): Promise<number> {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  await fsp.mkdir(dir, { recursive: true });

  let currentOffset = offset;
  let stopped = false;
  let lineBuf = "";

  const onSig = (): void => {
    stopped = true;
  };
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  const drain = async (): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return;
    }
    if (stat.size < currentOffset) {
      // Truncation — reset (V0.5.Q5d defensive behaviour).
      currentOffset = 0;
      lineBuf = "";
    }
    if (stat.size === currentOffset) return;
    const handle = await fsp.open(filePath, "r");
    try {
      const len = stat.size - currentOffset;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, currentOffset);
      currentOffset = stat.size;
      lineBuf += buf.toString("utf8");
      let nl;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.length > 0) {
          process.stdout.write(formatLine(line, fmt));
        }
      }
    } finally {
      await handle.close();
    }
  };

  await drain();

  const watcher = fs.watch(dir);
  watcher.on("change", (_event, name) => {
    if (typeof name === "string" && name !== fileName) return;
    void drain();
  });
  watcher.on("error", () => {
    stopped = true;
  });

  while (!stopped) {
    await new Promise((r) => setTimeout(r, 250));
    await drain();
  }
  watcher.close();
  process.off("SIGINT", onSig);
  process.off("SIGTERM", onSig);
  return 0;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

interface Formatter {
  header(s: string): string;
  dim(s: string): string;
  type(s: string): string;
  error(s: string): string;
  message(s: string): string;
  agent(s: string): string;
}

function makeFormatter(useColor: boolean): Formatter {
  if (!useColor) {
    const plain = (s: string): string => s;
    return {
      header: plain,
      dim: plain,
      type: plain,
      error: plain,
      message: plain,
      agent: plain,
    };
  }
  // Raw ANSI — keeps the dep surface zero.
  const wrap = (open: string) => (s: string): string =>
    `\x1b[${open}m${s}\x1b[0m`;
  return {
    header: wrap("1;36"), // bold cyan
    dim: wrap("2"),
    type: wrap("32"), // green
    error: wrap("31"), // red
    message: wrap("36"), // cyan
    agent: wrap("33"), // yellow
  };
}

/**
 * Format one events.jsonl line. Falls back to passthrough on parse errors
 * so unexpected lines don't crash the watcher.
 */
export function formatLine(line: string, fmt: Formatter): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return `${line}\n`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `${line}\n`;
  }
  const event = parsed as {
    ts?: number;
    type?: string;
    agentId?: string;
    payload?: Record<string, unknown>;
  };
  const ts = formatTs(event.ts);
  const typeStr = event.type ?? "?";
  const isError = typeStr.includes("error") || typeStr === "team_aborted";
  const isMessage = typeStr === "message_sent" || typeStr === "message_recv";
  const colored = isError
    ? fmt.error(typeStr)
    : isMessage
      ? fmt.message(typeStr)
      : fmt.type(typeStr);
  const agentPrefix =
    event.agentId !== undefined && event.agentId.length > 0
      ? fmt.agent(event.agentId.slice(0, 8))
      : fmt.dim("--------");
  const summary = summarisePayload(typeStr, event.payload);
  return `${fmt.dim(ts)} ${colored.padEnd(28)} ${agentPrefix} ${summary}\n`;
}

function formatTs(ts: number | undefined): string {
  if (ts === undefined) return "--:--:--.---";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function summarisePayload(
  type: string,
  payload: Record<string, unknown> | undefined,
): string {
  if (payload === undefined) return "";
  // Pluck the most useful field per event family.
  if (type === "message_sent" || type === "message_recv") {
    const content = payload.content;
    if (typeof content === "string") {
      return truncate(content, 120);
    }
  }
  if (type === "team_started" || type === "team_completed" || type === "team_aborted") {
    const teamName = payload.teamName ?? payload.scope ?? "";
    const extra = payload.reason ?? payload.completion ?? "";
    return `${teamName}${extra !== "" ? ` (${extra})` : ""}`;
  }
  if (type === "spawn_requested" || type === "worker_spawned" || type === "worker_exited") {
    const childId =
      typeof payload.childAgentId === "string"
        ? payload.childAgentId.slice(0, 8)
        : "";
    const role = payload.role ?? "";
    return `${childId}${role !== "" ? ` role=${role}` : ""}`;
  }
  // Default: compact payload preview.
  const preview = JSON.stringify(payload);
  return truncate(preview, 120);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
