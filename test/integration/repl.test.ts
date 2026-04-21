/**
 * M2 Phase 10 integration tests — real-subprocess coverage for the
 * `prompt` command path: REPL lifecycle, slash commands, plugin / MCP
 * registration, and hook exit-code branches.
 *
 * These tests spawn `node dist/cli.js prompt --headless ...` with the
 * scripted engine enabled via SWARM_CODER_TEST_SCRIPT. No live API calls.
 *
 * Prereq: `npm run build` — the beforeAll hook runs it automatically.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
} from "vitest";
import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Setup: build dist so subprocess tests use current code.
// ---------------------------------------------------------------------------

beforeAll(() => {
  execSync("npm run build", {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}, 60_000);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO = process.cwd();
const CLI = path.resolve(REPO, "dist/cli.js");
const FIXTURES_DIR = path.resolve(REPO, "test/fixtures");
const WORKER_SCRIPT = path.join(FIXTURES_DIR, "worker-scripts/text-only.json");
const PLUGINS_FIXTURES = path.join(FIXTURES_DIR, "plugins");
const MCP_MOCK = path.join(FIXTURES_DIR, "mcp-mock-server/index.mjs");

// ---------------------------------------------------------------------------
// Small helper: spawn the CLI, capture stdout + stderr, optionally feed stdin.
// ---------------------------------------------------------------------------

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

function runCli(
  args: readonly string[],
  opts: {
    readonly env?: Record<string, string | undefined>;
    readonly stdin?: string;
    readonly cwd?: string;
    readonly timeoutMs?: number;
  } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      ),
      ...Object.fromEntries(
        Object.entries(opts.env ?? {}).filter(
          (e): e is [string, string] => e[1] !== undefined,
        ),
      ),
    };
    // Remove any envs the caller passed as `undefined` (meaning: unset).
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete env[k];
    }

    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? REPO,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`runCli: timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Scenario A — REPL lifecycle (happy path)
//
// Runs `prompt --headless` against ScriptedTestEngine. Expects the text_delta
// and message_stop events to appear in the JSONL stream.
// ---------------------------------------------------------------------------

describe("A: headless prompt lifecycle via scripted engine", () => {
  it("emits text_delta and message_stop events", async () => {
    const res = await runCli(["prompt", "--headless", "hi"], {
      env: { SWARM_CODER_TEST_SCRIPT: WORKER_SCRIPT },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"type":"text_delta"');
    expect(res.stdout).toContain('"type":"message_stop"');

    // Each stdout line that starts with '{' must be valid JSON.
    const lines = res.stdout.split("\n").filter((l) => l.startsWith("{"));
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Scenario B — Plugin-subprocess registration via --dump-tools
//
// Points SWARM_CODER_PLUGINS_DIR at the fixture tree and asks the CLI to
// print its tool list. Asserts that both the shell-plugin echo and the
// node-plugin greet tools appear.
// ---------------------------------------------------------------------------

describe("B: plugin discovery registers shell + node plugin tools", () => {
  it("registers plugin__shell-plugin__echo and plugin__node-plugin__greet", async () => {
    const res = await runCli(
      ["prompt", "--headless", "--dump-tools", "noop"],
      {
        env: {
          SWARM_CODER_TEST_SCRIPT: WORKER_SCRIPT,
          SWARM_CODER_PLUGINS_DIR: PLUGINS_FIXTURES,
          // Isolate from user-level MCP / hooks config during this test.
          SWARM_CODER_CONFIG_DIR: path.join(os.tmpdir(), "swc-empty-config"),
        },
      },
    );
    expect(res.exitCode).toBe(0);
    const tools = JSON.parse(res.stdout.trim().split("\n").pop() ?? "[]") as Array<{
      name: string;
    }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("plugin__shell-plugin__echo");
    expect(names).toContain("plugin__node-plugin__greet");
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Scenario C — MCP tool registration via --dump-tools
//
// Writes a temp `mcp.json` pointed at the mock MCP fixture, sets
// SWARM_CODER_CONFIG_DIR to its parent, and asserts that get_time + echo
// appear in the tool list.
// ---------------------------------------------------------------------------

describe("C: MCP mock server tools register as mcp__mock-mcp__*", () => {
  it("exposes mcp__mock-mcp__get_time and mcp__mock-mcp__echo", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swc-mcp-"));
    try {
      const cfg = {
        mcpServers: {
          "mock-mcp": {
            command: process.execPath,
            args: [MCP_MOCK],
          },
        },
      };
      fs.writeFileSync(path.join(tmp, "mcp.json"), JSON.stringify(cfg));

      const res = await runCli(
        ["prompt", "--headless", "--dump-tools", "--no-plugins", "noop"],
        {
          env: {
            SWARM_CODER_TEST_SCRIPT: WORKER_SCRIPT,
            SWARM_CODER_CONFIG_DIR: tmp,
          },
        },
      );
      expect(res.exitCode).toBe(0);
      const tools = JSON.parse(
        res.stdout.trim().split("\n").pop() ?? "[]",
      ) as Array<{ name: string }>;
      const names = tools.map((t) => t.name);
      expect(names).toContain("mcp__mock-mcp__get_time");
      expect(names).toContain("mcp__mock-mcp__echo");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Scenario D — Tier 0 tools register alongside plugins & MCP
//
// Verifies the dispatcher's Tier 0 baseline still advertises expected tools
// (read_file, write_file, bash, glob_search, grep_search) so the prior
// tiers haven't regressed due to M2 wiring. This is an integration-level
// check that the full runtime assembles correctly.
// ---------------------------------------------------------------------------

describe("D: Tier 0 tools present in dump-tools output", () => {
  it("always registers read_file, write_file, bash, grep, glob", async () => {
    const res = await runCli(
      [
        "prompt",
        "--headless",
        "--dump-tools",
        "--no-plugins",
        "--no-mcp",
        "--no-hooks",
        "--no-skills",
        "noop",
      ],
      { env: { SWARM_CODER_TEST_SCRIPT: WORKER_SCRIPT } },
    );
    expect(res.exitCode).toBe(0);
    const tools = JSON.parse(
      res.stdout.trim().split("\n").pop() ?? "[]",
    ) as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    for (const required of ["read_file", "write_file", "bash", "grep", "glob"]) {
      expect(names).toContain(required);
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario E — Hook deny exit-code branch (exit 2) blocks a tool via the
// dispatcher path.
//
// We can't easily test dispatcher-gated hook denial without the engine
// actually calling a tool. Instead we assert that the runtime successfully
// LOADS a hook config with a matcher; the stderr-logged "hooks loaded from"
// message confirms the config path was resolved (config.ts:156).
// ---------------------------------------------------------------------------

describe("E: hook config resolution emits startup log", () => {
  it("logs 'hooks loaded from' when .swarm-coder/hooks.json is present", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swc-hooks-"));
    try {
      const hooksDir = path.join(tmp, ".swarm-coder");
      fs.mkdirSync(hooksDir, { recursive: true });
      const hooksCfg = {
        PreToolUse: [
          { matcher: "read_file", command: "echo '{}'; exit 0" },
        ],
      };
      fs.writeFileSync(path.join(hooksDir, "hooks.json"), JSON.stringify(hooksCfg));

      const res = await runCli(
        [
          "prompt",
          "--headless",
          "--dump-tools",
          "--no-plugins",
          "--no-mcp",
          "--no-skills",
          "noop",
        ],
        {
          env: { SWARM_CODER_TEST_SCRIPT: WORKER_SCRIPT },
          cwd: tmp,
        },
      );
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toContain("hooks loaded from");
      expect(res.stderr).toContain("1 matchers");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario F — Hook exit-code branches (deny / fail / allow) at the
// dispatcher-runtime level.
//
// We drive HookRuntime.invoke() directly — this is the same path the
// ToolDispatcher uses when the engine calls a tool. The assertion covers
// all three exit-code branches in one test per spec §1.e.
// ---------------------------------------------------------------------------

describe("F: HookRuntime handles allow / deny / fail exit codes", () => {
  it("maps exit 0 → allow, exit 2 → deny, exit 1 → fail", async () => {
    const { HookRuntime } = await import("../../src/hooks/runtime.js");
    const hooksDir = path.resolve(FIXTURES_DIR, "hooks");

    // Allow path.
    const allowRuntime = new HookRuntime({
      PreToolUse: [
        { matcher: "*", command: `bash ${path.join(hooksDir, "allow-hook.sh")}` },
      ],
    });
    const allow = await allowRuntime.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "read_file",
      toolInput: { path: "x" },
    });
    expect(allow.decision).toBe("allow");

    // Deny path.
    const denyRuntime = new HookRuntime({
      PreToolUse: [
        { matcher: "*", command: `bash ${path.join(hooksDir, "deny-hook.sh")}` },
      ],
    });
    const deny = await denyRuntime.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "read_file",
      toolInput: { path: "x" },
    });
    expect(deny.decision).toBe("deny");
    expect(deny.systemMessage).toBe("blocked by policy");

    // Fail path.
    const failRuntime = new HookRuntime({
      PreToolUse: [
        { matcher: "*", command: `bash ${path.join(hooksDir, "fail-hook.sh")}` },
      ],
    });
    const fail = await failRuntime.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "read_file",
      toolInput: { path: "x" },
    });
    expect(fail.decision).toBe("fail");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario G — Dispatcher integration: PreToolUse deny short-circuits a
// Tier 0 tool call end-to-end (covers Tier 2 parity per rev-2 Major M6).
// ---------------------------------------------------------------------------

describe("G: ToolDispatcher PreToolUse deny short-circuits execute()", () => {
  it("returns status=error when PreToolUse returns exit 2", async () => {
    const { ToolDispatcher } = await import("../../src/tools/dispatcher.js");
    const { HookRuntime } = await import("../../src/hooks/runtime.js");
    const { buildTier0Tools } = await import("../../src/tools/tier0/index.js");

    const hooksDir = path.resolve(FIXTURES_DIR, "hooks");
    const runtime = new HookRuntime({
      PreToolUse: [
        {
          matcher: "read_file",
          command: `bash ${path.join(hooksDir, "deny-hook.sh")}`,
        },
      ],
    });
    const dispatcher = new ToolDispatcher({ hooks: runtime });
    for (const t of buildTier0Tools()) dispatcher.register(t);

    const result = await dispatcher.dispatch(
      "read_file",
      { path: "/nonexistent-path-for-deny-test" },
      { cwd: process.cwd() } as import(
        "../../src/tools/types.js"
      ).ToolExecutionContext,
    );
    expect(result.status).toBe("error");
    const msg = (result as { message: string }).message;
    expect(msg).toContain("hook denied");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario H — Hook matcher scope: matcher="bash" does NOT fire for read_file.
// ---------------------------------------------------------------------------

describe("H: hook matcher filters by tool name", () => {
  it("does not deny when matcher is 'bash' but the tool is read_file", async () => {
    const { ToolDispatcher } = await import("../../src/tools/dispatcher.js");
    const { HookRuntime } = await import("../../src/hooks/runtime.js");
    const { buildTier0Tools } = await import("../../src/tools/tier0/index.js");

    const hooksDir = path.resolve(FIXTURES_DIR, "hooks");
    const runtime = new HookRuntime({
      PreToolUse: [
        {
          matcher: "bash",
          command: `bash ${path.join(hooksDir, "deny-hook.sh")}`,
        },
      ],
    });
    const dispatcher = new ToolDispatcher({ hooks: runtime });
    for (const t of buildTier0Tools()) dispatcher.register(t);

    // read_file against a nonexistent path returns an error from the tool
    // itself, NOT a "hook denied" error. That distinction proves the matcher
    // didn't fire.
    const result = await dispatcher.dispatch(
      "read_file",
      { path: "nonexistent-path-hook-scope-test" },
      { cwd: process.cwd() } as import(
        "../../src/tools/types.js"
      ).ToolExecutionContext,
    );
    const msg = (result as { message?: string }).message ?? "";
    expect(msg).not.toContain("hook denied");
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario I — Slash command dispatcher integration: /help lists all 14
// commands. This exercises the dispatcher + registry path without needing
// a TTY or the full REPL.
// ---------------------------------------------------------------------------

describe("I: slash dispatcher /help lists all 14 commands", () => {
  it("produces a message listing every default command", async () => {
    const { buildDefaultRegistry } = await import("../../src/cli/slash/index.js");
    const { dispatchSlashLine } = await import(
      "../../src/cli/slash/dispatcher.js"
    );
    const { createInitialState } = await import("../../src/ui/repl/state.js");

    const registry = buildDefaultRegistry({});
    const state = createInitialState({ permissionMode: "workspace-write" });
    const result = await dispatchSlashLine("/help", state, registry);
    expect(result.kind).toBe("message");
    const text = (result as { text: string }).text;
    // All 14 commands from docs/10-m2-plan.md Phase 3.
    for (const cmd of [
      "/help",
      "/exit",
      "/clear",
      "/status",
      "/cost",
      "/model",
      "/permissions",
      "/resume",
      "/doctor",
      "/tasks",
      "/approve",
      "/deny",
      "/stop",
      "/compact",
    ]) {
      expect(text).toContain(cmd);
    }
  }, 10_000);
});
