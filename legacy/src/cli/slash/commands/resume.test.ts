import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resumeCommand } from "./resume.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/resume", () => {
  it("returns 'no prior sessions' when the log file is absent", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { sessionLogPath: "/tmp/does-not-exist.log" },
    );
    const res = await resumeCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toBe("no prior sessions found");
    }
  });

  it("lists up to 10 sessions from the log file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "resume-test-"));
    const logPath = path.join(tmp, "sessions.log");
    const ids = Array.from({ length: 12 }, (_, i) => `sess-${i}`);
    fs.writeFileSync(logPath, ids.join("\n") + "\n");

    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { sessionLogPath: logPath },
    );
    const res = await resumeCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      // Latest id first (reverse-sorted)
      expect(res.text).toContain("sess-11");
      expect(res.text).toContain("sess-2");
      // Shows at most 10 (oldest 2 dropped). Use whole-line match to avoid
      // the substring trap (e.g. "sess-11" contains "sess-1").
      const lines = res.text.split("\n").map((l) => l.trim());
      expect(lines).not.toContain("sess-0");
      expect(lines).not.toContain("sess-1");
      expect(lines).toContain("sess-11");
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns a session-id reducer event on valid arg", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["sess-42"],
      {},
    );
    const res = await resumeCommand.execute(ctx);
    expect(res).toEqual({
      kind: "reducer-event",
      event: { type: "session-id", sessionId: "sess-42" },
    });
  });

  it("rejects too many args", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["a", "b"],
      {},
    );
    const res = await resumeCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });
});
