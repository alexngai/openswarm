#!/usr/bin/env node
/**
 * codex-app-server-dynamic-tool-spike.mjs — Track B (v0.4 spike).
 *
 * Verifies whether `dynamicTools` on `thread/start` (an experimental Codex
 * App Server API, gated by `capabilities.experimentalApi: true`) lets a
 * host register a custom tool that the codex agent will plan against and
 * invoke mid-turn — and that the host can return a synthetic result that
 * the agent then incorporates into its reply.
 *
 * Test tool:
 *   swarm_ping(content: string) -> string
 *   The host responds with `"pong:" + content`.
 *
 * Test prompt:
 *   "Please call the swarm_ping tool with content='hello' and tell me
 *    exactly what the tool returned."
 *
 * Pass criteria:
 *   1. agent issues `item/tool/call` ServerRequest with tool="swarm_ping"
 *      and arguments containing { content: "hello" }
 *   2. host replies with `{ contentItems: [{type: "inputText", text: "pong:hello"}], success: true }`
 *   3. final agent message contains the substring "pong:hello"
 *   4. turn/completed status === "completed"
 *
 * Output:
 *   test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl
 *   stderr — human-readable progress + final pass/fail summary
 *
 * Usage:
 *   node scripts/codex-app-server-dynamic-tool-spike.mjs [--model MODEL]
 *
 * Prereq:
 *   - codex CLI installed (verified at 0.98.0 minimum)
 *   - codex login completed (ChatGPT auth)
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "fixtures", "codex-app-server");
const FIXTURE_FILE = path.join(FIXTURE_DIR, "dynamic-tool-call-spike.jsonl");

// Default to gpt-5.4 — gpt-5.2-codex is rejected on ChatGPT accounts.
const MODEL = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "gpt-5.4";

await mkdir(FIXTURE_DIR, { recursive: true });
const fixture = createWriteStream(FIXTURE_FILE, { encoding: "utf8" });

function logFixture(direction, message) {
  fixture.write(JSON.stringify({ ts: Date.now(), direction, message }) + "\n");
  const summary = JSON.stringify(message).slice(0, 200);
  process.stderr.write(`[${direction}] ${summary}\n`);
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

function reply(id, result) {
  const msg = { jsonrpc: "2.0", id, result };
  logFixture("client→server (response)", msg);
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

function notify(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  logFixture("client→server (notification)", msg);
  proc.stdin.write(JSON.stringify(msg) + "\n");
}

// State tracking for the pass/fail check.
let toolCallObserved = false;
let toolCallArgsContent = null;
let agentFinalMessage = "";
let turnCompletedStatus = null;
let turnCompleted = false;
let abortReason = null;

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

    // Server-initiated request (has id AND method): respond.
    if (parsed.id !== undefined && parsed.method !== undefined) {
      handleServerRequest(parsed);
      continue;
    }

    // Server response to one of our requests.
    if (parsed.id !== undefined && pending.has(parsed.id)) {
      const { resolve, reject } = pending.get(parsed.id);
      pending.delete(parsed.id);
      if (parsed.error) reject(parsed.error);
      else resolve(parsed.result);
      continue;
    }

    // Notification — track final-message accumulation + turn lifecycle.
    if (parsed.method !== undefined) {
      handleNotification(parsed);
    }
  }
});

function handleServerRequest(req) {
  // Expected: method = "item/tool/call", params = DynamicToolCallParams.
  if (req.method === "item/tool/call") {
    toolCallObserved = true;
    const args = req.params?.arguments ?? {};
    toolCallArgsContent = args.content ?? null;
    process.stderr.write(`>>> dynamic tool call observed: tool=${req.params?.tool} args=${JSON.stringify(args)}\n`);

    // Synthesize a response: pong:<content>
    const responseText = `pong:${toolCallArgsContent ?? "<missing-content>"}`;
    reply(req.id, {
      contentItems: [{ type: "inputText", text: responseText }],
      success: true,
    });
    return;
  }

  // Other server requests we don't expect in this spike — reply with a
  // benign error so the server doesn't hang.
  process.stderr.write(`!!! unexpected server request: ${req.method}\n`);
  reply(req.id, { error: { code: -32601, message: `not handled: ${req.method}` } });
}

function handleNotification(notif) {
  // Accumulate final agent message text.
  if (notif.method === "item/agentMessage/delta") {
    const delta = notif.params?.delta;
    if (typeof delta === "string") agentFinalMessage += delta;
    return;
  }
  if (notif.method === "item/completed") {
    const item = notif.params?.item;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      // Only overwrite if delta accumulator is empty (full snapshot fallback).
      if (agentFinalMessage.length === 0) agentFinalMessage = item.text;
    }
    return;
  }
  if (notif.method === "turn/completed") {
    turnCompletedStatus = notif.params?.turn?.status ?? null;
    turnCompleted = true;
    return;
  }
}

async function main() {
  // 1. initialize WITH experimentalApi capability — required for dynamicTools.
  const initResult = await send("initialize", {
    clientInfo: { name: "swarm-harness-track-b-spike", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  process.stderr.write(`initialize OK — userAgent: ${initResult.userAgent}\n`);

  // initialized notification (per protocol — README §line 88).
  notify("initialized", {});

  // 2. thread/start with one dynamic tool registered.
  const threadResult = await send("thread/start", {
    model: MODEL,
    cwd: REPO_ROOT,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    experimentalRawEvents: false,
    dynamicTools: [
      {
        name: "swarm_ping",
        description:
          "A test tool that echoes 'pong:<content>' back. Use this to verify dynamic tool wiring.",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content to echo back",
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    ],
  });
  const threadId = threadResult.thread.id;
  process.stderr.write(
    `thread/start OK — threadId: ${threadId}, model: ${threadResult.model}\n`,
  );

  // 3. turn/start — explicit ask to call the tool.
  await send("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Please call the swarm_ping tool with content='hello' and tell me exactly what the tool returned.",
      },
    ],
  });

  // 4. Wait for turn completion (up to 120s — leave room for tool round-trip + reply).
  const start = Date.now();
  while (!turnCompleted && !abortReason && Date.now() - start < 120_000) {
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!turnCompleted) {
    process.stderr.write(`!!! TIMEOUT: turn did not complete within 120s. Abort reason: ${abortReason ?? "none"}\n`);
  }

  // 5. Archive thread.
  try {
    await send("thread/archive", { threadId });
  } catch (err) {
    process.stderr.write(`thread/archive failed (non-fatal): ${JSON.stringify(err)}\n`);
  }

  // 6. Wind down + verdict.
  proc.stdin.end();
  await new Promise((r) => proc.once("close", r));
  fixture.end();

  // -- VERDICT --
  process.stderr.write("\n=== Track B Probe Verdict ===\n");
  process.stderr.write(`Tool call observed:        ${toolCallObserved ? "YES" : "NO"}\n`);
  process.stderr.write(`Tool args content:         ${JSON.stringify(toolCallArgsContent)}\n`);
  process.stderr.write(`Turn completed status:     ${turnCompletedStatus ?? "<none>"}\n`);
  process.stderr.write(`Agent final message:       ${JSON.stringify(agentFinalMessage)}\n`);
  process.stderr.write(`Final message contains "pong:hello": ${agentFinalMessage.includes("pong:hello") ? "YES" : "NO"}\n`);

  const passed =
    toolCallObserved &&
    toolCallArgsContent === "hello" &&
    turnCompletedStatus === "completed" &&
    agentFinalMessage.includes("pong:hello");

  process.stderr.write(`\nVERDICT: ${passed ? "PASS (GREEN)" : "FAIL"}\n`);
  process.stderr.write(`Fixture: ${FIXTURE_FILE}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`spike failed: ${err instanceof Error ? err.stack : JSON.stringify(err)}\n`);
  abortReason = String(err);
  proc.kill();
  fixture.end();
  process.exit(2);
});
