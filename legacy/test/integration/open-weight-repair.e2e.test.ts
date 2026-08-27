/**
 * Open-weight tool-call repair — hermetic end-to-end (docs/63).
 *
 * Stands up a real OpenAI-compatible HTTP server (SSE chat completions +
 * `/v1/models`) and drives the COMPILED CLI against it via the `litellm/`
 * route. Nothing is mocked below the CLI boundary: argv → routing →
 * LiteLLMTransportProvider → capability probe → @ai-sdk/openai → the real
 * streaming parser → HardenedNativeEngine → recovery → permission gate →
 * ToolDispatcher → real `glob` tool → headless JSONL.
 *
 * The unit and engine tests use scripted `ProviderEvent`s, which necessarily
 * encode an ASSUMPTION about how the AI SDK behaves on malformed input. This
 * suite is what actually verifies that assumption — in particular that a tool
 * call whose argument JSON never parses is dropped rather than delivered.
 *
 * No network, no credentials, no user state: the server binds 127.0.0.1 on an
 * ephemeral port and config/data dirs are redirected to a temp dir.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const MODEL = "test-open-weight";
const TEST_TIMEOUT = 45_000;

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible server
// ---------------------------------------------------------------------------

/** One streamed turn, expressed as OpenAI chat-completion delta objects. */
type Turn = readonly Record<string, unknown>[];

/** A text-only turn. */
function textTurn(text: string, finish = "stop"): Turn {
  return [
    { delta: { role: "assistant", content: text }, finish_reason: null },
    { delta: {}, finish_reason: finish },
  ];
}

/** A structured tool call, with `args` streamed as a raw JSON string. */
function toolCallTurn(name: string, args: string, id = "call_1"): Turn {
  return [
    {
      delta: {
        role: "assistant",
        tool_calls: [
          { index: 0, id, type: "function", function: { name, arguments: "" } },
        ],
      },
      finish_reason: null,
    },
    {
      delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
      finish_reason: null,
    },
    { delta: {}, finish_reason: "tool_calls" },
  ];
}

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly body?: Record<string, unknown>;
}

class FakeServer {
  readonly requests: CapturedRequest[] = [];
  private turns: Turn[] = [];
  private cursor = 0;
  private server!: http.Server;
  port = 0;

  /** Queue the turns this server will serve, in order. */
  script(turns: readonly Turn[]): void {
    this.turns = [...turns];
    this.cursor = 0;
    this.requests.length = 0;
  }

  get completionRequests(): CapturedRequest[] {
    return this.requests.filter((r) => r.url.includes("/chat/completions"));
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const url = req.url ?? "";
        let body: Record<string, unknown> | undefined;
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            body = undefined;
          }
        }
        this.requests.push({
          method: req.method ?? "GET",
          url,
          ...(body !== undefined ? { body } : {}),
        });

        // Capability probe (docs/63 F1) — advertise a real window, large enough
        // that nothing below accidentally measures compaction.
        //
        // It used to advertise 32k, and `glob` for `*.json` against this repo
        // returns its 1000-line cap, so the fixture's *size in bytes* was the
        // length of the absolute path to the checkout times a thousand. At
        // `/workspace` that fits; at `/Users/<someone>/GitHub/openswarm` it does
        // not, and the run spent two extra round trips compacting — so
        // "dispatches the call and continues the run" failed on a round-trip
        // count while the repair path it exists to test worked perfectly.
        //
        // That reads as a macOS defect and is nothing of the kind: a Linux
        // developer with a deep checkout fails it too. No test here asserts
        // anything about compaction, so the window is the right thing to move;
        // narrowing the pattern would trade a dependency on path length for one
        // on how many files the developer's tree happens to contain.
        if (req.method === "GET" && url.includes("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [{ id: MODEL, object: "model", max_model_len: 200_000 }],
            }),
          );
          return;
        }

        if (!url.includes("/chat/completions")) {
          res.writeHead(404).end("{}");
          return;
        }

        const turn = this.turns[this.cursor++] ?? textTurn("(script exhausted)");
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const choice of turn) {
          const chunk = {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 0,
            model: MODEL,
            choices: [{ index: 0, ...choice }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 0,
            model: MODEL,
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------

let server: FakeServer;
let stateDir: string;

interface CliResult {
  readonly code: number | null;
  readonly events: Array<Record<string, unknown>>;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        CLI,
        "--headless",
        "--model",
        `litellm/${MODEL}`,
        "--permission-mode",
        "read-only",
        "--no-plugins",
        "--no-skills",
        "--no-mcp",
        "--no-hooks",
        ...args,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LITELLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
          LITELLM_API_KEY: "test-key",
          OPENSWARM_CONFIG_DIR: path.join(stateDir, "config"),
          OPENSWARM_DATA_DIR: path.join(stateDir, "data"),
          OPENSWARM_AUTH_DIR: path.join(stateDir, "auth"),
          ...env,
        },
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      const events: Array<Record<string, unknown>> = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          events.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // Non-JSONL noise (banners) — ignore.
        }
      }
      resolve({ code, events, stderr });
    });
  });
}

const eventsOfType = (r: CliResult, type: string) =>
  r.events.filter((e) => e["type"] === type);

beforeAll(async () => {
  expect(fs.existsSync(CLI), `${CLI} must be built (vitest globalSetup)`).toBe(true);
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-repair-e2e-"));
  server = new FakeServer();
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

beforeEach(() => {
  server.script([]);
});

// ---------------------------------------------------------------------------
// Case 3 — the silent one-turn stop
// ---------------------------------------------------------------------------

describe("e2e: tool call emitted as assistant text", () => {
  const HERMES =
    '<tool_call>\n{"name": "glob", "arguments": {"pattern": "*.json"}}\n</tool_call>';

  it(
    "dispatches the call and continues the run",
    async () => {
      server.script([textTurn(`Let me look.\n${HERMES}`), textTurn("All done.")]);
      const result = await runCli(["--max-turns", "4", "list the json files"]);

      const repaired = eventsOfType(result, "tool_call_repaired");
      expect(repaired.length).toBe(1);
      expect(repaired[0]).toMatchObject({
        stage: "recovered_text",
        toolName: "glob",
        format: "hermes",
      });

      // The tool really ran — a real glob against the repo.
      const results = eventsOfType(result, "tool_result");
      expect(results.length).toBe(1);
      expect(results[0]!["isError"]).toBe(false);
      expect(String(results[0]!["content"])).toContain("package.json");

      // Two model round trips: the run did not stop after turn one.
      expect(server.completionRequests.length).toBe(2);
      expect(result.code).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "does not replay the malformed syntax back to the model",
    async () => {
      server.script([textTurn(`Looking.\n${HERMES}`), textTurn("Done.")]);
      await runCli(["--max-turns", "4", "list files"]);

      const second = server.completionRequests[1]!.body as {
        messages: Array<{ role: string; content?: unknown; tool_calls?: unknown }>;
      };
      const assistant = second.messages.find((m) => m.role === "assistant");
      expect(assistant).toBeDefined();
      expect(JSON.stringify(assistant)).not.toContain("<tool_call>");
      // The recovered call is on the assistant message, so the tool result has
      // a partner — message-replay throws otherwise.
      expect(assistant!.tool_calls).toBeDefined();
      expect(second.messages.some((m) => m.role === "tool")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "stops after one turn when repair is disabled",
    async () => {
      server.script([textTurn(`Looking.\n${HERMES}`), textTurn("Done.")]);
      const result = await runCli(["--max-turns", "4", "list files"], {
        OPENSWARM_TOOL_CALL_REPAIR: "0",
      });

      expect(eventsOfType(result, "tool_call_repaired")).toEqual([]);
      expect(eventsOfType(result, "tool_result")).toEqual([]);
      // The regression this whole change exists to prevent.
      expect(server.completionRequests.length).toBe(1);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Case 1 — delivered but mislabelled
// ---------------------------------------------------------------------------

describe("e2e: mislabelled structured tool call", () => {
  it(
    "routes an aliased tool name to the real tool",
    async () => {
      server.script([
        toolCallTurn("list_files", '{"pattern":"*.json"}'),
        textTurn("Done."),
      ]);
      const result = await runCli(["--max-turns", "4", "list files"]);

      expect(eventsOfType(result, "tool_call_repaired")[0]).toMatchObject({
        stage: "delivered",
        toolName: "glob",
        originalName: "list_files",
      });
      expect(eventsOfType(result, "tool_result")[0]!["isError"]).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "unwraps an argument envelope",
    async () => {
      server.script([
        toolCallTurn("glob", '{"arguments":{"pattern":"*.json"}}'),
        textTurn("Done."),
      ]);
      const result = await runCli(["--max-turns", "4", "list files"]);

      const results = eventsOfType(result, "tool_result");
      expect(results[0]!["isError"]).toBe(false);
      expect(String(results[0]!["content"])).toContain("package.json");
    },
    TEST_TIMEOUT,
  );

  it(
    "leaves a well-formed call untouched",
    async () => {
      server.script([toolCallTurn("glob", '{"pattern":"*.json"}'), textTurn("Done.")]);
      const result = await runCli(["--max-turns", "4", "list files"]);

      expect(eventsOfType(result, "tool_call_repaired")).toEqual([]);
      expect(eventsOfType(result, "tool_result")[0]!["isError"]).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// Case 2 — malformed argument JSON. Verifies the SDK assumption directly.
// ---------------------------------------------------------------------------

describe("e2e: unparseable tool-call arguments", () => {
  it(
    "recovers a call whose argument JSON was truncated mid-stream",
    async () => {
      // Truncated exactly as a max_tokens cut would leave it.
      server.script([toolCallTurn("glob", '{"pattern":"*.json"'), textTurn("Done.")]);
      const result = await runCli(["--max-turns", "4", "list files"]);

      const results = eventsOfType(result, "tool_result");
      expect(results.length).toBe(1);
      expect(results[0]!["isError"]).toBe(false);
      expect(String(results[0]!["content"])).toContain("package.json");
      // Whether the SDK drops it (recovered_stream) or hands back a partial
      // (delivered) is its business — repair must cover both.
      const repaired = eventsOfType(result, "tool_call_repaired");
      expect(repaired.length).toBe(1);
      expect(["recovered_stream", "delivered"]).toContain(repaired[0]!["stage"]);
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// F1 / F2 / F3 — the adjacent levers, on the wire
// ---------------------------------------------------------------------------

describe("e2e: capability probe (F1)", () => {
  it(
    "queries /v1/models before the first completion",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "hi"]);

      const probe = server.requests.findIndex(
        (r) => r.method === "GET" && r.url.includes("/models"),
      );
      const firstCompletion = server.requests.findIndex((r) =>
        r.url.includes("/chat/completions"),
      );
      expect(probe).toBeGreaterThanOrEqual(0);
      expect(probe).toBeLessThan(firstCompletion);
    },
    TEST_TIMEOUT,
  );

  it(
    "skips the probe when disabled",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "hi"], { OPENSWARM_CAPABILITY_PROBE: "0" });
      expect(
        server.requests.some((r) => r.method === "GET" && r.url.includes("/models")),
      ).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

describe("e2e: tool-choice lever (F2)", () => {
  it(
    "puts --tool-choice on the wire",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "--tool-choice", "required", "hi"]);
      expect(server.completionRequests[0]!.body!["tool_choice"]).toBe("required");
    },
    TEST_TIMEOUT,
  );

  it(
    "leaves the provider default in place when the lever is unset",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "hi"]);
      // We send nothing; @ai-sdk/openai writes its own "auto" when tools are
      // present. The point is that our lever is absent, not that the field is.
      expect(server.completionRequests[0]!.body!["tool_choice"]).toBe("auto");
    },
    TEST_TIMEOUT,
  );
});

describe("e2e: sampling levers (F3)", () => {
  it(
    "puts --temperature and --top-p on the wire",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli([
        "--max-turns", "1",
        "--temperature", "0.2",
        "--top-p", "0.9",
        "hi",
      ]);
      const body = server.completionRequests[0]!.body!;
      expect(body["temperature"]).toBe(0.2);
      expect(body["top_p"]).toBe(0.9);
    },
    TEST_TIMEOUT,
  );

  it(
    "reads the environment when no flag is passed",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "hi"], { OPENSWARM_TEMPERATURE: "0.1" });
      expect(server.completionRequests[0]!.body!["temperature"]).toBe(0.1);
    },
    TEST_TIMEOUT,
  );

  it(
    "omits sampling params entirely when unset",
    async () => {
      server.script([textTurn("Done.")]);
      await runCli(["--max-turns", "1", "hi"]);
      const body = server.completionRequests[0]!.body!;
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
    },
    TEST_TIMEOUT,
  );
});

// ---------------------------------------------------------------------------
// F5 — one-shot escalation
// ---------------------------------------------------------------------------

describe("e2e: toolChoice escalation (F5)", () => {
  const UNKNOWN =
    '<tool_call>{"name": "summon_unicorn", "arguments": {}}</tool_call>';

  it(
    "forces tool use on the retry, then completes with a real call",
    async () => {
      server.script([
        textTurn(`Thinking.\n${UNKNOWN}`),
        toolCallTurn("glob", '{"pattern":"*.json"}'),
        textTurn("Done."),
      ]);
      const result = await runCli(["--max-turns", "5", "list files"]);

      const infos = eventsOfType(result, "info");
      expect(infos.some((e) => e["method"] === "tool_choice_escalation")).toBe(true);

      // First turn runs on the provider default; only the retry is forced.
      expect(server.completionRequests[0]!.body!["tool_choice"]).toBe("auto");
      expect(server.completionRequests[1]!.body!["tool_choice"]).toBe("required");

      expect(eventsOfType(result, "tool_result")[0]!["isError"]).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "escalates at most once, then reports the misconfiguration",
    async () => {
      server.script([
        textTurn(`Thinking.\n${UNKNOWN}`),
        textTurn(`Still thinking.\n${UNKNOWN}`),
      ]);
      const result = await runCli(["--max-turns", "5", "list files"]);

      const methods = eventsOfType(result, "info").map((e) => e["method"]);
      expect(methods).toEqual(["tool_choice_escalation", "unrecovered_text_tool_call"]);
      expect(server.completionRequests.length).toBe(2);

      const diagnosis = eventsOfType(result, "info").at(-1)!;
      expect(JSON.stringify(diagnosis)).toContain("--tool-call-parser");
    },
    TEST_TIMEOUT,
  );

  it(
    "does not escalate when disabled",
    async () => {
      server.script([textTurn(`Thinking.\n${UNKNOWN}`)]);
      const result = await runCli(["--max-turns", "5", "list files"], {
        OPENSWARM_TOOL_CHOICE_ESCALATION: "0",
      });
      expect(server.completionRequests.length).toBe(1);
      expect(eventsOfType(result, "info").map((e) => e["method"])).toEqual([
        "unrecovered_text_tool_call",
      ]);
    },
    TEST_TIMEOUT,
  );
});
