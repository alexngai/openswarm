/**
 * FX-MIG-SESSION-001 — legacy sessions import, and say what they lost
 * (docs/67 `WP-07`).
 *
 * The assertions are weighted towards refusal and disclosure rather than towards
 * the happy path. An importer that converts everything and reports nothing is easy
 * to write and produces the specific failure this package exists to prevent: a
 * session that looks resumable, resumes, and is missing the tool history the model
 * is about to contradict.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileEventStore } from "../kernel/event-store.js";
import { writeSnapshot } from "../swarm/atomic-snapshot.js";
import {
  ImportError,
  importSession,
  readImportVerdict,
  readLegacySource,
  type LossKind,
} from "./import.js";

describe("legacy session import", () => {
  let dir: string;
  let store: FileEventStore;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "import-"));
    store = new FileEventStore(path.join(dir, "journal"));
  });

  afterEach(async () => {
    await store.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const write = async (name: string, doc: unknown): Promise<string> => {
    const file = path.join(dir, name);
    await fsp.writeFile(file, JSON.stringify(doc));
    return file;
  };

  const nativeSnapshot = (messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]) => ({
    engineId: "native",
    data: { messages, turnCount: 1, compactionCount: 0, cumulativeUsage: { input: 10, output: 20 } },
  });

  const backupDir = (): string => path.join(dir, "backup");
  const opts = () => ({ backupDir: backupDir() });

  describe("recognizing what a file is", () => {
    it("identifies each of the four legacy shapes", async () => {
      const sdk = await write("sdk.json", { engineId: "claude-agent-sdk", data: { sessionId: "abc" } });
      const native = await write("native-snapshot.json", nativeSnapshot());
      const hardened = await write("hardened.json", {
        engineId: "hardened-native",
        data: { messages: [], turnCount: 0, compactionCount: 0, cumulativeUsage: {}, retryStats: { totalRetries: 0, retriesThisTurn: 0 } },
      });
      const checkpoint = await write("checkpoint.json", {
        schemaVersion: 2,
        teamName: "t",
        topology: "fanout",
        specHash: "h",
        units: [],
        inFlight: [],
      });

      expect((await readLegacySource(sdk)).kind).toBe("claude-sdk-session");
      expect((await readLegacySource(native)).kind).toBe("native-snapshot");
      expect((await readLegacySource(hardened)).kind).toBe("hardened-native-snapshot");
      expect((await readLegacySource(checkpoint)).kind).toBe("team-checkpoint");
    });

    it("reads a checksummed snapshot the same as a bare one", async () => {
      // A snapshot written through writeSnapshot is wrapped. The same session
      // must import identically either way, or the WP-07 envelope change would
      // have quietly orphaned everything written after it.
      const bare = await write("bare.json", nativeSnapshot());
      const wrapped = path.join(dir, "wrapped.json");
      await writeSnapshot(wrapped, nativeSnapshot());

      const a = await readLegacySource(bare);
      const b = await readLegacySource(wrapped);
      expect(b.kind).toBe(a.kind);
      expect(b.document).toEqual(a.document);
    });

    it("refuses a checksummed snapshot whose bytes were altered", async () => {
      // Importing is the wrong moment to accept an unverified document: the
      // result outlives the source and stops being comparable against it.
      const file = path.join(dir, "tampered.json");
      await writeSnapshot(file, nativeSnapshot());
      const envelope = JSON.parse(await fsp.readFile(file, "utf8"));
      envelope.data.data.messages = [{ role: "user", content: [{ type: "text", text: "tampered" }] }];
      await fsp.writeFile(file, JSON.stringify(envelope));

      await expect(readLegacySource(file)).rejects.toThrow(/checksum/);
    });

    it("accepts a bare session sidecar", async () => {
      const sidecar = await write("lead-session.json", { sessionId: "xyz" });
      const source = await readLegacySource(sidecar);
      expect(source.kind).toBe("claude-sdk-session");
      expect(source.document).toEqual({ engineId: "claude-agent-sdk", data: { sessionId: "xyz" } });
    });

    it("refuses a file it does not recognize rather than importing an empty session", async () => {
      const junk = await write("junk.json", { hello: "world" });
      await expect(readLegacySource(junk)).rejects.toThrow(ImportError);

      const notJson = path.join(dir, "notjson.json");
      await fsp.writeFile(notJson, "this is not json");
      await expect(readLegacySource(notJson)).rejects.toThrow(/not JSON/);

      await expect(readLegacySource(path.join(dir, "absent.json"))).rejects.toThrow(ImportError);
    });

    it("refuses a snapshot from an engine it has no mapping for", async () => {
      const alien = await write("alien.json", { engineId: "some-future-engine", data: { state: 1 } });
      await expect(readLegacySource(alien)).rejects.toThrow(/unrecognized snapshot/);
    });
  });

  describe("backing up before converting", () => {
    it("copies the source before writing anything", async () => {
      const file = await write("native-snapshot.json", nativeSnapshot());
      const source = await readLegacySource(file);
      const outcome = await importSession(store, source, opts());

      const copied = JSON.parse(await fsp.readFile(outcome.backupPath, "utf8"));
      expect(copied).toEqual(nativeSnapshot());
      // And the original is untouched.
      expect(JSON.parse(await fsp.readFile(file, "utf8"))).toEqual(nativeSnapshot());
    });

    it("does not write a journal record when the backup cannot be taken", async () => {
      const file = await write("native-snapshot.json", nativeSnapshot());
      const source = await readLegacySource(file);

      // A backup directory that cannot be created: the path is a file.
      const blocked = path.join(dir, "blocked");
      await fsp.writeFile(blocked, "");

      await expect(importSession(store, source, { backupDir: blocked })).rejects.toThrow();

      // Nothing was journalled, so the migration can simply be run again.
      expect(await store.lastSeq("native-snapshot")).toBe(0);
    });
  });

  describe("what the import says it lost", () => {
    const kinds = (losses: readonly { kind: LossKind }[]): LossKind[] => losses.map((l) => l.kind);

    it("marks a Claude SDK session read-only, because its history is not ours", async () => {
      const file = await write("sdk.json", { engineId: "claude-agent-sdk", data: { sessionId: "abc" } });
      const outcome = await importSession(store, await readLegacySource(file), opts());

      expect(outcome.resumable).toBe(true);
      expect(outcome.readOnly).toBe(true);
      expect(kinds(outcome.losses)).toContain("typed-tool-history");
      expect(kinds(outcome.losses)).toContain("reasoning-continuity");
    });

    it("keeps a native snapshot resumable and still declares its losses", async () => {
      const file = await write("native-snapshot.json", nativeSnapshot());
      const outcome = await importSession(store, await readLegacySource(file), opts());

      expect(outcome.resumable).toBe(true);
      expect(outcome.readOnly).toBe(false);
      // Resumable is not the same as complete. Attachments and turn boundaries
      // were never in the source and saying so is the point.
      expect(kinds(outcome.losses)).toContain("attachments");
      expect(kinds(outcome.losses)).toContain("turn-boundaries");
    });

    it("does not call an empty snapshot resumable", async () => {
      const file = await write("empty.json", { ...nativeSnapshot([]), engineId: "native" });
      const outcome = await importSession(store, await readLegacySource(file), opts());

      expect(outcome.resumable).toBe(false);
      expect(kinds(outcome.losses)).toContain("typed-tool-history");
    });

    it("carries the message history across verbatim", async () => {
      // ProviderMessage content maps onto ContentPart member for member, so the
      // history has to arrive unchanged. A reformat here would be a silent
      // rewrite of somebody's conversation.
      const messages = [
        { role: "user", content: [{ type: "text", text: "run it" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", signature: "opaque-sig" },
            { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }] },
      ];
      const file = await write("native-snapshot.json", nativeSnapshot(messages));
      const outcome = await importSession(store, await readLegacySource(file), opts());

      const records = [];
      for await (const r of store.read(outcome.sessionId)) records.push(r);
      const state = records.find((r) => r.type === "EngineStateRecorded");
      expect((state?.payload as { data: { messages: unknown[] } }).data.messages).toEqual(messages);
    });
  });

  describe("the verdict survives without the operator", () => {
    it("is readable from the journal alone", async () => {
      const file = await write("sdk.json", { engineId: "claude-agent-sdk", data: { sessionId: "abc" } });
      const outcome = await importSession(store, await readLegacySource(file), opts());

      // A fresh store over the same directory: nothing in memory, nothing the
      // migration printed. Whoever resumes this months later has only the file.
      const reopened = new FileEventStore(path.join(dir, "journal"));
      const verdict = await readImportVerdict(reopened, outcome.sessionId);
      await reopened.close();

      expect(verdict?.readOnly).toBe(true);
      expect(verdict?.sourceKind).toBe("claude-sdk-session");
      expect(verdict?.sourcePath).toBe(file);
      expect(verdict?.losses.length).toBeGreaterThan(0);
    });

    it("says nothing for a session that was not imported", async () => {
      await store.append({ sessionId: "native-session", type: "SessionCreated", payload: { origin: "live" } });
      expect(await readImportVerdict(store, "native-session")).toBeNull();
    });

    it("writes provenance before engine state, so an interrupted import is legible", async () => {
      const file = await write("native-snapshot.json", nativeSnapshot());
      const outcome = await importSession(store, await readLegacySource(file), opts());

      const types: string[] = [];
      for await (const r of store.read(outcome.sessionId)) types.push(r.type);
      expect(types).toEqual(["SessionCreated", "EngineStateRecorded"]);
    });
  });

  describe("state the journal has no shape for", () => {
    it("archives a team checkpoint instead of converting it into an empty session", async () => {
      const checkpoint = {
        schemaVersion: 2,
        teamName: "alpha",
        topology: "fanout",
        specHash: "h",
        units: [{ id: "a", status: "succeeded", output: "done", agentId: "1", sessionId: "s", completedAt: 1 }],
        inFlight: [],
      };
      const file = await write("checkpoint.json", checkpoint);
      const outcome = await importSession(store, await readLegacySource(file), opts());

      expect(outcome.resumable).toBe(false);
      expect(outcome.archivedPath).toBeDefined();
      // The unit outcomes are still there afterwards. This is real work somebody
      // paid for, and it is not a conversation.
      expect(JSON.parse(await fsp.readFile(outcome.archivedPath!, "utf8"))).toEqual(checkpoint);
      // No engine state was invented for it.
      const types: string[] = [];
      for await (const r of store.read(outcome.sessionId)) types.push(r.type);
      expect(types).toEqual(["SessionCreated"]);
    });
  });

  describe("session identity", () => {
    it("imports a Claude session under the id the SDK will resume", async () => {
      const file = await write("sdk.json", { engineId: "claude-agent-sdk", data: { sessionId: "sdk-abc" } });
      const outcome = await importSession(store, await readLegacySource(file), opts());
      expect(outcome.sessionId).toBe("sdk-abc");
    });

    it("honours an explicit id", async () => {
      const file = await write("native-snapshot.json", nativeSnapshot());
      const outcome = await importSession(store, await readLegacySource(file), {
        backupDir: backupDir(),
        sessionId: "chosen",
      });
      expect(outcome.sessionId).toBe("chosen");
      expect(await store.lastSeq("chosen")).toBe(2);
    });
  });
});
