/**
 * team-watch.ts — `openswarm team watch <name>`.
 *
 * v0.5 stage 5D minimal: single-pane formatted live view of a team
 * daemon's events.jsonl. Builds on the tail logic from `team logs --follow`
 * (5E.5) and adds a compact, color-coded one-line-per-event format. The
 * full multi-pane TUI from docs/25 §13 is deferred to v0.6 — this MVP
 * delivers the operator value (formatted live activity) without the TUI
 * dependency surface.
 *
 * Output format: "<HH:MM:SS.mmm> <colored TYPE> <agent-id-prefix> <summary>"
 * — one line per LaneEvent. Colors apply only when stdout is a TTY.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { computeTeamPaths } from "./team-paths.js";

export interface TeamWatchOptions {
  /** Disable color output even on a TTY. Useful for piping to a file. */
  readonly noColor?: boolean;
}

export async function runTeamWatch(
  name: string,
  opts: TeamWatchOptions = {},
): Promise<number> {
  const paths = computeTeamPaths(name);
  const useColor =
    opts.noColor !== true && (process.stdout.isTTY ?? false);
  const fmt = makeFormatter(useColor);

  // Print a header so the operator knows what they're watching.
  process.stdout.write(
    fmt.header(`watching team "${name}" — ${paths.eventsPath}\n`),
  );

  let initialOffset = 0;
  try {
    const buf = await fsp.readFile(paths.eventsPath, "utf8");
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

  return await tailFollow(paths.eventsPath, initialOffset, fmt);
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
