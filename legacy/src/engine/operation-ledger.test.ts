/**
 * Operation ledger (docs/67 `WP-05`).
 *
 * The properties worth pinning here are the ones the engine relies on and
 * cannot easily observe: that a retried attempt computes the same identity for
 * the same call, that two similar-but-distinct calls stay distinct, and that a
 * thrown dispatch is remembered differently from a returned failure.
 */

import { describe, it, expect } from "vitest";

import { TurnLedger, decideReplay, idempotencyOf } from "./operation-ledger.js";
import { ToolAccesses } from "../tools/access.js";
import type { ToolResult } from "../tools/types.js";

const OK: ToolResult = { status: "ok", output: "done" };

describe("idempotencyOf", () => {
  it("reads the declaration a tool already makes for the scheduler", () => {
    expect(idempotencyOf(ToolAccesses.readFile("/a"))).toBe("idempotent");
    expect(idempotencyOf(ToolAccesses.searchTree("/a"))).toBe("idempotent");
    expect(idempotencyOf(ToolAccesses.none())).toBe("idempotent");
    expect(idempotencyOf(ToolAccesses.writeFile("/a"))).toBe("mutating");
    expect(idempotencyOf(ToolAccesses.readWriteFile("/a"))).toBe("mutating");
  });

  it("treats an unnameable effect as strictly as a known mutation", () => {
    // `all()` is what bash and every plugin tool declare. The tool is saying it
    // cannot describe its own effects, which is the last situation in which to
    // assume repeating them is safe.
    expect(idempotencyOf(ToolAccesses.all())).toBe("unknown");
  });

  it("distinguishes a retrieval from a remote call that may do anything", () => {
    expect(idempotencyOf(ToolAccesses.network("https://x/y", "GET"))).toBe("idempotent");
    expect(idempotencyOf(ToolAccesses.network("https://x/y", "head"))).toBe("idempotent");
    expect(idempotencyOf(ToolAccesses.network("https://x/y", "POST"))).toBe("mutating");
    expect(idempotencyOf(ToolAccesses.mcpServer("srv"))).toBe("mutating");
    expect(idempotencyOf(ToolAccesses.plugin("p"))).toBe("mutating");
  });

  it("takes the strictest class when a call touches several things", () => {
    expect(idempotencyOf([...ToolAccesses.readFile("/a"), ...ToolAccesses.writeFile("/b")])).toBe(
      "mutating",
    );
    expect(idempotencyOf([...ToolAccesses.writeFile("/b"), ...ToolAccesses.all()])).toBe("unknown");
  });
});

describe("operation identity", () => {
  it("is the same for the same call in a retried attempt", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const first = ledger.identify("write", { path: "/a", content: "x" });

    ledger.beginAttempt();
    expect(ledger.identify("write", { path: "/a", content: "x" })).toBe(first);
  });

  it("ignores argument key order, which carries no meaning", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const a = ledger.identify("write", { path: "/a", content: "x" });
    ledger.beginAttempt();
    const b = ledger.identify("write", { content: "x", path: "/a" });
    expect(b).toBe(a);
  });

  it("keeps a call repeated within one attempt as two operations", () => {
    // `bash: echo x >> log` twice in one turn is two appends, and collapsing
    // them into one operation would lose the second on every retry.
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const first = ledger.identify("bash", { command: "echo x >> log" });
    const second = ledger.identify("bash", { command: "echo x >> log" });
    expect(second).not.toBe(first);

    // And the retry lines both up again, in order.
    ledger.beginAttempt();
    expect(ledger.identify("bash", { command: "echo x >> log" })).toBe(first);
    expect(ledger.identify("bash", { command: "echo x >> log" })).toBe(second);
  });

  it("separates different arguments, different tools, and different turns", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const write = ledger.identify("write", { path: "/a" });
    const other = ledger.identify("write", { path: "/b" });
    const read = ledger.identify("read", { path: "/a" });
    expect(new Set([write, other, read]).size).toBe(3);

    const laterTurn = new TurnLedger(1);
    laterTurn.beginAttempt();
    expect(laterTurn.identify("write", { path: "/a" })).not.toBe(write);
  });
});

describe("replay decisions", () => {
  it("dispatches a call it has never seen", () => {
    expect(decideReplay(undefined, "mutating")).toEqual({ kind: "dispatch" });
  });

  it("waits for an attempt already under way rather than starting a second", async () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("write", { path: "/a" });

    let release: (r: ToolResult) => void = () => {};
    const pending = ledger.start(id, "mutating", () => new Promise((r) => (release = r)));

    const decision = decideReplay(ledger.get(id), "mutating");
    expect(decision.kind).toBe("await");

    release(OK);
    await expect(pending).resolves.toEqual(OK);
  });

  it("answers a completed mutation from the record instead of redoing it", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("write", { path: "/a" });
    ledger.settle(id, "mutating", OK);

    expect(decideReplay(ledger.get(id), "mutating")).toEqual({ kind: "reuse", result: OK });
  });

  it("refuses a mutation whose outcome was never proven", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("write", { path: "/a" });
    ledger.markUnknown(id, "mutating", "the turn was cancelled mid-write");

    const decision = decideReplay(ledger.get(id), "mutating");
    expect(decision.kind).toBe("refuse");
    // The message has to tell the model what to do instead, or it will simply
    // ask for the same write again.
    if (decision.kind === "refuse") {
      expect(decision.message).toContain("outcome is unknown");
      expect(decision.message).toContain("re-read");
    }
  });

  it("re-dispatches an idempotent call whatever the record says", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("read", { path: "/a" });

    ledger.settle(id, "idempotent", OK);
    expect(decideReplay(ledger.get(id), "idempotent")).toEqual({ kind: "dispatch" });

    ledger.markUnknown(id, "idempotent", "abandoned");
    expect(decideReplay(ledger.get(id), "idempotent")).toEqual({ kind: "dispatch" });
  });

  it("treats an unknown-effect call as strictly as a mutating one", () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("bash", { command: "deploy" });
    ledger.settle(id, "unknown", OK);

    expect(decideReplay(ledger.get(id), "unknown")).toEqual({ kind: "reuse", result: OK });
  });
});

describe("settling an attempt", () => {
  it("remembers a returned failure as proven", async () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("write", { path: "/a" });
    const failure: ToolResult = { status: "error", message: "no such directory" };

    await ledger.start(id, "mutating", async () => failure);

    // The tool ran and said what happened, so a retry can be answered.
    expect(ledger.get(id)).toMatchObject({ kind: "completed", result: failure });
    expect(ledger.unresolved()).toEqual([]);
  });

  it("remembers a thrown dispatch as unproven", async () => {
    const ledger = new TurnLedger(0);
    ledger.beginAttempt();
    const id = ledger.identify("write", { path: "/a" });

    await expect(
      ledger.start(id, "mutating", async () => {
        throw new Error("worker died mid-call");
      }),
    ).rejects.toThrow("worker died mid-call");

    // Nothing said whether the write landed, so this must not be repeated.
    expect(ledger.get(id)).toMatchObject({
      kind: "outcome_unknown",
      reason: "worker died mid-call",
    });
    expect(ledger.unresolved()).toHaveLength(1);
  });
});
