import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileEventStore } from "./event-store.js";
import { EffectRuntime, InjectedFault, type FaultPoint } from "./effect-runtime.js";
import { PolicyEngine, WORKSPACE_WRITE_RULES, READ_ONLY_RULES } from "./policy-engine.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import type { EventEnvelope } from "./contracts.js";

const SESSION = "wp00";

describe("EffectRuntime", () => {
  let base: string;
  let workspace: string;
  let journalRoot: string;
  let store: FileEventStore;
  let authority: WorkspaceAuthority;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "openswarm-effect-"));
    workspace = path.join(base, "workspace");
    journalRoot = path.join(base, "journal");
    await fs.mkdir(workspace);
    store = new FileEventStore(journalRoot);
    authority = new WorkspaceAuthority(workspace);
    await authority.init();
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(base, { recursive: true, force: true });
  });

  function runtime(faults?: FaultPoint[], rules = WORKSPACE_WRITE_RULES) {
    return new EffectRuntime({
      sessionId: SESSION,
      store,
      authority,
      policy: new PolicyEngine(rules),
      ...(faults && { faults: new Set(faults) }),
    });
  }

  async function journal(): Promise<EventEnvelope[]> {
    const out: EventEnvelope[] = [];
    for await (const record of store.read(SESSION)) out.push(record);
    return out;
  }

  /** Drops the in-process store/authority the way a hard kill would. */
  async function restart() {
    await store.close();
    store = new FileEventStore(journalRoot);
    authority = new WorkspaceAuthority(workspace);
    await authority.init();
  }

  const read = (rel: string) => fs.readFile(path.join(workspace, rel), "utf8");
  const exists = async (rel: string) =>
    fs
      .access(path.join(workspace, rel))
      .then(() => true)
      .catch(() => false);

  describe("durability order", () => {
    it("prepares before executing and resolves after", async () => {
      const outcome = await runtime().writeFile("notes.txt", "hello");

      expect(outcome.kind).toBe("completed");
      expect(await read("notes.txt")).toBe("hello");

      const records = await journal();
      expect(records.map((r) => r.type)).toEqual(["AttemptPrepared", "AttemptResolved"]);
      // Both records share the operation they describe.
      expect(records[0]!.causationId).toBe(outcome.operationId);
      expect(records[1]!.causationId).toBe(outcome.operationId);
    });

    it("records the expectation in AttemptPrepared before the effect runs", async () => {
      await runtime().writeFile("new.txt", "content");

      const [prepared] = await journal();
      const payload = prepared!.payload as {
        request: { expected: { contentHash: string | null } };
        generation: number;
      };
      // The file did not exist when the attempt was prepared, and that is what
      // recovery later compares reality against.
      expect(payload.request.expected.contentHash).toBeNull();
      expect(payload.generation).toBe(1);
    });

    it("records a denial durably and writes nothing", async () => {
      const outcome = await runtime(undefined, READ_ONLY_RULES).writeFile("blocked.txt", "x");

      expect(outcome.kind).toBe("denied");
      expect(await exists("blocked.txt")).toBe(false);

      const records = await journal();
      expect(records.map((r) => r.type)).toEqual(["AttemptResolved"]);
    });

    it("refuses a path escape without journaling an attempt", async () => {
      const outcome = await runtime().writeFile("../escape.txt", "x");

      expect(outcome.kind).toBe("failed");
      // Nothing durable happened, so there is no attempt to recover.
      expect(await journal()).toEqual([]);
    });
  });

  describe("compare-and-swap", () => {
    it("refuses a write whose expectation is stale", async () => {
      await fs.writeFile(path.join(workspace, "shared.txt"), "original");
      const target = await authority.canonicalize("shared.txt");
      const stale = await authority.identify(target);

      // Someone else writes between the read and the attempt.
      await fs.writeFile(path.join(workspace, "shared.txt"), "theirs");

      const outcome = await runtime().writeFile("shared.txt", "mine", stale);

      expect(outcome.kind).toBe("failed");
      expect(outcome).toMatchObject({ conflict: true });
      // The concurrent write survives instead of being silently lost.
      expect(await read("shared.txt")).toBe("theirs");
    });

    it("refuses to create a file that appeared after the expectation formed", async () => {
      const target = await authority.canonicalize("race.txt");
      const expectAbsent = await authority.identify(target);

      await fs.writeFile(path.join(workspace, "race.txt"), "someone else");

      const outcome = await runtime().writeFile("race.txt", "mine", expectAbsent);
      expect(outcome).toMatchObject({ conflict: true });
      expect(await read("race.txt")).toBe("someone else");
    });

    it("advances the workspace generation on a committed mutation", async () => {
      expect(authority.generation).toBe(1);
      await runtime().writeFile("a.txt", "x");
      expect(authority.generation).toBe(2);
    });

    it("leaves no staging file behind", async () => {
      await runtime().writeFile("a.txt", "x");
      expect(await fs.readdir(workspace)).toEqual(["a.txt"]);
    });
  });

  describe("fault injection", () => {
    // The invariant under test, at every transition: after a hard kill the
    // journal never shows a committed effect it cannot account for, and
    // recovery never repeats a mutation it cannot prove did not happen.
    const beforeAnythingDurable: FaultPoint[] = [
      "before-canonicalize",
      "after-canonicalize",
      "after-authorize",
    ];

    for (const point of beforeAnythingDurable) {
      it(`leaves no attempt to recover when killed at ${point}`, async () => {
        await expect(runtime([point]).writeFile("a.txt", "x")).rejects.toThrow(InjectedFault);

        expect(await journal()).toEqual([]);
        expect(await exists("a.txt")).toBe(false);

        await restart();
        const report = await runtime().recover();
        expect(report.unresolved).toEqual([]);
      });
    }

    it("recovers a kill between prepare and execute without applying the write", async () => {
      await expect(runtime(["after-prepare"]).writeFile("a.txt", "x")).rejects.toThrow(
        InjectedFault,
      );

      // The attempt is durable but the effect never ran.
      expect((await journal()).map((r) => r.type)).toEqual(["AttemptPrepared"]);
      expect(await exists("a.txt")).toBe(false);

      await restart();
      const report = await runtime().recover();

      expect(report.closed).toBe(1);
      const [attempt] = report.unresolved;
      // Reality still matches the expectation, which is how recovery can tell
      // the effect did not land.
      expect(attempt!.workspaceUnchanged).toBe(true);
      expect(attempt!.autoReplayable).toBe(false);
      expect(await exists("a.txt")).toBe(false);
    });

    for (const point of ["after-execute", "before-resolve"] as FaultPoint[]) {
      it(`recovers a kill at ${point} without duplicating the mutation`, async () => {
        await expect(runtime([point]).writeFile("a.txt", "committed")).rejects.toThrow(
          InjectedFault,
        );

        // This is the dangerous window: the effect landed but was never
        // recorded as resolved.
        expect((await journal()).map((r) => r.type)).toEqual(["AttemptPrepared"]);
        expect(await read("a.txt")).toBe("committed");

        await restart();
        const report = await runtime().recover();

        expect(report.closed).toBe(1);
        const [attempt] = report.unresolved;
        // The expectation no longer holds, which is the evidence the effect
        // probably did land — so it must not be replayed.
        expect(attempt!.workspaceUnchanged).toBe(false);
        expect(attempt!.autoReplayable).toBe(false);
        expect(await read("a.txt")).toBe("committed");
      });
    }

    it("keeps the terminal record when killed after resolving", async () => {
      await expect(runtime(["after-resolve"]).writeFile("a.txt", "x")).rejects.toThrow(
        InjectedFault,
      );

      // Both records committed before the kill, so nothing is outstanding.
      expect((await journal()).map((r) => r.type)).toEqual([
        "AttemptPrepared",
        "AttemptResolved",
      ]);

      await restart();
      expect((await runtime().recover()).unresolved).toEqual([]);
    });

    it("closes an unresolved attempt with outcome_unknown", async () => {
      await expect(runtime(["after-execute"]).writeFile("a.txt", "x")).rejects.toThrow(
        InjectedFault,
      );
      await restart();
      await runtime().recover();

      const records = await journal();
      const terminal = records[records.length - 1]!;
      expect(terminal.type).toBe("AttemptResolved");
      expect((terminal.payload as { outcome: { kind: string } }).outcome.kind).toBe(
        "outcome_unknown",
      );
    });

    it("is idempotent across repeated recovery passes", async () => {
      await expect(runtime(["after-execute"]).writeFile("a.txt", "x")).rejects.toThrow(
        InjectedFault,
      );
      await restart();

      expect((await runtime().recover()).closed).toBe(1);
      // The second pass sees the attempt as resolved and does nothing.
      expect((await runtime().recover()).closed).toBe(0);
      expect(await journal()).toHaveLength(2);
    });

    it("survives a kill on a later attempt without disturbing earlier ones", async () => {
      await runtime().writeFile("first.txt", "one");
      await expect(runtime(["after-prepare"]).writeFile("second.txt", "two")).rejects.toThrow(
        InjectedFault,
      );

      await restart();
      const report = await runtime().recover();

      expect(report.closed).toBe(1);
      expect(report.unresolved[0]!.request.kind).toBe("file.write");
      // The completed attempt is untouched and its effect intact.
      expect(await read("first.txt")).toBe("one");
      expect((await journal()).map((r) => r.type)).toEqual([
        "AttemptPrepared",
        "AttemptResolved",
        "AttemptPrepared",
        "AttemptResolved",
      ]);
    });
  });

  describe("journal as source of truth", () => {
    it("reconstructs every attempt from the journal alone after a restart", async () => {
      await runtime().writeFile("a.txt", "1");
      await runtime().writeFile("b.txt", "2");
      await restart();

      const records = await journal();
      expect(records.map((r) => r.type)).toEqual([
        "AttemptPrepared",
        "AttemptResolved",
        "AttemptPrepared",
        "AttemptResolved",
      ]);
      // Sequence numbers stay gap-free across the restart boundary.
      expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    });
  });
});
