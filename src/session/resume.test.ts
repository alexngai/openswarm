/**
 * FX-RESUME-001..010 — engine-agnostic resume through the kernel journal
 * (docs/67 `WP-08`).
 *
 * The fixture that matters most is the one asserting the engine id survives a
 * round trip. Resume did not fail before because the engines refused a
 * mismatched snapshot — that refusal was correct — it failed because the layer
 * above stamped every session `claude-agent-sdk` regardless of what produced it,
 * so the engines were refusing a label rather than a real mismatch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileEventStore } from "../kernel/event-store.js";
import {
  DURABLE_OPT_IN,
  explainRefusal,
  readResumeState,
  recordTurnState,
  resolveLatest,
  resolvePersistence,
} from "./resume.js";
import type { SecureKeyProvider } from "../kernel/storage-policy.js";

let dir: string;
let store: FileEventStore;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "resume-test-"));
  store = new FileEventStore(dir);
});

afterEach(async () => {
  await store.close();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe("recording and reading engine state", () => {
  it("FX-RESUME-001 returns the state the engine recorded", async () => {
    await recordTurnState(store, "s1", {
      engineId: "hardened-native",
      data: { messages: ["one"], turnCount: 1 },
    });

    const state = await readResumeState(store, "s1");
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.snapshot.data).toEqual({ messages: ["one"], turnCount: 1 });
  });

  it("FX-RESUME-002 preserves the engine id rather than assuming one", async () => {
    // The whole defect in one assertion. The previous store hardcoded
    // "claude-agent-sdk" here, which is why the default engine refused its own
    // sessions.
    await recordTurnState(store, "s1", { engineId: "hardened-native", data: {} });

    const state = await readResumeState(store, "s1");
    if (state.kind !== "ok") throw new Error("expected resumable");
    expect(state.snapshot.engineId).toBe("hardened-native");
  });

  it("FX-RESUME-003 resumes from the latest turn, not the first", async () => {
    for (let turn = 1; turn <= 10; turn += 1) {
      await recordTurnState(store, "s1", {
        engineId: "native",
        data: { turnCount: turn },
      });
    }

    const state = await readResumeState(store, "s1");
    if (state.kind !== "ok") throw new Error("expected resumable");
    expect(state.snapshot.data).toEqual({ turnCount: 10 });
    expect(state.turns).toBe(10);
  });

  it("FX-RESUME-004 retains the earliest turn's content after ten turns", async () => {
    // The gate's "restart retains early context". A snapshot that only carried
    // the most recent turn would satisfy FX-RESUME-003 and still lose the
    // conversation, so this asserts the early message is still in what a
    // restart would be handed.
    const messages: string[] = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push(`message ${turn}`);
      await recordTurnState(store, "s1", {
        engineId: "native",
        data: { messages: [...messages] },
      });
    }

    const state = await readResumeState(store, "s1");
    if (state.kind !== "ok") throw new Error("expected resumable");
    expect((state.snapshot.data as { messages: string[] }).messages).toContain("message 1");
  });

  it("FX-RESUME-005 survives a store reopened from disk", async () => {
    await recordTurnState(store, "s1", { engineId: "native", data: { turnCount: 3 } });
    await store.close();

    const reopened = new FileEventStore(dir);
    try {
      const state = await readResumeState(reopened, "s1");
      if (state.kind !== "ok") throw new Error("expected resumable");
      expect(state.snapshot.data).toEqual({ turnCount: 3 });
    } finally {
      await reopened.close();
    }
  });
});

describe("refusing what cannot be resumed", () => {
  it("FX-RESUME-006 refuses a session that was never written", async () => {
    const state = await readResumeState(store, "absent");
    expect(state).toEqual({ kind: "refused", refusal: { reason: "no-such-session" } });
  });

  it("FX-RESUME-007 refuses a session that recorded no engine state", async () => {
    await store.append({ sessionId: "s1", type: "SessionCreated", payload: {} });

    const state = await readResumeState(store, "s1");
    expect(state.kind).toBe("refused");
    if (state.kind !== "refused") return;
    expect(state.refusal.reason).toBe("no-recorded-state");
  });

  it("FX-RESUME-008 refuses a read-only import, and says what it lost", async () => {
    await store.append({
      sessionId: "imported",
      type: "SessionCreated",
      payload: {
        origin: "import",
        sourceKind: "claude-sdk-session",
        sourcePath: "/old/session.json",
        importedAt: 1,
        resumable: true,
        readOnly: true,
        losses: [{ kind: "typed-tool-history", detail: "tool results are prose" }],
        backupPath: "/backup",
      },
    });
    await store.append({
      sessionId: "imported",
      type: "EngineStateRecorded",
      payload: { engineId: "claude-agent-sdk", data: { sessionId: "old" } },
    });

    const state = await readResumeState(store, "imported");
    expect(state.kind).toBe("refused");
    if (state.kind !== "refused") return;
    expect(explainRefusal(state.refusal, "imported")).toContain("typed-tool-history");
  });

  it("FX-RESUME-009 resumes an import that was not marked read-only", async () => {
    // The importer's counterpart to the case above: a native snapshot maps over
    // member for member, so it resumes. This is the assertion that makes the
    // WP-07 importer's "resumable" verdict mean something.
    await store.append({
      sessionId: "imported",
      type: "SessionCreated",
      payload: {
        origin: "import",
        sourceKind: "native-snapshot",
        sourcePath: "/old/native-snapshot.json",
        importedAt: 1,
        resumable: true,
        readOnly: false,
        losses: [],
        backupPath: "/backup",
      },
    });
    await store.append({
      sessionId: "imported",
      type: "EngineStateRecorded",
      payload: { engineId: "native", data: { turnCount: 2 } },
    });

    const state = await readResumeState(store, "imported");
    if (state.kind !== "ok") throw new Error("expected resumable");
    expect(state.snapshot.engineId).toBe("native");
  });
});

describe("resolving the latest session", () => {
  it("FX-RESUME-010 picks the most recently written session", async () => {
    await recordTurnState(store, "older", { engineId: "native", data: { n: 1 } });
    // Ordering is by journal mtime, and two appends inside one filesystem
    // timestamp tick would make the assertion depend on iteration order.
    await fsp.utimes(path.join(dir, "older", "journal.jsonl"), new Date(1000), new Date(1000));
    await recordTurnState(store, "newer", { engineId: "native", data: { n: 2 } });

    expect(await resolveLatest(dir)).toBe("newer");
  });

  it("returns undefined when no sessions have been written", async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "resume-empty-"));
    expect(await resolveLatest(empty)).toBeUndefined();
    expect(await resolveLatest(path.join(empty, "never-created"))).toBeUndefined();
  });

  it("ignores a session directory with no journal in it", async () => {
    await fsp.mkdir(path.join(dir, "half-made"), { recursive: true });
    await recordTurnState(store, "real", { engineId: "native", data: {} });
    expect(await resolveLatest(dir)).toBe("real");
  });
});

describe("where history is allowed to go", () => {
  it("keeps no history by default, and says why", async () => {
    const decision = await resolvePersistence({ workspaceDir: dir });
    expect(decision.kind).toBe("ephemeral");
    // The text comes from the WP-00 policy rather than from this module, so a
    // user reading it learns the actual reason and the actual remedy.
    expect(decision.warning).toContain("ephemeral");
    expect(decision.warning).toContain("key provider");
  });

  it("writes history only for an opt-in that names the tradeoff", async () => {
    const decision = await resolvePersistence({ workspaceDir: dir, optIn: DURABLE_OPT_IN });
    expect(decision.kind).toBe("durable");
    expect(decision.warning).toContain("unencrypted");
  });

  it("does not accept a truthy value as consent", async () => {
    // Enabling unencrypted history should require saying so. "1" is what somebody
    // types when copying the shape of every other flag.
    for (const value of ["1", "true", "yes", "durable"]) {
      const decision = await resolvePersistence({ workspaceDir: dir, optIn: value });
      expect(decision.kind).toBe("ephemeral");
    }
  });

  it("stays ephemeral without warning when ephemeral was asked for", async () => {
    const decision = await resolvePersistence({
      workspaceDir: dir,
      config: { mode: "ephemeral" },
    });
    expect(decision).toEqual({ kind: "ephemeral", warning: "" });
  });

  it("refuses to write plaintext once a key provider exists", async () => {
    // Guards the follow-up. When somebody wires a real provider, this module has
    // to learn to encrypt; failing loudly is the alternative to quietly writing
    // history in the clear on a machine that could have protected it.
    const withKey: SecureKeyProvider = {
      id: "test-keychain",
      getKey: async () => ({ id: "k1", material: new Uint8Array(32) }) as never,
    };
    await expect(
      resolvePersistence({ workspaceDir: dir, keyProvider: withKey }),
    ).rejects.toThrow(/cannot encrypt yet/);
  });
});
