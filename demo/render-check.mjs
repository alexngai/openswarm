#!/usr/bin/env node
/**
 * render-check.mjs — offline sanity render of the curated log through the REAL
 * board pipeline (parseTeamEventsLog → renderEventLogBoard), so we can validate
 * the demo log without spinning up `team watch`. Not used by the recording.
 *
 *   node demo/render-check.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { parseTeamEventsLog } = await import(
  join(ROOT, "dist/swarm/events-log.js")
);
const { renderEventLogBoard } = await import(
  join(ROOT, "dist/cli/team-watch.js")
);

const content = readFileSync(
  join(HERE, "events/see-and-steer.events.jsonl"),
  "utf8",
);
const { events, malformed } = parseTeamEventsLog(content);
const board = await renderEventLogBoard(events);
process.stdout.write(board.join("\n") + "\n");
process.stderr.write(`\n[events=${events.length} malformed=${malformed}]\n`);
