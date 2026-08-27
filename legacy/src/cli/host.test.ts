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

import { runHost, buildHubMapUrl, resolveHostMapTarget } from "./host.js";
import type { BootstrapConfig } from "../host/bootstrap.js";

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

  it("derives the outbound MAP target from the bootstrap token when no --map-server", async () => {
    readBootstrapConfigMock.mockReturnValue({
      dataDir: "/data/dir",
      hubUrl: "http://127.0.0.1:7836",
      swarmId: "swarm_TOK",
      onboardToken: "ohk_tok",
    });
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({ port: 5005 });
    await flush();

    const bootArg = bootSwarmHostMock.mock.calls[0]![0] as {
      mapServer: string;
      mapScope: string;
      onboardToken: string;
      swarmId: string;
    };
    const url = new URL(bootArg.mapServer);
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/ws/map");
    expect(url.searchParams.get("swarm_id")).toBe("swarm_TOK");
    expect(url.searchParams.get("token")).toBe("ohk_tok");
    expect(bootArg.mapScope).toBe("swarm:swarm_TOK");
    expect(bootArg.swarmId).toBe("swarm_TOK");

    handlers["SIGTERM"]!("SIGTERM");
    expect(await done).toBe(0);
    spy.mockRestore();
  });

  it("lets an explicit --map-server override the token-derived target", async () => {
    readBootstrapConfigMock.mockReturnValue({
      dataDir: "/data/dir",
      hubUrl: "http://127.0.0.1:7836",
      swarmId: "swarm_TOK",
    });
    const shutdown = vi.fn().mockResolvedValue(undefined);
    bootSwarmHostMock.mockResolvedValue({ shutdown });
    const { handlers, spy } = captureSignalHandlers();

    const done = runHost({ port: 5006, mapServer: "ws://explicit/ws/map" });
    await flush();

    const bootArg = bootSwarmHostMock.mock.calls[0]![0] as { mapServer: string };
    expect(bootArg.mapServer).toBe("ws://explicit/ws/map");

    handlers["SIGTERM"]!("SIGTERM");
    expect(await done).toBe(0);
    spy.mockRestore();
  });
});

describe("buildHubMapUrl", () => {
  it("converts http→ws and appends the /ws/map path", () => {
    expect(buildHubMapUrl("http://127.0.0.1:7836")).toBe("ws://127.0.0.1:7836/ws/map");
  });

  it("converts https→wss", () => {
    expect(buildHubMapUrl("https://hub.example.com")).toBe("wss://hub.example.com/ws/map");
  });

  it("carries swarm_id + token as query params", () => {
    const url = new URL(
      buildHubMapUrl("http://127.0.0.1:7836", { swarmId: "swarm_A", token: "ohk_x" }),
    );
    expect(url.pathname).toBe("/ws/map");
    expect(url.searchParams.get("swarm_id")).toBe("swarm_A");
    expect(url.searchParams.get("token")).toBe("ohk_x");
  });

  it("is idempotent on /ws/map and strips trailing slashes", () => {
    expect(buildHubMapUrl("http://h:1/")).toBe("ws://h:1/ws/map");
    expect(buildHubMapUrl("ws://h:1/ws/map", { swarmId: "s" })).toBe(
      "ws://h:1/ws/map?swarm_id=s",
    );
  });

  it("omits empty params", () => {
    expect(buildHubMapUrl("http://h:1", { swarmId: "", token: "" })).toBe("ws://h:1/ws/map");
  });
});

describe("resolveHostMapTarget", () => {
  const base: BootstrapConfig = { coordinator: false, rehydrate: "coordinators" };

  it("takes an explicit --map-server verbatim (no token derivation)", () => {
    const t = resolveHostMapTarget(
      { ...base, hubUrl: "http://ignored:1", swarmId: "swarm_A" },
      { mapServer: "ws://explicit/ws/map", mapScope: "swarm:custom" },
    );
    expect(t.mapServer).toBe("ws://explicit/ws/map");
    expect(t.mapScope).toBe("swarm:custom");
  });

  it("derives the target from the bootstrap token when no flag is given", () => {
    const t = resolveHostMapTarget(
      { ...base, hubUrl: "http://127.0.0.1:7836", onboardToken: "ohk_x", swarmId: "swarm_A" },
      {},
    );
    const url = new URL(t.mapServer!);
    expect(url.protocol).toBe("ws:");
    expect(url.searchParams.get("swarm_id")).toBe("swarm_A");
    expect(url.searchParams.get("token")).toBe("ohk_x");
    expect(t.mapScope).toBe("swarm:swarm_A");
    expect(t.onboardToken).toBe("ohk_x");
  });

  it("returns no mapServer when there is neither a flag nor a hub URL", () => {
    expect(resolveHostMapTarget(base, {}).mapServer).toBeUndefined();
  });
});
