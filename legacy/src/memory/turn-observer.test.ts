import { describe, it, expect, vi, afterEach } from "vitest";
import {
  observeTurnEvents,
  endMemorySession,
  buildStaticSessionSummary,
  type TurnRecord,
} from "./turn-observer.js";
import {
  getMemoryCoordinator,
  resetMemoryCoordinator,
} from "./coordinator.js";
import {
  getArchiveStore,
  resetArchiveStore,
} from "./archive.js";
import type {
  MemoryProvider,
  CompletedTurn,
  CompressionSummary,
  MemoryEntry,
} from "./types.js";
import type { NormalizedEvent, Usage } from "../core/types.js";

const USAGE: Usage = { inputTokens: 1, outputTokens: 1 };

function makeSpyProvider(name = "spy"): MemoryProvider & {
  turns: CompletedTurn[];
  compressions: CompressionSummary[];
  writes: MemoryEntry[];
} {
  const turns: CompletedTurn[] = [];
  const compressions: CompressionSummary[] = [];
  const writes: MemoryEntry[] = [];
  return {
    name,
    capabilities: { enrichment: false, persistence: true, search: false, graph: false },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(true),
    enrichTurn: vi.fn().mockResolvedValue([]),
    onMemoryWrite: async (e) => {
      writes.push(e);
    },
    onTurnComplete: async (t) => {
      turns.push(t);
    },
    onCompress: async (s) => {
      compressions.push(s);
    },
    turns,
    compressions,
    writes,
  };
}

async function* stream(events: NormalizedEvent[]): AsyncGenerator<NormalizedEvent> {
  for (const evt of events) yield evt;
}

async function drain(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const out: NormalizedEvent[] = [];
  for await (const evt of events) out.push(evt);
  return out;
}

/** Let the fire-and-forget hook promises settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await resetMemoryCoordinator();
  resetArchiveStore();
});

describe("observeTurnEvents (Phase 3 B1)", () => {
  it("passes events through unchanged and fires onAfterTurn with tools + final text", async () => {
    const provider = makeSpyProvider();
    await getMemoryCoordinator().register(provider);

    const input: NormalizedEvent[] = [
      { type: "text_delta", text: "thinking… " },
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_start", id: "t2", name: "bash" },
      { type: "message_stop", stopReason: "end_turn", usage: USAGE },
      { type: "text_delta", text: "final answer" },
      { type: "message_stop", stopReason: "end_turn", usage: USAGE },
    ];

    let record: TurnRecord | undefined;
    const seen = await drain(
      observeTurnEvents(stream(input), {
        sessionId: "s-1",
        turnIndex: 2,
        onRecord: (r) => {
          record = r;
        },
      }),
    );
    await flushMicrotasks();

    expect(seen).toEqual(input);
    expect(record).toEqual({
      turnIndex: 2,
      toolsUsed: ["read_file", "bash"],
      summary: "final answer",
    });
    expect(provider.turns).toHaveLength(1);
    expect(provider.turns[0]).toMatchObject({
      sessionId: "s-1",
      turnIndex: 2,
      toolsUsed: ["read_file", "bash"],
      summary: "final answer",
    });
  });

  it("forwards compaction end boundaries to onCompress", async () => {
    const provider = makeSpyProvider();
    await getMemoryCoordinator().register(provider);

    await drain(
      observeTurnEvents(
        stream([
          { type: "compaction", payload: { phase: "begin", trigger: "auto" } },
          {
            type: "compaction",
            payload: { phase: "end", trigger: "auto", compact_metadata: { pre_tokens: 9 } },
          },
        ]),
        { sessionId: "s-2", turnIndex: 0 },
      ),
    );
    await flushMicrotasks();

    expect(provider.compressions).toHaveLength(1);
    expect(provider.compressions[0]!.sessionId).toBe("s-2");
    expect(provider.compressions[0]!.summary).toContain("auto");
  });

  it("fires onAfterTurn even when the consumer stops early", async () => {
    const provider = makeSpyProvider();
    await getMemoryCoordinator().register(provider);

    const observed = observeTurnEvents(
      stream([
        { type: "text_delta", text: "partial" },
        { type: "text_delta", text: " output" },
        { type: "message_stop", stopReason: "end_turn", usage: USAGE },
      ]),
      { sessionId: "s-3", turnIndex: 0 },
    );
    // Consume only the first event, then break (abort/budget-kill shape).
    for await (const evt of observed) {
      void evt;
      break;
    }
    await flushMicrotasks();

    expect(provider.turns).toHaveLength(1);
    expect(provider.turns[0]!.summary).toBe("partial");
  });
});

describe("endMemorySession (Phase 3 B2)", () => {
  it("archives the session and fans the summary out to persistence providers", async () => {
    const provider = makeSpyProvider();
    await getMemoryCoordinator().register(provider);

    await endMemorySession({
      sessionId: "s-4",
      turns: [
        { turnIndex: 0, toolsUsed: ["bash"], summary: "did a thing" },
        { turnIndex: 1, toolsUsed: ["edit_file"], summary: "fixed the bug" },
      ],
    });

    const archived = getArchiveStore().get("s-4");
    expect(archived).not.toBeNull();
    expect(archived!.summary).toContain("fixed the bug");
    expect(archived!.summary).toContain("bash, edit_file");

    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]!.content).toContain("Session s-4 ended");
    expect(provider.writes[0]!.content).toContain("fixed the bug");
    // Providers are shut down after archiving (Q2 semantics).
    expect(provider.shutdown).toHaveBeenCalled();
  });

  it("uses the configured summarizer, falling back to static on failure", async () => {
    const turns: TurnRecord[] = [
      { turnIndex: 0, toolsUsed: [], summary: "static text" },
    ];

    await endMemorySession({
      sessionId: "s-5",
      turns,
      summarize: async () => "subagent summary",
    });
    expect(getArchiveStore().get("s-5")!.summary).toBe("subagent summary");

    await endMemorySession({
      sessionId: "s-6",
      turns,
      summarize: async () => {
        throw new Error("summarizer down");
      },
    });
    expect(getArchiveStore().get("s-6")!.summary).toBe(
      buildStaticSessionSummary(turns),
    );
  });

  it("does nothing for a session with zero turns", async () => {
    const provider = makeSpyProvider();
    await getMemoryCoordinator().register(provider);
    await endMemorySession({ sessionId: "s-7", turns: [] });
    expect(getArchiveStore().get("s-7")).toBeNull();
    expect(provider.shutdown).not.toHaveBeenCalled();
  });

  it("never hangs on a stuck provider (hard timeout)", async () => {
    const provider = makeSpyProvider();
    provider.onMemoryWrite = () => new Promise(() => {}); // never resolves
    await getMemoryCoordinator().register(provider);

    const start = Date.now();
    await endMemorySession({
      sessionId: "s-8",
      turns: [{ turnIndex: 0, toolsUsed: [], summary: "x" }],
      timeoutMs: 50,
    });
    expect(Date.now() - start).toBeLessThan(2_000);
    // The synchronous archive write still landed before the hang.
    expect(getArchiveStore().get("s-8")).not.toBeNull();
  });
});
