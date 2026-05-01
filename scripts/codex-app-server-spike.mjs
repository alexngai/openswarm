#!/usr/bin/env node
/**
 * codex-app-server-spike.mjs — Stage 3.0 capture script.
 *
 * Spawns `codex app-server` (stdio) and exercises:
 *   1. initialize handshake
 *   2. thread/start (creates a new thread)
 *   3. turn/start with a tiny prompt
 *   4. listens to streaming events until turn completes
 *
 * Captures every JSON-RPC message (request/response/notification) into a
 * JSONL fixture so we can replay it under unit tests.
 *
 * Output:
 *   test/fixtures/codex-app-server/handshake-and-turn.jsonl
 *
 * Usage:
 *   node scripts/codex-app-server-spike.mjs
 *
 * Prereq:
 *   - `codex` CLI installed (`npm install -g @openai/codex`)
 *   - `codex login` completed (auth.json present in ~/.codex/)
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "codex-app-server");
const FIXTURE_FILE = path.join(FIXTURE_DIR, "handshake-and-turn.jsonl");

await mkdir(FIXTURE_DIR, { recursive: true });
const fixture = createWriteStream(FIXTURE_FILE, { encoding: "utf8" });

function logFixture(direction, message) {
  fixture.write(JSON.stringify({ ts: Date.now(), direction, message }) + "\n");
  process.stderr.write(`[${direction}] ${JSON.stringify(message).slice(0, 160)}\n`);
}

const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });

let nextId = 1;
const pending = new Map(); // id → { resolve, reject }

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  logFixture("client→server", msg);
  proc.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

let stdoutBuf = "";
proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      logFixture("server→client (parse-error)", { raw: line, error: String(err) });
      continue;
    }
    logFixture("server→client", parsed);
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) reject(parsed.error);
      else resolve(parsed.result);
    }
    // Notifications (no id, or method-bearing) are observed but not awaited.
    if (parsed.method === "turn/completed" || parsed.method === "thread/event") {
      // Track turn completion for shutdown signal.
      if (parsed.method === "turn/completed") {
        turnCompleted = true;
      }
    }
  }
});

let turnCompleted = false;

async function main() {
  // 1. initialize
  const initResult = await send("initialize", {
    clientInfo: { name: "swarm-harness-spike", version: "0.0.1" },
  });
  process.stderr.write(`initialize OK — userAgent: ${initResult.userAgent}\n`);

  // 2. thread/start
  // Note: codex's `isDefault: true` model gpt-5.2-codex is rejected by ChatGPT
  // accounts ("not supported when using Codex with a ChatGPT account"). Pass a
  // ChatGPT-supported model explicitly. gpt-5.4 is broad/everyday-coding tier.
  const threadResult = await send("thread/start", {
    model: "gpt-5.4",
    cwd: REPO_ROOT,
    approvalPolicy: "never", // auto-approve everything for the spike
    sandbox: "danger-full-access",
    experimentalRawEvents: false,
  });
  const threadId = threadResult.thread.id;
  process.stderr.write(`thread/start OK — threadId: ${threadId}, model: ${threadResult.model}\n`);

  // 3. turn/start with a trivial prompt
  await send("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with the single word DONE." }],
  });

  // 4. Wait for turn completion (up to 60s).
  const start = Date.now();
  while (!turnCompleted && Date.now() - start < 60_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!turnCompleted) {
    process.stderr.write("WARNING: turn did not complete within 60s — continuing\n");
  }

  // 5. Wind down: archive the thread to clean up.
  try {
    await send("thread/archive", { threadId });
  } catch (err) {
    process.stderr.write(`thread/archive failed (non-fatal): ${JSON.stringify(err)}\n`);
  }

  proc.stdin.end();
  await new Promise((r) => proc.once("close", r));
  fixture.end();
  process.stderr.write(`\nFixture written: ${FIXTURE_FILE}\n`);
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err instanceof Error ? err.stack : JSON.stringify(err)}\n`);
  proc.kill();
  fixture.end();
  process.exit(1);
});
