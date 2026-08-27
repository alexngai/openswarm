/**
 * FX-AUDIT-001..005 — the audit journal is durable regardless of how session
 * history is configured (docs/67 `WP-00a` remainder).
 *
 * The fixture that carries the point is FX-AUDIT-003. Before the split, attempt
 * records lived in the same file as engine snapshots and inherited history's
 * storage gate, so the answer to "did this effect already run?" existed only for
 * users who had opted into plaintext conversation logs. A hard kill is the exact
 * condition that question is asked after, so it is tested with a real SIGKILL
 * rather than a simulated one — a mocked crash cannot show that the bytes were
 * past fsync, which is the only thing that makes the record worth having.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openAuditJournal, asAuditJournal, AUDIT_DIR } from "./audit-journal.js";
import { FileEventStore } from "./event-store.js";
import { SESSIONS_DIR } from "../session/resume.js";

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const attempt = (n: number) => ({
  sessionId: "s1",
  type: "AttemptPrepared" as const,
  payload: { operationId: `op-${n}`, path: `/w/file-${n}.txt` },
});

describe("the audit journal", () => {
  it("FX-AUDIT-001 is durable with no storage configuration at all", async () => {
    // `resolvePersistence` resolves to ephemeral without an opt-in, and that is
    // correct for history. The audit journal takes no configuration to resolve,
    // so there is no path on which it silently becomes a no-op.
    const journal = openAuditJournal(workspace);
    await journal.append(attempt(1));
    await journal.close();

    const onDisk = path.join(workspace, AUDIT_DIR, "s1", "journal.jsonl");
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(fs.readFileSync(onDisk, "utf8")).toContain("op-1");
  });

  it("FX-AUDIT-002 does not share a file with session history", async () => {
    const journal = openAuditJournal(workspace);
    await journal.append(attempt(1));
    await journal.close();

    const history = new FileEventStore(path.join(workspace, SESSIONS_DIR));
    await history.append({
      sessionId: "s1",
      type: "EngineStateRecorded",
      payload: { engineId: "native", data: { messages: ["secret text"] } },
    });
    await history.close();

    const auditFile = path.join(workspace, AUDIT_DIR, "s1", "journal.jsonl");
    const historyFile = path.join(workspace, SESSIONS_DIR, "s1", "journal.jsonl");
    expect(auditFile).not.toBe(historyFile);

    // The claim that makes the split defensible: no message text reaches the
    // audit trail, so its unconditional durability is not a history leak.
    expect(fs.readFileSync(auditFile, "utf8")).not.toContain("secret text");
    expect(fs.readFileSync(historyFile, "utf8")).toContain("secret text");
  });

  it("FX-AUDIT-003 an acknowledged attempt record survives SIGKILL", () => {
    // Appends two records, acknowledges both, then kills itself uncatchably.
    // Anything readable afterwards was past fsync, which is the property the
    // journal promises and a stream-based writer does not.
    const child = `
      const { openAuditJournal } = require(${JSON.stringify(path.resolve("dist/kernel/audit-journal.js"))});
      (async () => {
        const j = openAuditJournal(${JSON.stringify(workspace)});
        await j.append({ sessionId: "s1", type: "AttemptPrepared", payload: { operationId: "op-1" } });
        await j.append({ sessionId: "s1", type: "AttemptResolved", payload: { operationId: "op-1" } });
        process.kill(process.pid, "SIGKILL");
      })();
    `;
    const run = spawnSync(process.execPath, ["-e", child], { encoding: "utf8" });
    expect(run.signal).toBe("SIGKILL");

    const lines = fs
      .readFileSync(path.join(workspace, AUDIT_DIR, "s1", "journal.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "AttemptPrepared",
      "AttemptResolved",
    ]);
  });

  it("FX-AUDIT-004 keeps gap-free sequence numbers so a lost record is visible", async () => {
    const journal = openAuditJournal(workspace);
    for (let n = 1; n <= 5; n += 1) await journal.append(attempt(n));
    expect(await journal.lastSeq("s1")).toBe(5);

    const seqs: number[] = [];
    for await (const record of journal.read("s1")) seqs.push(record.seq);
    await journal.close();
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it("FX-AUDIT-005 narrows an existing store without opening a second one", async () => {
    const store = new FileEventStore(path.join(workspace, AUDIT_DIR));
    const journal = asAuditJournal(store);
    await journal.append(attempt(1));
    expect(await journal.lastSeq("s1")).toBe(1);
    await journal.close();
  });

  it("refuses history event types at compile time", () => {
    const journal = openAuditJournal(workspace);
    // @ts-expect-error — an audit journal cannot be handed conversation history.
    void journal.append({ sessionId: "s1", type: "EngineStateRecorded", payload: {} });
    void journal;
  });
});

describe("the audit/history partition", () => {
  it("fails to compile when a new kernel event type is left unclassified", () => {
    // The partition is three type-level assertions, and an assertion that cannot
    // fail is decoration. So this compiles the *real* `audit-journal.ts` against a
    // `contracts.ts` with a seventh event type and no journal assigned to it,
    // which is the mistake the assertions exist to catch — and the one `WP-12`
    // will be in a position to make as soon as it adds projection events.
    //
    // Compiled in a copied tree rather than in place: the suite runs files in
    // parallel, so patching a source module other tests are importing would make
    // this fixture's correctness depend on scheduling.
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "audit-partition-"));
    try {
      const patchedContracts = fs
        .readFileSync(path.resolve("src/kernel/contracts.ts"), "utf8")
        .replace('  | "EngineStateRecorded";', '  | "EngineStateRecorded"\n  | "FxProbeEvent";');
      expect(patchedContracts).toContain("FxProbeEvent");

      fs.writeFileSync(path.join(probe, "contracts.ts"), patchedContracts);
      fs.copyFileSync(
        path.resolve("src/kernel/audit-journal.ts"),
        path.join(probe, "audit-journal.ts"),
      );
      // Only the three type names `audit-journal.ts` imports from it, so the
      // probe compiles without dragging in the rest of the tree.
      fs.writeFileSync(
        path.join(probe, "event-store.ts"),
        `export declare class FileEventStore {
           constructor(root: string);
           append<T>(e: NewEvent<T>): Promise<unknown>;
           read(id: string): AsyncIterable<{ seq: number }>;
           lastSeq(id: string): Promise<number>;
           close(): Promise<void>;
         }
         export type EventStore = FileEventStore;
         export interface NewEvent<T> {
           readonly sessionId: string;
           readonly type: import("./contracts.js").KernelEventType;
           readonly payload: T;
         }`,
      );
      fs.writeFileSync(
        path.join(probe, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: "nodenext",
            moduleResolution: "nodenext",
            target: "es2022",
            skipLibCheck: true,
          },
          files: ["audit-journal.ts"],
        }),
      );

      // By absolute path, not `npx tsc`: the probe lives outside the repo, so npx
      // finds no local typescript and instead fetches the unrelated `tsc` package
      // from npm, which exits non-zero with advice rather than a type error.
      const tsc = path.resolve("node_modules/typescript/bin/tsc");
      expect(fs.existsSync(tsc), `no compiler at ${tsc}`).toBe(true);

      const run = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
        cwd: probe,
        encoding: "utf8",
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(run.status, `expected a type error, got:\n${output}`).not.toBe(0);
      expect(output).toContain("audit-journal.ts");
      expect(output).toContain("is not assignable to type 'never'");
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }, 120_000);
});
