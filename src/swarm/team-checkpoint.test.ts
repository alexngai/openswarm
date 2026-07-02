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

    const raw = await fsp.readFile(cpPath, "utf8");
    const parsed = JSON.parse(raw);
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

    const raw = await fsp.readFile(cpPath, "utf8");
    const parsed = JSON.parse(raw); // must be valid JSON (no interleaved writes)
    expect(parsed.units).toHaveLength(10);
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
