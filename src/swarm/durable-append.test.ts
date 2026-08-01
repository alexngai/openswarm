/**
 * FX-JOURNAL-009..012 — the append writers commit what they acknowledge
 * (docs/67 `WP-07`).
 *
 * These fixtures are written against measurements rather than against the survey.
 * The survey said the old `createWriteStream` writers acknowledged from a
 * userspace buffer; probed, they do not — the flag is `O_APPEND`, the callback is
 * post-syscall, and an acknowledged line survives `SIGKILL` under both the old
 * writer and this one. A fixture asserting otherwise would have passed for the
 * wrong reason and been read as proof of something it never tested.
 *
 * So FX-JOURNAL-009 pins the boundary that does move things: acknowledged versus
 * not. Killed before the acknowledgement, the old writer left no file at all, and
 * since none of these writers await, that tail is unbounded in practice.
 *
 * What `fsync` buys on top — surviving the machine stopping rather than the
 * process stopping — is deliberately not asserted here. Nothing in a test suite
 * can drop the page cache, and a fixture that claimed to would be theatre.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { openDurableAppend } from "./durable-append.js";

describe("durable append", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "durable-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const lines = async (file: string): Promise<string[]> => {
    const raw = await fsp.readFile(file, "utf8").catch(() => "");
    return raw.split("\n").filter((l) => l !== "");
  };

  /**
   * The crash fixtures below run the writer in a real process and kill it, so they
   * need the compiled module rather than the source vitest is executing. The
   * suite's globalSetup builds it; `OPENSWARM_SKIP_INTEGRATION_BUILD=1` opts out,
   * and the parity gate builds explicitly before these run. Failing loudly here
   * beats a fixture that quietly passes because the child died on an import.
   */
  const compiled = (): string => {
    const mod = path.resolve("dist/swarm/durable-append.js");
    return mod;
  };

  describe("FX-JOURNAL-009 the acknowledgement boundary", () => {
    it("has a compiled module to run in a real process", async () => {
      await expect(fsp.access(compiled())).resolves.toBeUndefined();
    });

    it("is on disk before the write calls back", async () => {
      const file = path.join(dir, "events.jsonl");
      const stream = await openDurableAppend(file);

      await new Promise<void>((resolve) =>
        stream.write(`${JSON.stringify({ seq: 1 })}\n`, () => resolve()),
      );

      // Read through a separate descriptor: this is what the old writer failed,
      // since it acknowledged from a buffer this read cannot see.
      expect(await lines(file)).toEqual(['{"seq":1}']);
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    });

    it("survives a hard kill once acknowledged", async () => {
      const file = path.join(dir, "killed.jsonl");
      const script = path.join(dir, "writer.mjs");
      const mod = compiled();

      // Write, wait for the acknowledgement, then die without unwinding. Nothing
      // gets a chance to flush on the way out, so whatever is in the file is
      // what the write itself committed.
      await fsp.writeFile(
        script,
        `import { openDurableAppend } from ${JSON.stringify(mod)};
const s = await openDurableAppend(${JSON.stringify(file)});
await new Promise((r) => s.write(JSON.stringify({ acknowledged: true }) + "\\n", r));
process.kill(process.pid, "SIGKILL");
`,
      );

      expect(() => execFileSync(process.execPath, [script], { timeout: 30_000 })).toThrow();
      expect(await lines(file)).toEqual(['{"acknowledged":true}']);
    });

    it("loses a write that was never acknowledged", async () => {
      const file = path.join(dir, "unacked.jsonl");
      const script = path.join(dir, "unacked.mjs");
      const mod = compiled();

      // The shape of every caller in the repository: write and move on. This is
      // the tail that a kill takes, and the reason the writers that report on
      // completeness have to flush at a known point rather than trust the queue.
      await fsp.writeFile(
        script,
        `import { openDurableAppend } from ${JSON.stringify(mod)};
const s = await openDurableAppend(${JSON.stringify(file)});
s.write(JSON.stringify({ unacknowledged: true }) + "\n");
process.kill(process.pid, "SIGKILL");
`,
      );

      expect(() => execFileSync(process.execPath, [script], { timeout: 30_000 })).toThrow();
      expect(await lines(file)).toEqual([]);
    });
  });

  describe("FX-JOURNAL-010 two writers on one file", () => {
    it("loses nothing and tears nothing", async () => {
      const file = path.join(dir, "shared.jsonl");
      const a = await openDurableAppend(file);
      const b = await openDurableAppend(file);

      const write = (s: typeof a, tag: string, n: number): Promise<void> =>
        new Promise((resolve) => s.write(`${JSON.stringify({ tag, n })}\n`, () => resolve()));

      const work: Promise<void>[] = [];
      for (let i = 0; i < 200; i++) {
        work.push(write(a, "a", i));
        work.push(write(b, "b", i));
      }
      await Promise.all(work);
      await new Promise<void>((r) => a.end(() => r()));
      await new Promise<void>((r) => b.end(() => r()));

      const got = await lines(file);
      expect(got).toHaveLength(400);
      // Every line is whole: a torn line is the failure mode that also destroys
      // its neighbour, so parseability is the assertion that matters.
      const parsed = got.map((l) => JSON.parse(l) as { tag: string; n: number });
      expect(parsed.filter((p) => p.tag === "a")).toHaveLength(200);
      expect(parsed.filter((p) => p.tag === "b")).toHaveLength(200);
    });

    it("writes the header once even when both writers open at the same time", async () => {
      const file = path.join(dir, "headed.jsonl");
      const header = { kind: "metadata", source: "test" };

      const opened = await Promise.all(
        Array.from({ length: 20 }, () => openDurableAppend(file, { header })),
      );
      for (const s of opened) await s.flush();
      for (const s of opened) await new Promise<void>((r) => s.end(() => r()));

      const got = await lines(file);
      expect(got.filter((l) => l.includes('"metadata"'))).toHaveLength(1);
      expect(got[0]).toContain('"metadata"');
    });

    it("does not write a header into a file that already has content", async () => {
      const file = path.join(dir, "existing.jsonl");
      await fsp.writeFile(file, `${JSON.stringify({ seq: 1 })}\n`);

      const stream = await openDurableAppend(file, { header: { kind: "metadata" } });
      await stream.flush();
      await new Promise<void>((r) => stream.end(() => r()));

      expect(await lines(file)).toEqual(['{"seq":1}']);
    });
  });

  describe("FX-JOURNAL-011 a burst is one commit", () => {
    it("groups writes that arrive together", async () => {
      const file = path.join(dir, "burst.jsonl");
      const stream = await openDurableAppend(file);

      // Queue without awaiting: these arrive while the first write is in flight,
      // so Node hands them over as one batch and they cost one fsync between
      // them. The observable part is that all of them land, in order.
      const acks: Promise<void>[] = [];
      for (let i = 0; i < 500; i++) {
        acks.push(
          new Promise<void>((resolve) => stream.write(`${JSON.stringify({ i })}\n`, () => resolve())),
        );
      }
      await Promise.all(acks);
      await new Promise<void>((r) => stream.end(() => r()));

      const got = await lines(file);
      expect(got).toHaveLength(500);
      expect(got.map((l) => (JSON.parse(l) as { i: number }).i)).toEqual(
        Array.from({ length: 500 }, (_, i) => i),
      );
    });

    it("flush resolves against what was queued before it", async () => {
      const file = path.join(dir, "flushed.jsonl");
      const stream = await openDurableAppend(file);

      for (let i = 0; i < 50; i++) stream.write(`${JSON.stringify({ i })}\n`);
      await stream.flush();

      expect(await lines(file)).toHaveLength(50);
      await new Promise<void>((r) => stream.end(() => r()));
    });
  });

  describe("FX-JOURNAL-012 a failed write is reported, not thrown", () => {
    it("counts the failure and keeps the run alive", async () => {
      const file = path.join(dir, "broken.jsonl");
      const stream = await openDurableAppend(file);

      // Close the descriptor underneath it. Every later write now fails at the
      // syscall, which is the shape of a full disk or a revoked mount.
      await (stream as unknown as { handle: { close(): Promise<void> } }).handle.close();

      await new Promise<void>((resolve) => stream.write(`${JSON.stringify({ a: 1 })}\n`, () => resolve()));

      expect(stream.writeFailures()).toBeGreaterThan(0);
      expect(stream.bytesWritten()).toBe(0);
    });

    it("reports how much it committed, so a caller can tell a short record", async () => {
      const file = path.join(dir, "counted.jsonl");
      const stream = await openDurableAppend(file);

      await new Promise<void>((r) => stream.write(`${JSON.stringify({ a: 1 })}\n`, () => r()));

      expect(stream.writeFailures()).toBe(0);
      expect(stream.bytesWritten()).toBe(Buffer.byteLength('{"a":1}\n'));
      await new Promise<void>((r) => stream.end(() => r()));
    });
  });
});
