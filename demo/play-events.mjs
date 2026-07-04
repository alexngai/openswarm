#!/usr/bin/env node
/**
 * play-events.mjs — dribble the curated log into a live `events.jsonl` so
 * `openswarm team watch <name>` animates as if a real daemon were writing.
 *
 * `team watch` repaints whenever the file grows (fs.watch + 250ms poll), so we
 * append one record at a time with a small delay. NO daemon, NO model, NO API
 * spend — the board is a pure re-projection of this file.
 *
 * Usage:
 *   node demo/play-events.mjs base  <eventsPath> [--delay 320] [--lead-in 1200]
 *   node demo/play-events.mjs steer <eventsPath> [--delay 300] [--lead-in 1200]
 *
 *   base : truncate + write the _metadata header, then dribble every record
 *          NOT tagged `provenance:"steer"`.
 *   steer: append every record tagged `provenance:"steer"`.
 */

import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, "events", "see-and-steer.events.jsonl");

const [phase, eventsPath, ...rest] = process.argv.slice(2);
if (phase !== "base" && phase !== "steer") {
  process.stderr.write("usage: play-events.mjs <base|steer> <eventsPath>\n");
  process.exit(2);
}
if (!eventsPath) {
  process.stderr.write("error: missing <eventsPath>\n");
  process.exit(2);
}

const flag = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? Number(rest[i + 1]) : def;
};
const delay = flag("--delay", phase === "base" ? 320 : 300);
const leadIn = flag("--lead-in", 1200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim());
let meta = "";
const base = [];
const steer = [];
for (const line of lines) {
  const rec = JSON.parse(line);
  if (rec.type === "_metadata") meta = line;
  else if (rec.provenance === "steer") steer.push(line);
  else base.push(line);
}

mkdirSync(dirname(eventsPath), { recursive: true });

if (phase === "base") {
  // Fresh run: reset the wire with just the metadata header, then dribble.
  writeFileSync(eventsPath, meta + "\n", "utf8");
}

const queue = phase === "base" ? base : steer;

await sleep(leadIn);
for (const line of queue) {
  appendFileSync(eventsPath, line + "\n", "utf8");
  await sleep(delay);
}
