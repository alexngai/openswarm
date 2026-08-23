import { describe, it, expect } from "vitest";
import { ToolAccesses } from "./access.js";
import { ToolScheduler } from "./scheduler.js";

interface Span {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Build a task that records its own [start, end] interval and resolves to its
 * name. Helps assert which tasks overlapped and which serialized.
 */
function timedTask(name: string, delayMs: number, spans: Span[], accesses = ToolAccesses.none()) {
  return {
    accesses,
    start: async () => ({
      result: (async () => {
        const start = Date.now();
        await new Promise<void>((res) => setTimeout(res, delayMs));
        const end = Date.now();
        spans.push({ name, start, end });
        return name;
      })(),
    }),
  };
}

function overlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

describe("ToolScheduler", () => {
  it("runs non-conflicting tasks concurrently", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    const t1 = scheduler.add(timedTask("a", 40, spans, ToolAccesses.readFile("/x")));
    const t2 = scheduler.add(timedTask("b", 40, spans, ToolAccesses.readFile("/y")));
    const t3 = scheduler.add(timedTask("c", 40, spans, ToolAccesses.readFile("/z")));
    await Promise.all([t1, t2, t3]);

    const a = spans.find((s) => s.name === "a")!;
    const b = spans.find((s) => s.name === "b")!;
    const c = spans.find((s) => s.name === "c")!;
    expect(overlap(a, b)).toBe(true);
    expect(overlap(b, c)).toBe(true);
  });

  it("two writes to different files run concurrently (the main win)", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    await Promise.all([
      scheduler.add(timedTask("wa", 40, spans, ToolAccesses.writeFile("/a"))),
      scheduler.add(timedTask("wb", 40, spans, ToolAccesses.writeFile("/b"))),
      scheduler.add(timedTask("wc", 40, spans, ToolAccesses.writeFile("/c"))),
    ]);
    const wa = spans.find((s) => s.name === "wa")!;
    const wb = spans.find((s) => s.name === "wb")!;
    const wc = spans.find((s) => s.name === "wc")!;
    expect(overlap(wa, wb)).toBe(true);
    expect(overlap(wb, wc)).toBe(true);
  });

  it("two writes to the same file serialize in submission order", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    const t1 = scheduler.add(timedTask("w1", 30, spans, ToolAccesses.writeFile("/a")));
    const t2 = scheduler.add(timedTask("w2", 10, spans, ToolAccesses.writeFile("/a")));
    await Promise.all([t1, t2]);
    const w1 = spans.find((s) => s.name === "w1")!;
    const w2 = spans.find((s) => s.name === "w2")!;
    expect(overlap(w1, w2)).toBe(false);
    expect(w2.start).toBeGreaterThanOrEqual(w1.end);
  });

  it("read + write to same file serialize; reader runs first when submitted first", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    const r = scheduler.add(timedTask("r", 25, spans, ToolAccesses.readFile("/a")));
    const w = scheduler.add(timedTask("w", 10, spans, ToolAccesses.writeFile("/a")));
    await Promise.all([r, w]);
    const rs = spans.find((s) => s.name === "r")!;
    const ws = spans.find((s) => s.name === "w")!;
    expect(overlap(rs, ws)).toBe(false);
    expect(ws.start).toBeGreaterThanOrEqual(rs.end);
  });

  it("searchTree blocks writes inside the subtree but not outside", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    const search = scheduler.add(timedTask("search", 30, spans, ToolAccesses.searchTree("/src")));
    const writeInside = scheduler.add(
      timedTask("inside", 10, spans, ToolAccesses.writeFile("/src/a.ts")),
    );
    const writeOutside = scheduler.add(
      timedTask("outside", 10, spans, ToolAccesses.writeFile("/other/b.ts")),
    );
    await Promise.all([search, writeInside, writeOutside]);
    const s = spans.find((x) => x.name === "search")!;
    const inside = spans.find((x) => x.name === "inside")!;
    const outside = spans.find((x) => x.name === "outside")!;
    expect(overlap(s, inside)).toBe(false);
    expect(inside.start).toBeGreaterThanOrEqual(s.end);
    expect(overlap(s, outside)).toBe(true); // ran in parallel
  });

  it("`all` acts as a global barrier — every other task serializes around it", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    // Three reads of unrelated files would normally run in parallel; the `all`
    // task in the middle splits them into "before" and "after".
    const r1 = scheduler.add(timedTask("r1", 20, spans, ToolAccesses.readFile("/a")));
    const bash = scheduler.add(timedTask("bash", 20, spans, ToolAccesses.all()));
    const r2 = scheduler.add(timedTask("r2", 20, spans, ToolAccesses.readFile("/b")));
    await Promise.all([r1, bash, r2]);
    const r1s = spans.find((s) => s.name === "r1")!;
    const bashS = spans.find((s) => s.name === "bash")!;
    const r2s = spans.find((s) => s.name === "r2")!;
    expect(overlap(r1s, bashS)).toBe(false);
    expect(overlap(bashS, r2s)).toBe(false);
    expect(bashS.start).toBeGreaterThanOrEqual(r1s.end);
    expect(r2s.start).toBeGreaterThanOrEqual(bashS.end);
  });

  it("synchronous throw from start() rejects the task's promise without stalling siblings", async () => {
    const scheduler = new ToolScheduler<string>();
    const spans: Span[] = [];
    const failing = scheduler.add({
      accesses: ToolAccesses.none(),
      start: async () => {
        throw new Error("boom");
      },
    });
    const sibling = scheduler.add(timedTask("ok", 10, spans));

    await expect(failing).rejects.toThrow("boom");
    await expect(sibling).resolves.toBe("ok");
  });
});
