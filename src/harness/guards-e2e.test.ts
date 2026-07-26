/**
 * End-to-end scenario for docs/63 P0, against the REAL tier-0 tools.
 *
 * Every other test in this area uses hand-written fake tools with invented
 * error strings, which means they validate the plumbing but NOT the riskiest
 * assumption: that `failureSignature()`'s normalisation actually clusters the
 * error messages openswarm really emits. This drives the real `edit_file` and
 * `read_file` implementations against a real file on disk, so the strings are
 * the shipped ones (`edit_file.ts:203`) rather than my guess at them.
 *
 * The scenario is the ambiguous-`old_string` failure: a file with repeated
 * boilerplate, where a short anchor matches many times. openswarm rejects that
 * (a deliberate divergence from the reference implementation's silent
 * first-match — docs/04), the agent hits it repeatedly, and a guard requiring a
 * longer anchor makes it impossible.
 *
 * What this does NOT cover: whether a live model *chooses* to install a guard
 * when nudged. That needs credentials this environment does not have, and no
 * amount of scripting substitutes for it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import {
  clearGuardRegistry,
  defineGuardTool,
  setGuardRegistry,
} from "../tools/tier0/define_guard.js";
import { GuardRegistry } from "./guards.js";
import { FailureRecurrenceTracker, failureSignature } from "./recurrence.js";
import type { ToolExecutionContext } from "../tools/types.js";

/** A file with repeated boilerplate — a short anchor is ambiguous in it. */
const BOILERPLATE = [
  "export function alpha() {",
  "  return { ok: true };",
  "}",
  "",
  "export function beta() {",
  "  return { ok: true };",
  "}",
  "",
  "export function gamma() {",
  "  return { ok: true };",
  "}",
  "",
].join("\n");

let tmpdir: string;
let filePath: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-e2e-"));
  filePath = path.join(tmpdir, "sample.ts");
  fs.writeFileSync(filePath, BOILERPLATE, "utf8");
  ctx = { cwd: tmpdir };
});

afterEach(() => {
  clearGuardRegistry();
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function buildDispatcher(guards: GuardRegistry, recurrence: FailureRecurrenceTracker) {
  const d = new ToolDispatcher({ guards, recurrence });
  for (const tool of buildTier0Tools()) d.register(tool);
  d.register(defineGuardTool);
  setGuardRegistry(guards);
  return d;
}

describe("guards e2e — real tier-0 tools, real file", () => {
  it("normalisation clusters the REAL ambiguous-match error across counts", async () => {
    const d = buildDispatcher(new GuardRegistry(), new FailureRecurrenceTracker());
    await d.dispatch("read_file", { file_path: filePath }, ctx);

    // Two genuinely different match counts from the real implementation.
    const three = await d.dispatch(
      "edit_file",
      { file_path: filePath, old_string: "  return { ok: true };", new_string: "  return { ok: 1 };" },
      ctx,
    );
    expect(three.status).toBe("error");
    const msg = three.status === "error" ? three.message : "";
    // Sanity: this really is the shipped ambiguity error, not something else.
    expect(msg).toContain("matches of the string to replace");

    // The property that matters: the REAL message is count-invariant after
    // normalisation, so the same failure at a different match count clusters.
    // Derived from the shipped string rather than a hand-written copy — an
    // earlier version of this test asserted against an invented message and
    // missed the trailing "To replace all occurrences…" sentence.
    const realSig = failureSignature("edit_file", msg);
    const variantSig = failureSignature(
      "edit_file",
      msg.replace(/Found \d+ matches/, "Found 17 matches"),
    );
    expect(variantSig).toBe(realSig);
    expect(realSig).toContain("found <n> matches of the string to replace");
  });

  it("full loop: repeated real failure → nudge → guard → blocked, anchored edit still works", async () => {
    const guards = new GuardRegistry();
    const recurrence = new FailureRecurrenceTracker();
    const d = buildDispatcher(guards, recurrence);

    await d.dispatch("read_file", { file_path: filePath }, ctx);

    const ambiguous = {
      file_path: filePath,
      old_string: "  return { ok: true };",
      new_string: "  return { ok: 1 };",
    };

    // 1. First real failure — no nudge yet.
    const first = await d.dispatch("edit_file", ambiguous, ctx);
    expect(first.status).toBe("error");
    expect(first.status === "error" && first.message).not.toContain("define_guard");

    // 2. Second identical failure — the trigger fires on a REAL error string.
    const second = await d.dispatch("edit_file", ambiguous, ctx);
    expect(second.status).toBe("error");
    expect(second.status === "error" && second.message).toContain("define_guard");
    expect(second.status === "error" && second.message).toContain("failed 2 times");

    // 3. The agent installs a guard: in this file, anchors must be long enough
    //    to be unique. (A real agent would phrase its own rule; the shape is
    //    what matters.)
    const install = await d.dispatch(
      "define_guard",
      {
        action: "define",
        target_tool: "edit_file",
        predicate: { kind: "field_length_lt", field: "old_string", length: 40 },
        message:
          "This file has repeated boilerplate — include enough surrounding lines in old_string to be unique, or pass replace_all.",
        failure_signature: "ambiguous-old-string",
      },
      ctx,
    );
    expect(install.status).toBe("ok");

    // 4. The same ambiguous edit is now impossible — blocked before execute.
    const blocked = await d.dispatch("edit_file", ambiguous, ctx);
    expect(blocked.status).toBe("error");
    expect(blocked.status === "error" && blocked.message).toContain("harness guard");
    expect(blocked.status === "error" && blocked.message).toContain("repeated boilerplate");
    // The file is untouched — a blocked call has no side effect.
    expect(fs.readFileSync(filePath, "utf8")).toBe(BOILERPLATE);

    // 5. A properly anchored edit still succeeds: the guard NARROWED the tool,
    //    it did not close it. This is docs/63's "narrow, never widen" observed
    //    end-to-end rather than asserted on a type.
    const anchored = await d.dispatch(
      "edit_file",
      {
        file_path: filePath,
        old_string: "export function beta() {\n  return { ok: true };\n}",
        new_string: "export function beta() {\n  return { ok: 2 };\n}",
      },
      ctx,
    );
    expect(anchored.status).toBe("ok");
    const after = fs.readFileSync(filePath, "utf8");
    expect(after).toContain("return { ok: 2 };");
    expect(after).toContain("export function alpha()");

    // 6. The session roll-up is the LH1 metric for this episode.
    expect(guards.summary().totalFired).toBe(1);
    expect(recurrence.summary().repeatedFailures).toBe(1);
    expect(recurrence.summary().prompted).toBe(1);
  });

  it("control: without a guard the same failure just keeps recurring", async () => {
    const guards = new GuardRegistry();
    const recurrence = new FailureRecurrenceTracker();
    const d = buildDispatcher(guards, recurrence);
    await d.dispatch("read_file", { file_path: filePath }, ctx);

    const ambiguous = {
      file_path: filePath,
      old_string: "  return { ok: true };",
      new_string: "  return { ok: 1 };",
    };
    for (let i = 0; i < 4; i++) {
      const res = await d.dispatch("edit_file", ambiguous, ctx);
      expect(res.status).toBe("error");
    }

    // The control observation LH1 needs: repeats happened, nothing was installed.
    expect(guards.summary().guardCount).toBe(0);
    expect(recurrence.summary().repeatedFailures).toBe(1);
    expect(recurrence.summary().totalFailures).toBe(4);
    expect(fs.readFileSync(filePath, "utf8")).toBe(BOILERPLATE);
  });
});
