import { describe, it, expect } from "vitest";
import { Readable, Writable } from "node:stream";
import { readHeadlessApproval } from "./headless-prompt.js";
import type { PendingPermission } from "../ui/repl/state.js";

const PENDING: PendingPermission = {
  toolName: "bash",
  input: { command: "rm -rf /tmp/foo" },
  currentMode: "read-only",
  requiredPermission: "exec",
  reason: "permission denied: bash requires exec",
};

function pipedIn(data: string): NodeJS.ReadableStream {
  return Readable.from([Buffer.from(data, "utf8")]);
}

function captureOut(): {
  stream: NodeJS.WritableStream;
  read: () => string;
} {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb): void {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return { stream, read: () => Buffer.concat(chunks).toString("utf8") };
}

describe("readHeadlessApproval", () => {
  it("emits a JSONL permission_required line before reading", async () => {
    const out = captureOut();
    const p = readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn("y\n"),
    });
    const decision = await p;
    expect(decision.allow).toBe(true);
    const written = out.read();
    expect(written.endsWith("\n")).toBe(true);
    const [line] = written.split("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.type).toBe("permission_required");
    expect(parsed.tool).toBe("bash");
    expect(parsed.currentMode).toBe("read-only");
    expect(parsed.requiredPermission).toBe("exec");
    expect(parsed.reason).toBe("permission denied: bash requires exec");
  });

  it("approves on 'y\\n' (lowercase)", async () => {
    const out = captureOut();
    const d = await readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn("y\n"),
    });
    expect(d).toEqual({ allow: true });
  });

  it("approves on 'YES\\n' (case-insensitive, trimmed)", async () => {
    const out = captureOut();
    const d = await readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn("  YES  \n"),
    });
    expect(d).toEqual({ allow: true });
  });

  it("denies on EOF (no input)", async () => {
    const out = captureOut();
    const d = await readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn(""),
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/EOF/);
    }
  });

  it("denies on empty line", async () => {
    const out = captureOut();
    const d = await readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn("\n"),
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toMatch(/empty|bash/);
    }
  });

  it("denies on arbitrary input (e.g. 'no\\n')", async () => {
    const out = captureOut();
    const d = await readHeadlessApproval(PENDING, {
      out: out.stream,
      in: pipedIn("no\n"),
    });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.reason).toContain("no");
    }
  });

  it("omits reason field from payload when pending has no reason", async () => {
    const out = captureOut();
    const { reason: _unused, ...bare } = PENDING;
    void _unused;
    await readHeadlessApproval(bare, {
      out: out.stream,
      in: pipedIn("y\n"),
    });
    const [line] = out.read().split("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect("reason" in parsed).toBe(false);
  });
});
