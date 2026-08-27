/**
 * Tests for src/cli/team-paths.ts — v0.5 stage 5E follow-up.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import {
  computeTeamPaths,
  shortSockPath,
  teamsBaseDir,
} from "./team-paths.js";

describe("computeTeamPaths", () => {
  let prevXdg: string | undefined;
  let prevTmp: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_RUNTIME_DIR;
    prevTmp = process.env.TMPDIR;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  });

  it("uses XDG_RUNTIME_DIR when set, with all paths under the team dir", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    delete process.env.TMPDIR;
    const paths = computeTeamPaths("alpha");
    expect(paths.dir).toBe("/run/user/1000/openswarm/teams/alpha");
    expect(paths.sockPath).toBe(
      "/run/user/1000/openswarm/teams/alpha/daemon.sock",
    );
    expect(paths.pidPath).toBe(
      "/run/user/1000/openswarm/teams/alpha/daemon.pid",
    );
    expect(paths.eventsPath).toBe(
      "/run/user/1000/openswarm/teams/alpha/events.jsonl",
    );
  });

  it("falls back to TMPDIR when XDG_RUNTIME_DIR is unset", () => {
    delete process.env.XDG_RUNTIME_DIR;
    process.env.TMPDIR = "/tmp/test-tmp";
    const paths = computeTeamPaths("beta");
    expect(paths.dir).toBe("/tmp/test-tmp/openswarm/teams/beta");
  });

  it("keeps the natural socket path when it's under the length limit", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const paths = computeTeamPaths("short");
    expect(paths.sockPath).toBe(
      "/run/user/1000/openswarm/teams/short/daemon.sock",
    );
    // Naturally under 100 chars — no hash fallback expected.
    expect(paths.sockPath.startsWith("/tmp/swh-")).toBe(false);
  });

  it("falls back to /tmp/swh-<hash>.sock when natural path > 100 chars", () => {
    // Force a long base dir to trigger the fallback.
    process.env.XDG_RUNTIME_DIR =
      "/var/folders/xg/4g0d09h14x596z_2q2lqkxlm0000gn/T/runtime-1000";
    const paths = computeTeamPaths("a-fairly-long-team-name-xyz");
    expect(paths.sockPath.length).toBeLessThan(100);
    expect(path.basename(paths.sockPath)).toMatch(/^swh-[a-f0-9]{12}\.sock$/);
    expect(path.dirname(paths.sockPath)).toBe("/tmp");
    // Other files keep their natural location — no length limit there.
    expect(paths.pidPath).toContain("/openswarm/teams/");
    expect(paths.eventsPath).toContain("/openswarm/teams/");
  });

  it("is deterministic — same team name in same env gives same socket path", () => {
    process.env.XDG_RUNTIME_DIR =
      "/var/folders/xg/4g0d09h14x596z_2q2lqkxlm0000gn/T/runtime-1000";
    const a = computeTeamPaths("my-team");
    const b = computeTeamPaths("my-team");
    expect(a.sockPath).toBe(b.sockPath);
  });

  it("different team names produce different short socket paths", () => {
    process.env.XDG_RUNTIME_DIR =
      "/var/folders/xg/4g0d09h14x596z_2q2lqkxlm0000gn/T/runtime-1000";
    const a = computeTeamPaths("team-name-a-long");
    const b = computeTeamPaths("team-name-b-long");
    expect(a.sockPath).not.toBe(b.sockPath);
  });
});

describe("shortSockPath", () => {
  it("produces a 12-hex-char path under /tmp", () => {
    const result = shortSockPath("/some/long/natural/path/daemon.sock");
    expect(result).toMatch(/^\/tmp\/swh-[a-f0-9]{12}\.sock$/);
  });
});

describe("teamsBaseDir", () => {
  let prevXdg: string | undefined;
  let prevTmp: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_RUNTIME_DIR;
    prevTmp = process.env.TMPDIR;
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
  });

  it("returns ${XDG_RUNTIME_DIR}/openswarm/teams when set", () => {
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    expect(teamsBaseDir()).toBe("/run/user/1000/openswarm/teams");
  });

  it("falls back to TMPDIR when XDG_RUNTIME_DIR is unset", () => {
    delete process.env.XDG_RUNTIME_DIR;
    process.env.TMPDIR = "/tmp/x";
    expect(teamsBaseDir()).toBe("/tmp/x/openswarm/teams");
  });
});
