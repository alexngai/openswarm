/**
 * FX-AUDIT-006..010 — a tool side effect produces correlated pre-decision and
 * terminal facts (docs/67 `WP-00a` remainder).
 *
 * This is the fixture `WP-12` is waiting on. Before it, the journal's attempt
 * records had exactly one writer, `EffectRuntime`, and `new EffectRuntime`
 * appeared only inside its own test file — so "every effect records its decision
 * and its terminal result" was a property of a class nothing constructed. The
 * gate was already canonicalizing paths and authorizing them per resource; what
 * was missing was that it recorded nothing, and the ledger that brackets
 * execution recorded only in memory.
 *
 * The two halves are deliberately written by different components, and the
 * asymmetry is the point: only the gate knows the decision, and only the thing
 * that brackets execution knows whether the tool got to say what happened. So
 * these fixtures assert the pairing rather than either half alone, since a
 * prepare with no resolve is indistinguishable from a crash and that is exactly
 * the state recovery has to be able to find.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openAuditJournal, type AuditJournal } from "./audit-journal.js";
import { TurnLedger } from "../engine/operation-ledger.js";
import type { AttemptPreparedPayload, EffectOutcome, EventEnvelope } from "./contracts.js";
import type { AttemptRecorder } from "../permissions/gate.js";

let workspace: string;
let journal: AuditJournal;
const SESSION = "s-audit";

/** The gate's half: prepare only. */
function recorder(j: AuditJournal): AttemptRecorder {
  return {
    prepare: async (payload) => {
      await j.append({
        sessionId: SESSION,
        type: "AttemptPrepared",
        payload,
        causationId: payload.request.operationId,
      });
    },
  };
}

/** The ledger's half: resolve only. */
function resolver(j: AuditJournal) {
  return {
    resolve: async (outcome: EffectOutcome) => {
      await j.append({
        sessionId: SESSION,
        type: "AttemptResolved",
        payload: { outcome },
        causationId: outcome.operationId,
      });
    },
  };
}

function preparedPayload(operationId: string, rel: string): AttemptPreparedPayload {
  return {
    request: {
      kind: "file.write",
      operationId,
      idempotency: "mutating",
      toolName: "write_file",
      path: {
        canonical: path.join(workspace, rel),
        relative: rel,
        workspaceRoot: workspace,
      },
      expected: { path: { canonical: path.join(workspace, rel), relative: rel, workspaceRoot: workspace }, contentHash: null, sizeBytes: null, mtimeMs: null },
    },
    decision: { allowed: true, source: "mode", scope: "session" },
    generation: 7,
  };
}

async function records(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  for await (const r of journal.read(SESSION)) out.push(r);
  return out;
}

/** operationIds that were prepared but never resolved — the crash signature. */
function dangling(all: readonly EventEnvelope[]): string[] {
  const prepared = new Set<string>();
  const resolved = new Set<string>();
  for (const r of all) {
    const id = r.causationId;
    if (id === undefined) continue;
    if (r.type === "AttemptPrepared") prepared.add(id);
    if (r.type === "AttemptResolved") resolved.add(id);
  }
  return [...prepared].filter((id) => !resolved.has(id));
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-"));
  journal = openAuditJournal(workspace);
});

afterEach(async () => {
  await journal.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("attempt correlation", () => {
  it("FX-AUDIT-006 a successful effect is prepared before it runs and resolved after", async () => {
    const ledger = new TurnLedger(0, resolver(journal));
    await recorder(journal).prepare(preparedPayload("op-1", "a.txt"));

    const id = ledger.identify("write_file", { file_path: "a.txt" });
    ledger.attach(id, ["op-1"]);

    const order: string[] = [];
    await ledger.start(id, "mutating", async () => {
      // Inside execution the attempt is prepared and not yet resolved, which is
      // the whole reason prepare is durable before step 4.
      order.push(...(await records()).map((r) => r.type));
      return { status: "ok", output: "wrote a.txt" };
    });

    expect(order).toEqual(["AttemptPrepared"]);
    const all = await records();
    expect(all.map((r) => r.type)).toEqual(["AttemptPrepared", "AttemptResolved"]);
    expect(dangling(all)).toEqual([]);

    const outcome = (all[1] as EventEnvelope<{ outcome: EffectOutcome }>).payload.outcome;
    expect(outcome.kind).toBe("completed");
    expect(outcome.operationId).toBe("op-1");
  });

  it("FX-AUDIT-007 does not record the tool's output, which can be file content", async () => {
    const ledger = new TurnLedger(0, resolver(journal));
    await recorder(journal).prepare(preparedPayload("op-1", "a.txt"));
    const id = ledger.identify("write_file", { file_path: "a.txt" });
    ledger.attach(id, ["op-1"]);

    await ledger.start(id, "mutating", async () => ({
      status: "ok",
      output: "BEGIN PRIVATE KEY sensitive-file-body",
    }));

    // The journal is durable unconditionally, so what it may hold is exactly
    // what makes that defensible: paths and decisions, never content.
    const raw = fs.readFileSync(
      path.join(workspace, ".openswarm", "audit", SESSION, "journal.jsonl"),
      "utf8",
    );
    expect(raw).not.toContain("sensitive-file-body");
    expect(raw).toContain("op-1");
  });

  it("FX-AUDIT-008 a returned error is a proven failure, not an unknown outcome", async () => {
    const ledger = new TurnLedger(0, resolver(journal));
    await recorder(journal).prepare(preparedPayload("op-1", "a.txt"));
    const id = ledger.identify("write_file", { file_path: "a.txt" });
    ledger.attach(id, ["op-1"]);

    await ledger.start(id, "mutating", async () => ({
      status: "error",
      message: "refused: stale file",
    }));

    const all = await records();
    const outcome = (all[1] as EventEnvelope<{ outcome: EffectOutcome }>).payload.outcome;
    expect(outcome.kind).toBe("failed");
    expect(dangling(all)).toEqual([]);
  });

  it("FX-AUDIT-009 a thrown error leaves outcome_unknown, because nobody can say", async () => {
    const ledger = new TurnLedger(0, resolver(journal));
    await recorder(journal).prepare(preparedPayload("op-1", "a.txt"));
    const id = ledger.identify("write_file", { file_path: "a.txt" });
    ledger.attach(id, ["op-1"]);

    await expect(
      ledger.start(id, "mutating", async () => {
        throw new Error("killed mid-write");
      }),
    ).rejects.toThrow("killed mid-write");

    const all = await records();
    const outcome = (all[1] as EventEnvelope<{ outcome: EffectOutcome }>).payload.outcome;
    expect(outcome.kind).toBe("outcome_unknown");
    // Resolved as unknown rather than left dangling: a record saying "nobody
    // knows" is actionable, and an absent record is indistinguishable from a
    // crash that happened before the effect.
    expect(dangling(all)).toEqual([]);
  });

  it("FX-AUDIT-010 an attempt that never reaches the ledger stays dangling", async () => {
    // The crash signature recovery looks for. Prepared, never bracketed — which
    // is what a hard kill between the gate and the dispatcher leaves behind.
    await recorder(journal).prepare(preparedPayload("op-1", "a.txt"));
    const all = await records();
    expect(all.map((r) => r.type)).toEqual(["AttemptPrepared"]);
    expect(dangling(all)).toEqual(["op-1"]);
  });
});
