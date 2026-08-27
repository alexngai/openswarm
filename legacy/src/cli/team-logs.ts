/**
 * team-logs.ts — `openswarm team logs <name> [--follow]`.
 *
 * v0.5 stage 5E.5: read (or tail) a team daemon's events.jsonl. Default
 * behavior reads the file once and exits. With --follow, prints up to the
 * current end and then watches the file via fs.watch, printing newly-
 * appended lines as they arrive (tail-style).
 *
 * V0.5.Q5d defers log rotation to v0.6+, but the follow loop is defensive
 * against truncation: if the file shrinks, the offset resets to 0.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { computeTeamPaths } from "./team-paths.js";

function eventsPath(name: string): string {
  return computeTeamPaths(name).eventsPath;
}

export interface TeamLogsOptions {
  readonly follow: boolean;
}

export async function runTeamLogs(
  name: string,
  opts: TeamLogsOptions,
): Promise<number> {
  const filePath = eventsPath(name);

  // Initial read — print everything that's already there. Missing file is
  // fine in --follow mode (we'll wait for it); fatal otherwise.
  let initialOffset = 0;
  try {
    const buf = await fsp.readFile(filePath, "utf8");
    process.stdout.write(buf);
    initialOffset = Buffer.byteLength(buf, "utf8");
  } catch (err: unknown) {
    if (!opts.follow) {
      process.stderr.write(
        `error: events.jsonl for team "${name}" not found at ${filePath}\n`,
      );
      return 2;
    }
    // --follow: wait for the file to appear, then start tailing.
  }

  if (!opts.follow) return 0;

  return await tailFollow(filePath, initialOffset);
}

/**
 * Tail-follow loop. Watches the file's directory (so new-file creation
 * triggers an event even if the file didn't exist at start) and re-reads
 * the slice from `offset` to current size each time something changes.
 *
 * Resolves only when the process is killed externally (SIGINT/SIGTERM).
 * Returns 0 on graceful interrupt.
 */
async function tailFollow(filePath: string, offset: number): Promise<number> {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);

  // Ensure dir exists so fs.watch doesn't ENOENT.
  await fsp.mkdir(dir, { recursive: true });

  let currentOffset = offset;
  let stopped = false;

  const sigHandler = (): void => {
    stopped = true;
  };
  process.on("SIGINT", sigHandler);
  process.on("SIGTERM", sigHandler);

  // Drain pending bytes once. Returns true if anything was printed.
  const drain = async (): Promise<void> => {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return; // file doesn't exist yet
    }
    if (stat.size < currentOffset) {
      // Truncation — reset to 0 (V0.5.Q5d defensive behaviour).
      currentOffset = 0;
    }
    if (stat.size === currentOffset) return;
    const handle = await fsp.open(filePath, "r");
    try {
      const len = stat.size - currentOffset;
      const buf = Buffer.alloc(len);
      await handle.read(buf, 0, len, currentOffset);
      process.stdout.write(buf);
      currentOffset = stat.size;
    } finally {
      await handle.close();
    }
  };

  // Initial drain in case the file already grew between initial read + watch.
  await drain();

  // Watch the directory so file creation also triggers events.
  const watcher = fs.watch(dir);
  watcher.on("change", (_event, name) => {
    if (typeof name === "string" && name !== fileName) return;
    void drain();
  });
  watcher.on("error", () => {
    // Best-effort: treat watcher errors as "stopped" rather than crashing.
    stopped = true;
  });

  // Polling sentinel — small interval lets us notice stop signals + drain
  // anything fs.watch missed (some filesystems don't fire reliably).
  while (!stopped) {
    await new Promise((r) => setTimeout(r, 250));
    await drain();
  }
  watcher.close();
  process.off("SIGINT", sigHandler);
  process.off("SIGTERM", sigHandler);
  return 0;
}
