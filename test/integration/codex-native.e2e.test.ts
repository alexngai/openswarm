/**
 * codex-native CLI e2e — spawns the built `dist/cli.js --framework codex-native`
 * and drives a complete agent turn against the real ChatGPT (codex) backend.
 *
 * Gated behind CODEX_LIVE=1 (needs a valid `codex login` token). Seeds a temp
 * credential store from ~/.codex/auth.json and points the subprocess at it via
 * SWARM_HARNESS_AUTH_DIR — so it never touches the user's real ~/.swarm-harness.
 *
 *   CODEX_LIVE=1 npx vitest run test/integration/codex-native.e2e.test.ts
 *
 * This is the one end-to-end path the unit + provider-live tests don't cover:
 * argv → auth gate → runtime → HardenedNativeEngine → codex provider → backend
 * → agent loop → headless JSONL output, all through the compiled binary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeCodexTokens } from "../../src/auth/openai-codex-token-store.js";
import { resolveCodexExpiry } from "../../src/auth/openai-codex-jwt.js";

const live = process.env.CODEX_LIVE === "1";
const CLI = path.resolve(process.cwd(), "dist/cli.js");
let authDir: string;

beforeAll(() => {
  if (!live) return;
  authDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-e2e-"));
  const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "auth.json"), "utf8")) as {
    tokens: { access_token: string; refresh_token: string; account_id: string };
  };
  writeCodexTokens(
    {
      access: auth.tokens.access_token,
      refresh: auth.tokens.refresh_token,
      accountId: auth.tokens.account_id,
      expiresAt: resolveCodexExpiry(auth.tokens.access_token) ?? Date.now() + 3_600_000,
    },
    authDir,
  );
});
afterAll(() => {
  if (authDir) fs.rmSync(authDir, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  events: Array<Record<string, unknown>>;
  stderr: string;
}

function runCli(args: string[], prompt: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, prompt], {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_HARNESS_AUTH_DIR: authDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      const events = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      resolve({ code, events, stderr });
    });
  });
}

const BASE = ["--framework", "codex-native", "--headless", "--output-format", "json"];

describe.runIf(live)("codex-native CLI e2e (live)", () => {
  it("completes a text turn end-to-end through the built binary", async () => {
    const { code, events, stderr } = await runCli(
      [...BASE, "--permission-mode", "read-only"],
      "Reply with exactly: ready",
    );
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent, errEvent ? JSON.stringify(errEvent) : stderr).toBeUndefined();
    expect(code).toBe(0);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => String(e.text ?? ""))
      .join("");
    expect(text.toLowerCase()).toContain("ready");
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  }, 90_000);

  it("runs a tool through the agent loop", async () => {
    const { code, events } = await runCli(
      [...BASE, "--permission-mode", "danger-full-access"],
      "Use a tool to list the files in the current directory, then reply: done",
    );
    expect(code).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.some((e) => e.type === "tool_use_start")).toBe(true);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults.length).toBeGreaterThan(0);
    // A tool must actually EXECUTE — not just be invoked. (A missing dispatcher
    // would surface every tool as isError "tool failed".)
    expect(toolResults.some((e) => e.isError === false)).toBe(true);
    expect(toolResults.every((e) => e.content !== "tool failed")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
  }, 120_000);
});
