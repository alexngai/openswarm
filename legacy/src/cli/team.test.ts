/**
 * team.test.ts — argv parsing + dispatch coverage for topology/team commands.
 *
 * Scope:
 *   - argv parsing for `topology <kind> --spec <path>`.
 *   - argv parsing for `team send/list/stop/kill`.
 *   - --ecosystem auto-enables MAP url.
 *   - committee/critic-loop are currently rejected by the parser.
 *   - runTopology happy path: builds a TeamSpec, overrides topology, calls
 *     orch.runTeam(), and writes results.
 *   - runTeamSend/List/Stop/Kill daemon RPC clients (socket discovery,
 *     error paths, response handling).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { parseArgv } from "./argv.js";
import {
  runTopology,
  runTeamSend,
  runTeamList,
  runTeamStatus,
  runTeamStop,
  runTeamKill,
} from "./team.js";
import { computeTeamPaths } from "./team-paths.js";

// ---------------------------------------------------------------------------
// argv parsing — topology subcommand
// ---------------------------------------------------------------------------

describe("parseArgv: topology", () => {
  it("topology fanout --spec ./spec.json → topology kind", () => {
    const result = parseArgv([
      "topology",
      "fanout",
      "--spec",
      "./spec.json",
    ]);
    expect(result).toMatchObject({
      kind: "topology",
      topologyKind: "fanout",
      specPath: "./spec.json",
    });
  });

  it("topology pipeline --spec=./spec.json (equals form) parses", () => {
    const result = parseArgv(["topology", "pipeline", "--spec=./spec.json"]);
    expect(result).toMatchObject({
      kind: "topology",
      topologyKind: "pipeline",
      specPath: "./spec.json",
    });
  });

  it("topology peer-team propagates concurrency / output / permission-mode", () => {
    const result = parseArgv([
      "topology",
      "peer-team",
      "--spec",
      "./team.json",
      "--concurrency",
      "4",
      "--output",
      "/tmp/topo.jsonl",
      "--permission-mode",
      "read-only",
    ]);
    if (result.kind !== "topology") throw new Error("expected topology");
    expect(result.topologyKind).toBe("peer-team");
    expect(result.specPath).toBe("./team.json");
    expect(result.concurrency).toBe(4);
    expect(result.output).toBe("/tmp/topo.jsonl");
    expect(result.permissionMode).toBe("read-only");
  });

  it("topology coordinator propagates --max-tokens and --max-cost-usd", () => {
    const result = parseArgv([
      "topology",
      "coordinator",
      "--spec",
      "./spec.json",
      "--max-tokens",
      "10000",
      "--max-cost-usd",
      "1.5",
    ]);
    if (result.kind !== "topology") throw new Error("expected topology");
    expect(result.maxTokens).toBe(10000);
    expect(result.maxCostUsd).toBe(1.5);
  });

  it("topology propagates --model as the default member model", () => {
    const result = parseArgv([
      "topology",
      "pipeline",
      "--spec",
      "./spec.json",
      "--model",
      "litellm/qwen3.6-35b-a3b",
    ]);
    if (result.kind !== "topology") throw new Error("expected topology");
    expect(result.model).toBe("litellm/qwen3.6-35b-a3b");
  });

  it("topology propagates --trace-output", () => {
    const result = parseArgv([
      "topology",
      "pipeline",
      "--spec",
      "./spec.json",
      "--trace-output",
      "/tmp/topology.trace.jsonl",
    ]);
    if (result.kind !== "topology") throw new Error("expected topology");
    expect(result.traceOutput).toBe("/tmp/topology.trace.jsonl");
  });

  it("topology fanout --spec ./spec.json --map ws://x:9 sets mapUrl", () => {
    const result = parseArgv([
      "topology",
      "fanout",
      "--spec",
      "./spec.json",
      "--map",
      "ws://x:9",
    ]);
    if (result.kind !== "topology") throw new Error("expected topology");
    expect(result.mapUrl).toBe("ws://x:9");
  });

  it("topology committee parses like the other kinds", () => {
    const result = parseArgv(["topology", "committee", "--spec", "./s.json"]);
    expect(result).toMatchObject({
      kind: "topology",
      topologyKind: "committee",
      specPath: "./s.json",
    });
  });

  it("topology critic-loop parses like the other kinds", () => {
    const result = parseArgv(["topology", "critic-loop", "--spec", "./s.json"]);
    expect(result).toMatchObject({
      kind: "topology",
      topologyKind: "critic-loop",
      specPath: "./s.json",
    });
  });

  it("topology accepts ecosystem adapter flags", () => {
    const result = parseArgv([
      "topology",
      "peer-team",
      "--spec",
      "./s.json",
      "--git-cascade",
      "--cleanup-worktrees",
      "--agent-inbox",
      "--opentasks-socket",
      "/tmp/ot.sock",
    ]);
    expect(result).toMatchObject({
      kind: "topology",
      gitCascade: true,
      cleanupWorktrees: true,
      agentInbox: true,
      opentasks: true,
      opentasksSocket: "/tmp/ot.sock",
    });
  });

  it("topology defaults adapter flags to off", () => {
    const result = parseArgv(["topology", "fanout", "--spec", "./s.json"]);
    expect(result).toMatchObject({
      kind: "topology",
      gitCascade: false,
      cleanupWorktrees: false,
      agentInbox: false,
      opentasks: false,
    });
  });

  it("team start accepts ecosystem adapter flags", () => {
    const result = parseArgv([
      "team",
      "start",
      "review-team",
      "--git-cascade",
      "--agent-inbox",
    ]);
    expect(result).toMatchObject({
      kind: "team-start",
      template: "review-team",
      gitCascade: true,
      agentInbox: true,
      opentasks: false,
      cleanupWorktrees: false,
    });
  });

  it("topology with unknown kind errors with a helpful list", () => {
    const result = parseArgv(["topology", "circus", "--spec", "./s.json"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("unknown topology kind"),
    });
  });

  it("topology without a kind errors", () => {
    const result = parseArgv(["topology"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("topology requires a kind"),
    });
  });

  it("topology fanout without --spec errors", () => {
    const result = parseArgv(["topology", "fanout"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("topology requires --spec"),
    });
  });

  it("--spec without a value errors", () => {
    const result = parseArgv(["topology", "fanout", "--spec"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--spec requires a value"),
    });
  });
});

// ---------------------------------------------------------------------------
// argv parsing — team send/list/stop/kill
// ---------------------------------------------------------------------------

describe("parseArgv: team send/list/stop/kill", () => {
  it("team send <name> <prompt> → team-send", () => {
    const result = parseArgv(["team", "send", "my-team", "do thing"]);
    expect(result).toMatchObject({
      kind: "team-send",
      name: "my-team",
      prompt: "do thing",
    });
  });

  it("team send joins multi-token prompts", () => {
    const result = parseArgv(["team", "send", "team-a", "hello", "world"]);
    if (result.kind !== "team-send") throw new Error("expected team-send");
    expect(result.prompt).toBe("hello world");
  });

  it("team send without a name errors", () => {
    const result = parseArgv(["team", "send"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team send requires a team name"),
    });
  });

  it("team send without a prompt errors", () => {
    const result = parseArgv(["team", "send", "my-team"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team send requires a prompt"),
    });
  });

  it("team list → team-list", () => {
    const result = parseArgv(["team", "list"]);
    expect(result).toEqual({ kind: "team-list" });
  });

  it("team stop <name> → team-stop", () => {
    const result = parseArgv(["team", "stop", "my-team"]);
    expect(result).toMatchObject({ kind: "team-stop", name: "my-team" });
  });

  it("team stop without a name errors", () => {
    const result = parseArgv(["team", "stop"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team stop requires a team name"),
    });
  });

  it("team kill <name> → team-kill", () => {
    const result = parseArgv(["team", "kill", "my-team"]);
    expect(result).toMatchObject({ kind: "team-kill", name: "my-team" });
  });

  it("team kill without a name errors", () => {
    const result = parseArgv(["team", "kill"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team kill requires a team name"),
    });
  });

  it("team status <name> → team-status", () => {
    const result = parseArgv(["team", "status", "my-team"]);
    expect(result).toMatchObject({ kind: "team-status", name: "my-team" });
  });

  it("team status without a name errors", () => {
    const result = parseArgv(["team", "status"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team status requires a team name"),
    });
  });
});

// ---------------------------------------------------------------------------
// argv parsing — --ecosystem
// ---------------------------------------------------------------------------

describe("parseArgv: --ecosystem", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("--ecosystem on team start sets mapUrl from MAP_URL env", () => {
    const prev = process.env.MAP_URL;
    process.env.MAP_URL = "ws://envhost:1234";
    try {
      const result = parseArgv(["team", "start", "gsd", "--ecosystem"]);
      if (result.kind !== "team-start") throw new Error("expected team-start");
      expect(result.mapUrl).toBe("ws://envhost:1234");
    } finally {
      if (prev !== undefined) process.env.MAP_URL = prev;
      else delete process.env.MAP_URL;
    }
  });

  it("--ecosystem without MAP_URL falls back to ws://localhost:8080", () => {
    const prev = process.env.MAP_URL;
    delete process.env.MAP_URL;
    try {
      const result = parseArgv(["team", "start", "gsd", "--ecosystem"]);
      if (result.kind !== "team-start") throw new Error("expected team-start");
      expect(result.mapUrl).toBe("ws://localhost:8080");
    } finally {
      if (prev !== undefined) process.env.MAP_URL = prev;
    }
  });

  it("explicit --map wins over --ecosystem default", () => {
    const result = parseArgv([
      "team",
      "start",
      "gsd",
      "--ecosystem",
      "--map",
      "ws://explicit:42",
    ]);
    if (result.kind !== "team-start") throw new Error("expected team-start");
    expect(result.mapUrl).toBe("ws://explicit:42");
  });

  it("--ecosystem prints a MAP-only scope note to stderr", () => {
    parseArgv(["team", "start", "gsd", "--ecosystem"]);
    const calls = (stderrSpy.mock.calls as readonly unknown[][]).map(
      (c: readonly unknown[]) => String(c[0]),
    );
    expect(
      calls.some((s: string) => s.includes("--ecosystem enables MAP only")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runTopology — happy path with injected orchestrator stub
// ---------------------------------------------------------------------------

describe("runTopology", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-topo-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a TeamSpec, overrides topology, and calls orchestrator.runTeam", async () => {
    const specPath = path.join(tmpDir, "spec.json");
    // Spec authored as `fanout`; runTopology will override to `peer-team`.
    await fs.writeFile(
      specPath,
      JSON.stringify({
        name: "topo-smoke",
        topology: "fanout",
        members: [
          { role: "alpha", prompt: "hi" },
          { role: "beta", prompt: "hi" },
        ],
        coordination: { completion: { kind: "all" } },
      }),
    );

    const runTeam = vi.fn().mockResolvedValue({
      succeeded: 2,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      aggregateOutput: undefined,
    });

    const exitCode = await runTopology({
      topologyKind: "peer-team",
      specPath,
      permissionMode: "workspace-write",
      concurrency: 2,
      output: path.join(tmpDir, "results.jsonl"),
      orchestrator: { runTeam } as never,
    });

    expect(exitCode).toBe(0);
    expect(runTeam).toHaveBeenCalledTimes(1);
    const passedSpec = runTeam.mock.calls[0]![0] as { topology: string; name: string };
    expect(passedSpec.topology).toBe("peer-team");
    expect(passedSpec.name).toBe("topo-smoke");
  });

  it("applies modelId as the default for members without model", async () => {
    const specPath = path.join(tmpDir, "spec.json");
    await fs.writeFile(
      specPath,
      JSON.stringify({
        name: "topo-model",
        topology: "pipeline",
        members: [
          { role: "executor", prompt: "use default" },
          { role: "reviewer", prompt: "keep explicit", model: "gpt-4o" },
        ],
        coordination: { completion: { kind: "all" } },
      }),
    );

    const runTeam = vi.fn().mockResolvedValue({
      succeeded: 2,
      failed: 0,
      timeout: 0,
      cancelled: 0,
    });

    await runTopology({
      topologyKind: "pipeline",
      specPath,
      permissionMode: "workspace-write",
      concurrency: 1,
      output: path.join(tmpDir, "results.jsonl"),
      modelId: "litellm/qwen3.6-35b-a3b",
      orchestrator: { runTeam } as never,
    });

    const passedSpec = runTeam.mock.calls[0]![0] as {
      members: Array<{ model?: string }>;
    };
    expect(passedSpec.members[0]!.model).toBe("litellm/qwen3.6-35b-a3b");
    expect(passedSpec.members[1]!.model).toBe("gpt-4o");
  });

  it("returns 1 when the topology run reports failures", async () => {
    const specPath = path.join(tmpDir, "spec.json");
    await fs.writeFile(
      specPath,
      JSON.stringify({
        name: "topo-fail",
        topology: "fanout",
        members: [{ role: "x", prompt: "hi" }],
        coordination: { completion: { kind: "all" } },
      }),
    );

    const runTeam = vi.fn().mockResolvedValue({
      succeeded: 0,
      failed: 1,
      timeout: 0,
      cancelled: 0,
    });

    const exitCode = await runTopology({
      topologyKind: "fanout",
      specPath,
      permissionMode: "workspace-write",
      concurrency: 1,
      output: path.join(tmpDir, "results.jsonl"),
      orchestrator: { runTeam } as never,
    });

    expect(exitCode).toBe(1);
  });

  it("returns 2 with a clear stderr message when the spec file is missing", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const exitCode = await runTopology({
        topologyKind: "fanout",
        specPath: path.join(tmpDir, "does-not-exist.json"),
        permissionMode: "workspace-write",
        concurrency: 1,
        output: path.join(tmpDir, "results.jsonl"),
      });
      expect(exitCode).toBe(2);
      const messages = (stderrSpy.mock.calls as readonly unknown[][])
        .map((c: readonly unknown[]) => String(c[0]))
        .join("");
      expect(messages).toContain("failed to read spec file");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns 2 when the spec file is invalid JSON", async () => {
    const specPath = path.join(tmpDir, "bad.json");
    await fs.writeFile(specPath, "{ this is not json ");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const exitCode = await runTopology({
        topologyKind: "fanout",
        specPath,
        permissionMode: "workspace-write",
        concurrency: 1,
        output: path.join(tmpDir, "results.jsonl"),
      });
      expect(exitCode).toBe(2);
      const messages = (stderrSpy.mock.calls as readonly unknown[][])
        .map((c: readonly unknown[]) => String(c[0]))
        .join("");
      expect(messages).toContain("not valid JSON");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("returns 2 when the spec fails schema validation", async () => {
    const specPath = path.join(tmpDir, "invalid.json");
    // Missing required `members` and `coordination`.
    await fs.writeFile(
      specPath,
      JSON.stringify({ name: "x", topology: "fanout" }),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      const exitCode = await runTopology({
        topologyKind: "fanout",
        specPath,
        permissionMode: "workspace-write",
        concurrency: 1,
        output: path.join(tmpDir, "results.jsonl"),
      });
      expect(exitCode).toBe(2);
      const messages = (stderrSpy.mock.calls as readonly unknown[][])
        .map((c: readonly unknown[]) => String(c[0]))
        .join("");
      expect(messages).toContain("failed schema validation");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Stub functions
// ---------------------------------------------------------------------------

describe("team daemon RPC client (v0.5 stage 5E.4)", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tmpRoot: string;
  let prevXdg: string | undefined;
  let prevTmp: string | undefined;

  beforeEach(async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Point the CLI at a fresh tmpdir so tests don't see real running daemons
    // on the dev host. The CLI reads XDG_RUNTIME_DIR first, falling back to
    // TMPDIR (V0.5.Q3); set both to be safe.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "team-cli-test-"));
    prevXdg = process.env.XDG_RUNTIME_DIR;
    prevTmp = process.env.TMPDIR;
    process.env.XDG_RUNTIME_DIR = tmpRoot;
    process.env.TMPDIR = tmpRoot;
  });

  afterEach(async () => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    const fs = await import("node:fs/promises");
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  function stderrText(): string {
    return (stderrSpy.mock.calls as readonly unknown[][])
      .map((c: readonly unknown[]) => String(c[0]))
      .join("");
  }
  function stdoutText(): string {
    return (stdoutSpy.mock.calls as readonly unknown[][])
      .map((c: readonly unknown[]) => String(c[0]))
      .join("");
  }

  it("runTeamSend returns 2 + prints error when no daemon is running", async () => {
    expect(await runTeamSend("nonexistent", "hi")).toBe(2);
    expect(stderrText()).toMatch(/not running|unreachable/);
  });

  it("runTeamList returns 0 + prints '(no running teams)' when teams dir is empty", async () => {
    expect(await runTeamList()).toBe(0);
    expect(stdoutText()).toMatch(/no running teams/);
  });

  it("runTeamStop returns 2 + prints error when no daemon is running", async () => {
    expect(await runTeamStop("nonexistent")).toBe(2);
    expect(stderrText()).toMatch(/not running|unreachable/);
  });

  it("runTeamKill returns 0 with 'was not running' when no daemon is running", async () => {
    expect(await runTeamKill("nonexistent")).toBe(0);
    expect(stdoutText()).toMatch(/was not running/);
  });

  it("runTeamStatus returns 2 + prints error when no daemon is running", async () => {
    expect(await runTeamStatus("nonexistent")).toBe(2);
    expect(stderrText()).toMatch(/not running|unreachable/);
  });

  it("runTeamStatus prints the roster snapshot returned by the daemon", async () => {
    const fsp = await import("node:fs/promises");
    const name = "status-team";
    const paths = computeTeamPaths(name);
    await fsp.mkdir(paths.dir, { recursive: true });

    const statusResult = {
      teamName: name,
      scope: "swarm:status-team:123",
      topology: "coordinator",
      startedAt: 1_700_000_000_000,
      members: [
        { memberId: "m1", role: "lead", agentId: "agent-1", state: "running" },
        { memberId: "m2", role: "worker", agentId: "agent-2", state: "idle" },
      ],
    };

    // Fake daemon: answer one `status` request with the snapshot above.
    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        const req = JSON.parse(buf.slice(0, idx)) as { id: string; method: string };
        socket.write(
          JSON.stringify({
            kind: "response",
            id: req.id,
            ok: true,
            result: statusResult,
          }) + "\n",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.sockPath, resolve));
    try {
      const code = await runTeamStatus(name);
      expect(code).toBe(0);
      const out = stdoutText();
      expect(out).toMatch(/topology=coordinator/);
      expect(out).toMatch(/m1\tlead\tagent-1\trunning/);
      expect(out).toMatch(/m2\tworker\tagent-2\tidle/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("runTeamStatus returns 2 when the daemon returns an error response", async () => {
    const fsp = await import("node:fs/promises");
    const name = "status-err-team";
    const paths = computeTeamPaths(name);
    await fsp.mkdir(paths.dir, { recursive: true });

    const server = net.createServer((socket) => {
      let buf = "";
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const idx = buf.indexOf("\n");
        if (idx < 0) return;
        const req = JSON.parse(buf.slice(0, idx)) as { id: string };
        socket.write(
          JSON.stringify({
            kind: "response",
            id: req.id,
            ok: false,
            error: { code: "internal_error", message: "boom" },
          }) + "\n",
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(paths.sockPath, resolve));
    try {
      const code = await runTeamStatus(name);
      expect(code).toBe(2);
      expect(stderrText()).toMatch(/team status rejected/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
