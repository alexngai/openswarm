/**
 * RetryingProvider test suite (Phase 4: T4.1-T4.5).
 */

import { describe, it, expect } from "vitest";
import { RetryingProvider } from "./retrying-provider.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "./index.js";
import type { Usage } from "../core/types.js";

// ---------------------------------------------------------------------------
// MockStreamProvider
// ---------------------------------------------------------------------------

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  promptCache: false,
  parallelToolUse: true,
  vision: false,
  reasoning: false,
  maxContextTokens: 200_000,
  maxOutputTokens: 16_000,
};

const DEFAULT_USAGE: Usage = { inputTokens: 10, outputTokens: 5 };

interface MockStreamProviderOpts {
  readonly id?: string;
  readonly scripts?: readonly (readonly ProviderEvent[])[];
  /** When set, throw on these stream() call indices. */
  readonly throwOnCalls?: ReadonlyMap<number, Error>;
}

class MockStreamProvider implements Provider {
  readonly id: string;
  readonly model = "mock" as never;
  readonly capabilities = DEFAULT_CAPS;
  private streamIdx = 0;

  constructor(private readonly opts: MockStreamProviderOpts = {}) {
    this.id = opts.id ?? "mock";
  }

  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const idx = this.streamIdx++;
    const throwErr = this.opts.throwOnCalls?.get(idx);
    if (throwErr !== undefined) throw throwErr;

    const script = this.opts.scripts?.[idx];
    if (script === undefined) {
      throw new Error(`MockStreamProvider: no script for call #${idx}`);
    }
    for (const ev of script) yield ev;
  }
}

async function collectEvents(
  it: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const dummyRequest: ProviderRequest = {
  messages: [],
  model: "mock",
  systemPrompt: "sys",
};

// ---------------------------------------------------------------------------
// T4.1 — Primary succeeds → fallback never called
// ---------------------------------------------------------------------------

describe("RetryingProvider", () => {
  it("T4.1: primary succeeds, fallback never called", async () => {
    const primary = new MockStreamProvider({
      id: "primary",
      scripts: [
        [
          { type: "text-delta", text: "ok" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    const fallback = new MockStreamProvider({
      id: "fallback",
      scripts: [],
    });
    const retrying = new RetryingProvider(primary, fallback, {
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    const events = await collectEvents(retrying.stream(dummyRequest));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "finish"]);
    expect(retrying.id).toBe("retrying(primary)");
  });

  // T4.2 — Primary fails all retries → fallback used
  it("T4.2: primary fails all retries, fallback used", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("fail1"));
    throwMap.set(1, new Error("fail2"));
    const primary = new MockStreamProvider({
      id: "primary",
      scripts: [[], []],
      throwOnCalls: throwMap,
    });
    const fallback = new MockStreamProvider({
      id: "fallback",
      scripts: [
        [
          { type: "text-delta", text: "from fallback" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
    });
    // maxRetries=2 → attempts 0,1,2. switchToFallbackAfter=ceil(2/2)=1.
    // attempt 0: primary throws
    // attempt 1: fallback (switchToFallbackAfter reached)
    const retrying = new RetryingProvider(primary, fallback, {
      maxRetries: 2,
      backoffBaseMs: 10,
    });

    const events = await collectEvents(retrying.stream(dummyRequest));
    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe("from fallback");
  });

  // T4.3 — Primary fails once → retried on primary (not immediately fallback)
  it("T4.3: primary fails once, retried on primary", async () => {
    const throwMap = new Map<number, Error>();
    throwMap.set(0, new Error("transient"));
    const primary = new MockStreamProvider({
      id: "primary",
      scripts: [
        [],
        [
          { type: "text-delta", text: "recovered" },
          { type: "finish", stopReason: "end_turn", usage: DEFAULT_USAGE },
        ],
      ],
      throwOnCalls: throwMap,
    });
    const fallback = new MockStreamProvider({
      id: "fallback",
      scripts: [],
    });
    // maxRetries=3 → switchToFallbackAfter=ceil(3/2)=2
    // attempt 0: primary throws
    // attempt 1: primary succeeds (still below switchToFallbackAfter=2)
    const retrying = new RetryingProvider(primary, fallback, {
      maxRetries: 3,
      backoffBaseMs: 10,
    });

    const events = await collectEvents(retrying.stream(dummyRequest));
    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe("recovered");
  });

  // T4.4 — No fallback configured → error after max retries
  it("T4.4: no fallback, error after max retries", async () => {
    const throwMap = new Map<number, Error>();
    for (let i = 0; i <= 2; i++) throwMap.set(i, new Error("fail"));
    const primary = new MockStreamProvider({
      scripts: [[], [], []],
      throwOnCalls: throwMap,
    });
    const retrying = new RetryingProvider(primary, undefined, {
      maxRetries: 2,
      backoffBaseMs: 10,
    });

    await expect(
      collectEvents(retrying.stream(dummyRequest)),
    ).rejects.toThrow("fail");
  });

  // T4.5 — Fallback also fails → error propagated
  it("T4.5: fallback also fails, error propagated", async () => {
    const primaryThrows = new Map<number, Error>();
    primaryThrows.set(0, new Error("primary-fail"));
    const primary = new MockStreamProvider({
      scripts: [[]],
      throwOnCalls: primaryThrows,
    });
    const fallbackThrows = new Map<number, Error>();
    fallbackThrows.set(0, new Error("fallback-fail"));
    const fallback = new MockStreamProvider({
      scripts: [[]],
      throwOnCalls: fallbackThrows,
    });
    // maxRetries=1 → attempts 0,1. switchToFallbackAfter=1
    // attempt 0: primary throws
    // attempt 1: fallback throws → final throw
    const retrying = new RetryingProvider(primary, fallback, {
      maxRetries: 1,
      backoffBaseMs: 10,
    });

    await expect(
      collectEvents(retrying.stream(dummyRequest)),
    ).rejects.toThrow("fallback-fail");
  });
});
