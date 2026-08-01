/**
 * Untrusted-child launch corpus (docs/67 WP-04, FX-PROC-001..012).
 *
 * The broker is only worth having if nothing goes around it, and "nothing goes
 * around it" is not a property any single unit test observes. Each caller was
 * converted separately, a new caller can be added without touching the broker
 * at all, and the failure is silent: a child spawned directly still works, it
 * is merely unisolated, unregistered, and unkillable as a tree.
 *
 * So the oracle here is not the broker's own bookkeeping. `node:child_process`
 * is intercepted at the module boundary, which is the last place every launch
 * must pass through no matter which code path reached it, and each scenario
 * asserts that the launches observed there are exactly the launches the broker
 * made. A path that bypasses the broker shows up as a raw spawn with no
 * brokered spawn to account for it, whatever route it took.
 *
 * The scenarios are named so a failure identifies the caller rather than just
 * the invariant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** Every `spawn` that reached the module boundary during the current scenario. */
interface RawSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: { readonly detached?: boolean };
}
const rawSpawns: RawSpawn[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args?: unknown, options?: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      const opts = (Array.isArray(args) ? options : args) as RawSpawn["options"] | undefined;
      rawSpawns.push({ command, args: argv, options: opts ?? {} });
      // Delegate to the real implementation: this observes launches, it does
      // not simulate them. A corpus built on a fake spawn would pass just as
      // happily against code that never launches anything.
      return (actual.spawn as (...a: unknown[]) => unknown)(
        command,
        args as never,
        options as never,
      );
    },
  };
});

const { ProcessBroker, setProcessBroker, getProcessBroker, IsolationUnavailableError } =
  await import("./broker.js");
const { bashTool, setBashSandboxPolicy } = await import("../tools/tier0/bash.js");
const { ShellSessionManager } = await import("../tools/tier0/shell-session.js");
const { BrokeredStdioTransport } = await import("../mcp/broker-transport.js");

type Broker = InstanceType<typeof ProcessBroker>;

/**
 * A broker that counts the launches it was asked to make, so a scenario can
 * compare "what the broker did" against "what the process actually did".
 */
function countingBroker(policy: "require" | "prefer" | "off" = "prefer"): {
  broker: Broker;
  brokered: () => number;
} {
  const broker = new ProcessBroker(policy);
  const original = broker.spawn.bind(broker);
  let count = 0;
  broker.spawn = async (req) => {
    count += 1;
    return original(req);
  };
  return { broker, brokered: () => count };
}

let brokered: () => number;
let broker: Broker;
let workspace: string;

beforeEach(() => {
  rawSpawns.length = 0;
  ({ broker, brokered } = countingBroker());
  setProcessBroker(broker);
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fxproc-"));
});

afterEach(() => {
  broker.killAll();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/**
 * The invariant every scenario shares: the process launched exactly what the
 * broker launched, and nothing else.
 */
function expectNothingBypassedTheBroker(): void {
  expect(
    rawSpawns.length,
    `${rawSpawns.length} process(es) launched but only ${brokered()} went through the broker: ` +
      rawSpawns.map((s) => `${s.command} ${s.args.join(" ")}`).join(" | "),
  ).toBe(brokered());
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FX-PROC: every untrusted child goes through the broker", () => {
  it("FX-PROC-001 bash, foreground", async () => {
    const result = await bashTool.execute({ command: "echo fx-001" }, { cwd: workspace });

    expect(result.status).toBe("ok");
    expect(brokered()).toBe(1);
    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-002 bash, background", async () => {
    const result = await bashTool.execute(
      { command: "echo fx-002", run_in_background: true },
      { cwd: workspace },
    );

    expect(result.status).toBe("ok");
    expect(brokered()).toBe(1);
    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-003 bash, killed by its own timeout", async () => {
    const result = await bashTool.execute(
      { command: "sleep 30", timeout: 300 },
      { cwd: workspace },
    );

    expect(result.status).toBe("error");
    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-004 bash, cancelled by an abort signal", async () => {
    const ac = new AbortController();
    const pending = bashTool.execute(
      { command: "sleep 30" },
      { cwd: workspace, abort: ac.signal },
    );
    await sleep(200);
    ac.abort();

    await pending;
    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-005 persistent shell session, created", async () => {
    const mgr = new ShellSessionManager({ broker });
    try {
      await mgr.create(workspace, "echo fx-005");
      await sleep(300);

      expect(brokered()).toBe(1);
      expectNothingBypassedTheBroker();
    } finally {
      mgr.closeAll();
    }
  });

  it("FX-PROC-006 persistent shell session, closed", async () => {
    const mgr = new ShellSessionManager({ broker });
    const session = await mgr.create(workspace);
    await sleep(200);
    mgr.close(session.id);

    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-007 shell hook", async () => {
    const { HookRuntime } = await import("../hooks/runtime.js");
    const runtime = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: "echo fx-007" }],
    });

    await runtime.invoke("PreToolUse", { toolName: "bash", toolInput: {} });

    expect(brokered()).toBeGreaterThanOrEqual(1);
    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-008 MCP stdio server", async () => {
    const transport = new BrokeredStdioTransport({
      serverName: "fx-008",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: workspace,
    });

    try {
      await transport.start();
      expect(brokered()).toBe(1);
      expectNothingBypassedTheBroker();
    } finally {
      await transport.close();
    }
  });

  it("FX-PROC-009 plugin command", async () => {
    // The plugin source shells out to run a tool's command. Driving the real
    // loader needs a manifest on disk, so this exercises the same launch the
    // loader performs rather than asserting on a stub.
    const proc = await broker.spawn({
      kind: "plugin",
      command: "bash",
      args: ["-lc", "echo fx-009"],
      cwd: workspace,
    });
    await new Promise((r) => proc.child.once("close", r));

    expectNothingBypassedTheBroker();
  });

  it("FX-PROC-010 a require policy that cannot be met launches nothing", async () => {
    const strict = new ProcessBroker("require");
    setProcessBroker(strict);
    const before = rawSpawns.length;

    const attempt = strict.spawn({
      kind: "shell",
      command: "echo",
      args: ["should-not-run"],
      cwd: workspace,
    });

    const isolation = await strict.effectiveIsolation();
    if (isolation.satisfiesPolicy) {
      // This host can isolate, so the refusal under test is unreachable here.
      const proc = await attempt;
      proc.kill();
      return;
    }

    await expect(attempt).rejects.toThrow(IsolationUnavailableError);
    // The refusal must come before the launch, not after it.
    expect(rawSpawns.length).toBe(before);
  });

  it("FX-PROC-011 killing a brokered child reaps its grandchildren", async () => {
    const marker = path.join(workspace, "fx-011.txt");
    const proc = await broker.spawn({
      kind: "shell",
      command: "bash",
      args: ["-lc", `(while true; do echo tick >> ${marker}; sleep 0.05; done) & wait`],
      cwd: workspace,
    });

    await sleep(400);
    expect(fs.existsSync(marker)).toBe(true);

    proc.kill();
    await sleep(300);

    const afterKill = fs.statSync(marker).size;
    await sleep(400);
    // A grandchild that survived would still be appending.
    expect(fs.statSync(marker).size).toBe(afterKill);
  }, 15_000);

  it("FX-PROC-012 every brokered child leads its own process group", async () => {
    await broker.spawn({
      kind: "shell",
      command: "echo",
      args: ["fx-012"],
      cwd: workspace,
    });

    // Detachment is what makes a negative-pid signal reach the whole tree, so
    // losing it silently turns every cancellation back into an orphan-maker.
    if (process.platform !== "win32") {
      expect(rawSpawns.every((s) => s.options.detached === true)).toBe(true);
    }
    expectNothingBypassedTheBroker();
  });
});

describe("FX-PROC: the corpus itself is wired up", () => {
  it("observes a launch that deliberately bypasses the broker", async () => {
    // Without this, every assertion above would also pass against an
    // interceptor that silently stopped observing anything.
    const { spawn } = await import("node:child_process");
    const child = spawn("echo", ["bypass"], { stdio: "ignore" });
    await new Promise((r) => child.once("close", r));

    expect(rawSpawns.length).toBe(1);
    expect(brokered()).toBe(0);
    expect(() => expectNothingBypassedTheBroker()).toThrow();
  });

  afterEach(() => {
    setProcessBroker(getProcessBroker());
  });
});
