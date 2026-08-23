import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readSessionSidecar, writeSessionSidecar } from "./session-sidecar.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpFile(): string {
  const dir = path.join(os.tmpdir(), `sidecar-${randomUUID()}`);
  dirs.push(dir);
  return path.join(dir, "nested", "lead-session.json");
}

describe("session sidecar", () => {
  it("round-trips a session id, creating parent dirs", () => {
    const file = tmpFile();
    writeSessionSidecar(file, "sess-abc");
    expect(readSessionSidecar(file)).toBe("sess-abc");
  });

  it("returns undefined for a missing file", () => {
    expect(readSessionSidecar(tmpFile())).toBeUndefined();
  });

  it("returns undefined for malformed JSON or a missing sessionId", () => {
    const file = tmpFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "not json");
    expect(readSessionSidecar(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ other: 1 }));
    expect(readSessionSidecar(file)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify({ sessionId: "" }));
    expect(readSessionSidecar(file)).toBeUndefined();
  });

  it("overwrites with the latest id", () => {
    const file = tmpFile();
    writeSessionSidecar(file, "first");
    writeSessionSidecar(file, "second");
    expect(readSessionSidecar(file)).toBe("second");
  });
});
