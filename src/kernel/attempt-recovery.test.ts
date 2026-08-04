/**
 * FX-AUDIT-015..019 — a dangling attempt is reconciled on restart (docs/67
 * `WP-00a` remainder).
 *
 * The pre-decision record exists so that a crash between performing an effect
 * and recording its result is detectable. Writing it was only half the job: the
 * reconciliation logic sat on `EffectRuntime` with no caller, so every restart
 * found the dangling attempt and did nothing, and the record was as good as
 * absent.
 *
 * FX-AUDIT-017 is the one that earns its keep. It kills a process mid-attempt
 * for real rather than simulating the gap by hand-writing a prepare, because the
 * bug this guards against is not "reconciliation mishandles a dangling record"
 * but "the thing a crash actually leaves behind is not the shape recovery looks
 * for" — and a fixture that constructs its own input cannot fail that way.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openAuditJournal, AUDIT_DIR, type AuditJournal } from "./audit-journal.js";
import { reconcileAttempts } from "./attempt-recovery.js";
import { WorkspaceAuthority } from "./workspace-authority.js";
import type { AttemptPreparedPayload, EffectOutcome, EventEnvelope } from "./contracts.js";

const SESSION = "s-recover";
let workspace: string;
let journal: AuditJournal;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-recovery-"));
  journal = openAuditJournal(workspace);
});

afterEach(async () => {
  await journal.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** A write request naming `rel`, expecting whatever it holds right now. */
async function writePrepared(
  operationId: string,
  rel: string,
): Promise<AttemptPreparedPayload> {
  const authority = new WorkspaceAuthority(workspace);
  await authority.init();
  const canonical = await authority.canonicalize(rel);
  const expected = await authority.identify(canonical);
  return {
    request: {
      kind: "file.write",
      operationId,
      path: canonical,
      expected,
    },
    decision: { allowed: true, source: "mode" },
    generation: 0,
  } as unknown as AttemptPreparedPayload;
}

function records(): Array<{ type: string; payload: Record<string, unknown> }> {
  const file = path.join(workspace, AUDIT_DIR, SESSION, "journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
}

const reconcile = () =>
  reconcileAttempts({
    sessionId: SESSION,
    journal,
    authority: new WorkspaceAuthority(workspace),
  });

describe("reconciling attempts on restart", () => {
  it("FX-AUDIT-015 closes a dangling attempt as unknown and reports it", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "one");
    await journal.append({
      sessionId: SESSION,
      type: "AttemptPrepared",
      payload: await writePrepared("op-1", "a.txt"),
      causationId: "op-1",
    });

    const report = await reconcile();

    expect(report.closed).toBe(1);
    expect(report.unresolved).toHaveLength(1);
    // Never replayed, whatever the workspace looks like: a write cannot be
    // distinguished from a write that was not recorded.
    expect(report.unresolved[0]!.autoReplayable).toBe(false);

    const all = records();
    expect(all.map((r) => r.type)).toEqual(["AttemptPrepared", "AttemptResolved"]);
    const outcome = (all[1]!.payload as { outcome: EffectOutcome }).outcome;
    expect(outcome.kind).toBe("outcome_unknown");
    expect(outcome.operationId).toBe("op-1");
  });

  it("FX-AUDIT-016 leaves an already-resolved attempt alone", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "one");
    await journal.append({
      sessionId: SESSION,
      type: "AttemptPrepared",
      payload: await writePrepared("op-1", "a.txt"),
      causationId: "op-1",
    });
    await journal.append({
      sessionId: SESSION,
      type: "AttemptResolved",
      payload: { outcome: { kind: "completed", operationId: "op-1" } },
      causationId: "op-1",
    });

    const report = await reconcile();

    expect(report.closed).toBe(0);
    // The important half: a completed effect must not acquire a second,
    // contradictory terminal record that downgrades it to unknown.
    expect(records()).toHaveLength(2);
  });

  it("FX-AUDIT-017 reconciles what a real SIGKILL leaves behind", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "one");
    const prepared = await writePrepared("op-1", "a.txt");

    // Prepare, perform, die before resolving — the gap recovery exists for.
    const child = `
      const { openAuditJournal } = require(${JSON.stringify(path.resolve("dist/kernel/audit-journal.js"))});
      const fs = require("node:fs");
      (async () => {
        const j = openAuditJournal(${JSON.stringify(workspace)});
        await j.append({
          sessionId: ${JSON.stringify(SESSION)},
          type: "AttemptPrepared",
          payload: ${JSON.stringify(prepared)},
          causationId: "op-1",
        });
        fs.writeFileSync(${JSON.stringify(path.join(workspace, "a.txt"))}, "two");
        process.kill(process.pid, "SIGKILL");
      })();
    `;
    const run = spawnSync(process.execPath, ["-e", child], { encoding: "utf8" });
    expect(run.signal).toBe("SIGKILL");
    expect(records().map((r) => r.type)).toEqual(["AttemptPrepared"]);

    const report = await reconcile();

    expect(report.closed).toBe(1);
    // The effect did land, so the expectation no longer holds. Recovery reports
    // that rather than deciding what it means.
    expect(report.unresolved[0]!.workspaceUnchanged).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf8")).toBe("two");
  });

  it("FX-AUDIT-018 is idempotent, so a crash during recovery is not special", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "one");
    await journal.append({
      sessionId: SESSION,
      type: "AttemptPrepared",
      payload: await writePrepared("op-1", "a.txt"),
      causationId: "op-1",
    });

    expect((await reconcile()).closed).toBe(1);
    expect((await reconcile()).closed).toBe(0);
    expect(records()).toHaveLength(2);
  });

  it("FX-AUDIT-019 does not touch another session's dangling attempt", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "one");
    await journal.append({
      sessionId: "s-other",
      type: "AttemptPrepared",
      payload: await writePrepared("op-9", "a.txt"),
      causationId: "op-9",
    });

    // The concurrency constraint, asserted rather than described: a live agent's
    // in-flight prepare looks exactly like a crashed one from the outside, so
    // reconciliation is scoped to the session the caller owns.
    expect((await reconcile()).closed).toBe(0);

    const other = fs
      .readFileSync(path.join(workspace, AUDIT_DIR, "s-other", "journal.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(other.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "AttemptPrepared",
    ]);
  });
});
