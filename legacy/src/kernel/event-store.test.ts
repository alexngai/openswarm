import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileEventStore, JournalCorruptError } from "./event-store.js";
import { KERNEL_SCHEMA_VERSION } from "./contracts.js";

describe("FileEventStore", () => {
  let root: string;
  let store: FileEventStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openswarm-journal-"));
    store = new FileEventStore(root);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const journal = (sessionId: string) => path.join(root, sessionId, "journal.jsonl");

  async function drain(sessionId: string) {
    const out = [];
    for await (const record of store.read(sessionId)) out.push(record);
    return out;
  }

  it("assigns gap-free sequences starting at 1", async () => {
    const a = await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
    const b = await store.append({ sessionId: "s1", type: "TurnEnded", payload: {} });

    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.schema).toBe(KERNEL_SCHEMA_VERSION);
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("numbers sessions independently", async () => {
    await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
    const other = await store.append({ sessionId: "s2", type: "TurnStarted", payload: {} });
    expect(other.seq).toBe(1);
  });

  it("reads back committed records in order", async () => {
    await store.append({ sessionId: "s1", type: "TurnStarted", payload: { n: 1 } });
    await store.append({ sessionId: "s1", type: "TurnEnded", payload: { n: 2 } });

    const records = await drain("s1");
    expect(records.map((r) => r.seq)).toEqual([1, 2]);
    expect(records.map((r) => r.type)).toEqual(["TurnStarted", "TurnEnded"]);
    expect(records[1]!.payload).toEqual({ n: 2 });
  });

  it("preserves causationId and omits it when absent", async () => {
    const first = await store.append({ sessionId: "s1", type: "AttemptPrepared", payload: {} });
    const second = await store.append({
      sessionId: "s1",
      type: "AttemptResolved",
      payload: {},
      causationId: first.eventId,
    });

    expect(second.causationId).toBe(first.eventId);
    expect("causationId" in first).toBe(false);
  });

  it("continues numbering after a restart", async () => {
    await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
    await store.append({ sessionId: "s1", type: "TurnEnded", payload: {} });
    await store.close();

    const reopened = new FileEventStore(root);
    try {
      expect(await reopened.lastSeq("s1")).toBe(2);
      const next = await reopened.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
      expect(next.seq).toBe(3);
    } finally {
      await reopened.close();
    }
  });

  it("reports lastSeq 0 for an absent journal and yields nothing", async () => {
    expect(await store.lastSeq("missing")).toBe(0);
    expect(await drain("missing")).toEqual([]);
  });

  it("assigns unique gap-free sequences under concurrent appends", async () => {
    const appends = Array.from({ length: 25 }, () =>
      store.append({ sessionId: "s1", type: "TurnStarted", payload: {} }),
    );
    const seqs = (await Promise.all(appends)).map((r) => r.seq).sort((a, b) => a - b);

    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await drain("s1")).toHaveLength(25);
  });

  describe("crash tolerance", () => {
    it("drops a torn trailing line as never-committed", async () => {
      await store.append({ sessionId: "s1", type: "TurnStarted", payload: { n: 1 } });
      await store.close();

      // A crash mid-append leaves a partial line with no terminating newline.
      // The caller never got an acknowledgement, so it must not be replayed.
      await fs.appendFile(journal("s1"), '{"schema":1,"seq":2,"type":"Turn');

      const reopened = new FileEventStore(root);
      try {
        const records = await drain("s1");
        expect(records).toHaveLength(1);
        expect(records[0]!.seq).toBe(1);
        // The next append reuses the sequence the torn record never claimed.
        expect(await reopened.lastSeq("s1")).toBe(1);
        expect((await reopened.append({ sessionId: "s1", type: "TurnEnded", payload: {} })).seq)
          .toBe(2);
      } finally {
        await reopened.close();
      }
    });

    it("keeps a fully written record that was never read back", async () => {
      // The complementary case: the line is terminated, so it did commit and
      // must survive even though the process died immediately afterwards.
      await store.append({ sessionId: "s1", type: "TurnStarted", payload: { n: 1 } });
      await store.close();

      const raw = await fs.readFile(journal("s1"), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(await new FileEventStore(root).lastSeq("s1")).toBe(1);
    });

    it("rejects damage in the middle of the journal", async () => {
      await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
      await store.append({ sessionId: "s1", type: "TurnEnded", payload: {} });
      await store.close();

      const lines = (await fs.readFile(journal("s1"), "utf8")).split("\n");
      await fs.writeFile(journal("s1"), `${lines[0]}\nnot json\n${lines[1]}\n`);

      await expect(drain("s1")).rejects.toThrow(JournalCorruptError);
    });

    it("rejects a sequence gap rather than skipping it", async () => {
      const first = await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
      await store.close();

      await fs.appendFile(journal("s1"), `${JSON.stringify({ ...first, seq: 7 })}\n`);

      await expect(drain("s1")).rejects.toThrow(/expected seq 2, found 7/);
    });

    it("rejects a schema newer than this reader understands", async () => {
      const first = await store.append({ sessionId: "s1", type: "TurnStarted", payload: {} });
      await store.close();

      await fs.writeFile(
        journal("s1"),
        `${JSON.stringify({ ...first, schema: KERNEL_SCHEMA_VERSION + 1 })}\n`,
      );

      await expect(drain("s1")).rejects.toThrow(/outside the readable range/);
    });
  });
});
