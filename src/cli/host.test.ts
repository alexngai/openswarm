import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — isolate runHost from the real host boot / bootstrap / ACP
// wiring so we can assert config threading and signal-driven shutdown.
// ---------------------------------------------------------------------------

const { bootSwarmHostMock, readBootstrapConfigMock, createTeamConnectionMock } =
  vi.hoisted(() => ({
    bootSwarmHostMock: vi.fn(),
    readBootstrapConfigMock: vi.fn(),
    createTeamConnectionMock: vi.fn(),
  }));

vi.mock("../host/boot.js", () => ({ bootSwarmHost: bootSwarmHostMock }));
vi.mock("../host/bootstrap.js", () => ({
  readBootstrapConfig: readBootstrapConfigMock,
}));
vi.mock("../acp/team-connection.js", () => ({
  createTeamConnection: createTeamConnectionMock,
}));

import { runHost } from "./host.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spy on process.once, capturing signal handlers instead of registering them. */
function captureSignalHandlers() {
  const handlers: Record<string, (sig: NodeJS.Signals) => void> = {};
  const spy = vi
    .spyOn(process, "once")
    .mockImplementation((event: string | symbol, handler: (...a: unknown[]) => void) => {
      handlers[String(event)] = handler as (sig: NodeJS.Signals) => void;
      return process;
    });
  return { handlers, spy };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runHost", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bootSwarmHostMock.mockReset();
    readBootstrapConfigMock.mockReset();
    createTeamConnectionMock.mockReset();
    readBootstrapConfigMock.mockReturnValue({ dataDir: "/data/dir" });
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("boots with resolved defaults (bootstrap cwd, workspace-write, map on)", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({ port: 5000 });
    await flush();

    expect(bootSwarmHostMock).toHaveBeenCalledTimes(1);
    const bootArg = bootSwarmHostMock.mock.calls[0]![0] as {
      port: number;
      cwd: string;
      permissionMode: string;
      map: boolean;
      acpFactory: unknown;
    };
    expect(bootArg.port).toBe(5000);
    expect(bootArg.cwd).toBe("/data/dir");
    expect(bootArg.permissionMode).toBe("workspace-write");
    expect(bootArg.map).toBe(true);
    expect(typeof bootArg.acpFactory).toBe("function");

    handlers["SIGTERM"]!("SIGTERM");
    expect(await done).toBe(0);
    spy.mockRestore();
  });

  it("returns 1 and reports to stderr when boot fails", async () => {
    bootSwarmHostMock.mockRejectedValue(new Error("port in use"));

    const code = await runHost({ port: 5001 });

    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("host failed to start: port in use"),
    );
  });

  it("shuts down gracefully on SIGTERM and returns 0", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({ port: 5002 });
    await flush();
    expect(shutdown).not.toHaveBeenCalled();

    handlers["SIGTERM"]!("SIGTERM");
    const code = await done;

    expect(code).toBe(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("SIGTERM received"),
    );
    spy.mockRestore();
  });

  it("also shuts down on SIGINT", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({ port: 5003 });
    await flush();

    handlers["SIGINT"]!("SIGINT");
    expect(await done).toBe(0);
    expect(shutdown).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("honors explicit cwd/host/permissionMode and logs the adapter", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({
      port: 5004,
      host: "0.0.0.0",
      cwd: "/explicit/cwd",
      permissionMode: "read-only",
      adapter: "openhive",
    });
    await flush();

    const bootArg = bootSwarmHostMock.mock.calls[0]![0] as {
      cwd: string;
      host: string;
      permissionMode: string;
    };
    expect(bootArg.cwd).toBe("/explicit/cwd");
    expect(bootArg.host).toBe("0.0.0.0");
    expect(bootArg.permissionMode).toBe("read-only");
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("adapter=openhive"),
    );

    handlers["SIGTERM"]!("SIGTERM");
    expect(await done).toBe(0);
    spy.mockRestore();
  });
});
