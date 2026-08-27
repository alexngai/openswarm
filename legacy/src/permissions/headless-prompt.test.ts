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

  /**
   * Found live, not here. Every fixture above hands the reader its own fresh
   * stream and asks once, which is the one shape where borrowing the stream per
   * question behaves the same as owning it. A real run asks twice.
   */
  describe("more than one question on one stdin", () => {
    it("answers the second question from input that arrived with the first", async () => {
      // What an orchestrator does: write the whole batch, once. The reader used
      // to keep the first line and drop the rest, so the second question was
      // answered by nothing at all.
      const input = pipedIn("n\ny\n");

      const first = await readHeadlessApproval(PENDING, { out: captureOut().stream, in: input });
      const second = await readHeadlessApproval(PENDING, { out: captureOut().stream, in: input });

      expect(first.allow).toBe(false);
      expect(second.allow).toBe(true);
    });

    it("denies rather than hanging when stdin ended before the question", async () => {
      // The live failure: a stream that has already ended does not re-emit `end`
      // to a listener attached afterwards, so this never settled — and with stdin
      // closed nothing held the event loop, so the process exited 0 with the turn
      // unfinished and the caller read that as success.
      const input = pipedIn("y\n");
      await readHeadlessApproval(PENDING, { out: captureOut().stream, in: input });

      const after = await Promise.race([
        readHeadlessApproval(PENDING, { out: captureOut().stream, in: input }),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
      ]);

      expect(after).not.toBe("hung");
      expect(typeof after === "object" && after.allow).toBe(false);
    });

    it("keeps answers in order across three questions", async () => {
      const input = pipedIn("y\nn\na\n");
      const out = () => captureOut().stream;

      const a = await readHeadlessApproval(PENDING, { out: out(), in: input });
      const b = await readHeadlessApproval(PENDING, { out: out(), in: input });
      const c = await readHeadlessApproval(PENDING, { out: out(), in: input });

      expect(a.allow).toBe(true);
      expect(b.allow).toBe(false);
      expect(c.allow).toBe(true);
      expect(c.allow && c.alwaysAllow).toBe(true);
    });
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
