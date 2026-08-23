import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  openTeamCheckpoint,
  computeSpecHash,
  parseCheckpoint,
  TEAM_CHECKPOINT_SCHEMA_VERSION,
} from "./team-checkpoint.js";
import type { TeamSpec } from "./team-spec.js";
import { readSnapshot } from "./atomic-snapshot.js";

function makeSpec(overrides?: Partial<TeamSpec>): TeamSpec {
  return {
    name: "demo",
    topology: "fanout",
    members: [
      { id: "a", role: "worker", prompt: "do A" },
      { id: "b", role: "worker", prompt: "do B" },
    ],
    coordination: { completion: { kind: "all" } },
    ...overrides,
  };
}

describe("team-checkpoint", () => {
  let dir: string;
  let cpPath: string;

  beforeEach(async () => {
    dir = path.join(
      os.tmpdir(),
      `team-cp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fsp.mkdir(dir, { recursive: true });
    cpPath = path.join(dir, "checkpoint.json");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("starts fresh when no checkpoint file exists", async () => {
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec: makeSpec() });
    expect(store.resumed).toBe(false);
    expect(store.resumedUnitCount).toBe(0);
    expect(store.isDone("a")).toBe(false);
    await store.close();
  });

  /**
   * The checkpoint is stored inside a checksummed envelope (WP-07), so a test
   * that wants to see the document itself has to unwrap it. Tests assert on the
   * document, not the envelope, except for the two below that pin the envelope.
   */
  async function onDisk(file: string): Promise<Record<string, any>> {
    const read = await readSnapshot<Record<string, any>>(file);
    if (read.kind !== "ok") throw new Error(`not a snapshot: ${read.kind}`);
    return read.data;
  }

  it("stores the checkpoint behind a checksum", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({
      id: "a",
      status: "succeeded",
      output: "result-A",
      agentId: "agent-1",
      sessionId: "sess-1",
      completedAt: 123,
    });
    await store.close();

    const read = await readSnapshot(cpPath);
    expect(read.kind).toBe("ok");
  });

  it("does not resume from a checkpoint whose bytes were altered", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({
      id: "a",
      status: "succeeded",
      output: "result-A",
      agentId: "agent-1",
      sessionId: "sess-1",
      completedAt: 123,
    });
    await store.close();

    // Someone edits a completed unit's output. Under a bare document this reads
    // back as ordinary resume state and the team trusts it.
    const raw = JSON.parse(await fsp.readFile(cpPath, "utf8"));
    raw.data.units[0].output = "tampered";
    await fsp.writeFile(cpPath, JSON.stringify(raw));

    const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(reopened.resumed).toBe(false);
    expect(reopened.isDone("a")).toBe(false);
    await reopened.close();
  });

  it("still resumes from a checkpoint written before it was checksummed", async () => {
    const spec = makeSpec();
    // Exactly what the pre-WP-07 writer produced: the bare document.
    await fsp.writeFile(
      cpPath,
      JSON.stringify({
        schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
        teamName: spec.name,
        topology: spec.topology,
        specHash: computeSpecHash(spec),
        units: [
          {
            id: "a",
            status: "succeeded",
            output: "result-A",
            agentId: "agent-1",
            sessionId: "sess-1",
            completedAt: 123,
          },
        ],
        inFlight: [],
        updatedAt: Date.now(),
      }) + "\n",
    );

    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(store.resumed).toBe(true);
    expect(store.isDone("a")).toBe(true);
    expect(store.get("a")?.output).toBe("result-A");
    await store.close();
  });

  it("persists recorded units atomically and reloads them", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({
      id: "a",
      status: "succeeded",
      output: "result-A",
      agentId: "agent-1",
      sessionId: "sess-1",
      completedAt: 123,
    });
    await store.close();

    const parsed = await onDisk(cpPath);
    expect(parsed.schemaVersion).toBe(TEAM_CHECKPOINT_SCHEMA_VERSION);
    expect(parsed.units).toHaveLength(1);

    // Reopen: should resume with the succeeded unit.
    const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(reopened.resumed).toBe(true);
    expect(reopened.resumedUnitCount).toBe(1);
    expect(reopened.isDone("a")).toBe(true);
    expect(reopened.get("a")?.output).toBe("result-A");
    await reopened.close();
  });

  it("isDone is true only for succeeded units (failed/timeout re-run)", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({ id: "a", status: "succeeded", completedAt: 1 });
    await store.record({ id: "b", status: "failed", completedAt: 2 });
    await store.close();

    const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(reopened.isDone("a")).toBe(true);
    expect(reopened.isDone("b")).toBe(false);
    expect(reopened.resumedUnitCount).toBe(1);
    await reopened.close();
  });

  it("discards a checkpoint when the spec hash changes (auto-resume guard)", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({ id: "a", status: "succeeded", completedAt: 1 });
    await store.close();

    // Edit a member prompt → different spec hash → stale checkpoint ignored.
    const changed = makeSpec({
      members: [
        { id: "a", role: "worker", prompt: "do A DIFFERENTLY" },
        { id: "b", role: "worker", prompt: "do B" },
      ],
    });
    const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec: changed });
    expect(reopened.resumed).toBe(false);
    expect(reopened.isDone("a")).toBe(false);
    await reopened.close();
  });

  it("later record for the same id overwrites the earlier one", async () => {
    const spec = makeSpec();
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await store.record({ id: "a", status: "failed", completedAt: 1 });
    await store.record({ id: "a", status: "succeeded", output: "ok", completedAt: 2 });
    await store.close();

    const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    expect(reopened.isDone("a")).toBe(true);
    expect(reopened.get("a")?.output).toBe("ok");
    await reopened.close();
  });

  it("serializes concurrent record() writes without corrupting the file", async () => {
    const spec = makeSpec({
      members: Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        role: "worker",
        prompt: `p${i}`,
      })),
    });
    const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.record({ id: `t${i}`, status: "succeeded", completedAt: i }),
      ),
    );
    await store.close();

    const parsed = await onDisk(cpPath); // must be valid JSON (no interleaved writes)
    expect(parsed.units).toHaveLength(10);
  });

  describe("in-flight tracking (crash-recovery T2)", () => {
    it("markDispatched persists an in-flight unit; resume re-surfaces it", async () => {
      const spec = makeSpec();
      const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
      await store.markDispatched({
        id: "a",
        sidecarPath: store.sidecarPathFor("a"),
        dispatchedAt: 100,
      });
      await store.close();

      const raw = await onDisk(cpPath);
      expect(raw.inFlight).toHaveLength(1);
      expect(raw.inFlight[0].id).toBe("a");

      // Reopen: "a" was mid-flight (never terminal) → resume candidate.
      const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
      expect(reopened.resumed).toBe(true);
      expect(reopened.resumedInFlightCount).toBe(1);
      expect(reopened.wasInFlight("a")?.sidecarPath).toBe(
        reopened.sidecarPathFor("a"),
      );
      expect(reopened.wasInFlight("b")).toBeUndefined();
      await reopened.close();
    });

    it("a terminal record clears the in-flight marker", async () => {
      const spec = makeSpec();
      const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
      await store.markDispatched({ id: "a", dispatchedAt: 1 });
      await store.record({ id: "a", status: "succeeded", completedAt: 2 });
      await store.close();

      const raw = await onDisk(cpPath);
      expect(raw.inFlight).toHaveLength(0);
      expect(raw.units).toHaveLength(1);

      const reopened = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
      expect(reopened.isDone("a")).toBe(true);
      expect(reopened.wasInFlight("a")).toBeUndefined();
      expect(reopened.resumedInFlightCount).toBe(0);
      await reopened.close();
    });

    it("a succeeded unit is never a resume candidate even if also in inFlight", async () => {
      // Simulate a crash after the terminal write but before the in-flight
      // entry was cleared (belt-and-suspenders: succeeded always wins).
      const spec = makeSpec();
      const raw = JSON.stringify({
        schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
        teamName: spec.name,
        topology: spec.topology,
        specHash: computeSpecHash(spec),
        units: [{ id: "a", status: "succeeded", completedAt: 1 }],
        inFlight: [{ id: "a", dispatchedAt: 1 }],
        updatedAt: 1,
      });
      await fsp.writeFile(cpPath, raw);

      const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec });
      expect(store.isDone("a")).toBe(true);
      expect(store.wasInFlight("a")).toBeUndefined();
      await store.close();
    });

    it("sidecarPathFor is deterministic and sanitizes the unit id", async () => {
      const store = await openTeamCheckpoint({ checkpointPath: cpPath, spec: makeSpec() });
      const p1 = store.sidecarPathFor("a/b:c");
      const p2 = store.sidecarPathFor("a/b:c");
      expect(p1).toBe(p2);
      expect(path.basename(p1)).toBe("a_b_c.session");
      expect(p1.startsWith(path.join(dir, "sessions"))).toBe(true);
      await store.close();
    });
  });

  describe("computeSpecHash", () => {
    it("is stable for equal specs and differs on member changes", () => {
      expect(computeSpecHash(makeSpec())).toBe(computeSpecHash(makeSpec()));
      const changed = makeSpec({
        members: [{ id: "a", role: "worker", prompt: "x" }],
      });
      expect(computeSpecHash(makeSpec())).not.toBe(computeSpecHash(changed));
    });

    it("differs when topology changes", () => {
      expect(computeSpecHash(makeSpec())).not.toBe(
        computeSpecHash(makeSpec({ topology: "pipeline" })),
      );
    });
  });

  describe("parseCheckpoint", () => {
    const expected = {
      teamName: "demo",
      topology: "fanout" as const,
      specHash: computeSpecHash(makeSpec()),
    };

    it("returns null on malformed JSON", () => {
      expect(parseCheckpoint("{not json", expected)).toBeNull();
    });

    it("returns null on schema-version mismatch", () => {
      const raw = JSON.stringify({
        schemaVersion: 999,
        teamName: "demo",
        topology: "fanout",
        specHash: expected.specHash,
        units: [],
        updatedAt: 0,
      });
      expect(parseCheckpoint(raw, expected)).toBeNull();
    });

    it("drops malformed unit entries but keeps valid ones", () => {
      const raw = JSON.stringify({
        schemaVersion: TEAM_CHECKPOINT_SCHEMA_VERSION,
        teamName: "demo",
        topology: "fanout",
        specHash: expected.specHash,
        units: [
          { id: "a", status: "succeeded", completedAt: 1 },
          { id: 42, status: "succeeded" }, // bad id
          { id: "c", status: "bogus" }, // bad status
        ],
        updatedAt: 0,
      });
      const parsed = parseCheckpoint(raw, expected);
      expect(parsed?.units).toHaveLength(1);
      expect(parsed?.units[0]?.id).toBe("a");
    });
  });
});
