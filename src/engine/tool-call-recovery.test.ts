import { describe, it, expect } from "vitest";
import type { NormalizedEvent } from "../core/types.js";
import {
  applyRecovery,
  createToolCallRecovery,
  resolveEscalationBudget,
  resolveRepairLevel,
  ToolCallRecovery,
  toolCallRepairedEvent,
  ToolChoiceEscalation,
  type RecoveryAssistantBlock,
  type RecoveryPendingToolUse,
} from "./tool-call-recovery.js";

const TOOLS = ["bash", "read_file", "edit_file", "grep", "todo_write"];

function recovery(level: "off" | "standard" | "aggressive" = "standard"): ToolCallRecovery {
  return new ToolCallRecovery({ level, availableTools: TOOLS });
}

describe("resolveRepairLevel", () => {
  it("defaults to standard when unset or blank", () => {
    expect(resolveRepairLevel({})).toBe("standard");
    expect(resolveRepairLevel({ OPENSWARM_TOOL_CALL_REPAIR: "  " })).toBe("standard");
  });

  it("recognises the off spellings", () => {
    for (const v of ["off", "0", "false", "none", "OFF"]) {
      expect(resolveRepairLevel({ OPENSWARM_TOOL_CALL_REPAIR: v })).toBe("off");
    }
  });

  it("recognises the aggressive spellings", () => {
    for (const v of ["aggressive", "2", "all"]) {
      expect(resolveRepairLevel({ OPENSWARM_TOOL_CALL_REPAIR: v })).toBe("aggressive");
    }
  });

  it("degrades an unrecognised value to standard, not off", () => {
    expect(resolveRepairLevel({ OPENSWARM_TOOL_CALL_REPAIR: "banana" })).toBe("standard");
  });
});

describe("ToolCallRecovery.enabled", () => {
  it("is off at level off", () => {
    expect(recovery("off").enabled).toBe(false);
  });

  it("is off when no tools are advertised", () => {
    expect(new ToolCallRecovery({ level: "standard", availableTools: [] }).enabled).toBe(
      false,
    );
  });

  it("is on at standard with a tool surface", () => {
    expect(recovery().enabled).toBe(true);
  });
});

describe("repairDelivered", () => {
  it("returns undefined for an already-valid call (hot path)", () => {
    expect(recovery().repairDelivered("t1", "bash", { command: "ls" })).toBeUndefined();
  });

  it("repairs an aliased name", () => {
    const out = recovery().repairDelivered("t1", "shell", { command: "ls" });
    expect(out?.name).toBe("bash");
    expect(out?.originalName).toBe("shell");
    expect(out?.stage).toBe("delivered");
  });

  it("unwraps an argument envelope", () => {
    const out = recovery().repairDelivered("t1", "bash", {
      arguments: { command: "ls" },
    });
    expect(out?.input).toEqual({ command: "ls" });
  });

  it("returns undefined for an unresolvable tool name", () => {
    expect(recovery().repairDelivered("t1", "summon_unicorn", {})).toBeUndefined();
  });

  it("is inert when disabled", () => {
    expect(recovery("off").repairDelivered("t1", "shell", {})).toBeUndefined();
  });
});

describe("recoverDroppedCalls", () => {
  it("rebuilds a call whose argument stream was never delivered", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":');
    r.noteInputDelta("t1", '"npm test"'); // truncated — no closing brace
    const [call] = r.recoverDroppedCalls();
    expect(call?.name).toBe("bash");
    expect(call?.input).toEqual({ command: "npm test" });
    expect(call?.stage).toBe("recovered_stream");
  });

  it("ignores calls the transport did deliver", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"}');
    r.noteDelivered("t1");
    expect(r.recoverDroppedCalls()).toEqual([]);
  });

  it("skips a dropped call whose name is unresolvable", () => {
    const r = recovery();
    r.noteInputStart("t1", "summon_unicorn");
    r.noteInputDelta("t1", "{}");
    expect(r.recoverDroppedCalls()).toEqual([]);
  });

  it("consumes buffers so a second call returns nothing", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"}');
    expect(r.recoverDroppedCalls().length).toBe(1);
    expect(r.recoverDroppedCalls()).toEqual([]);
  });

  it("reset() drops buffers so a retry cannot resurrect a stale call", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"}');
    r.reset();
    expect(r.recoverDroppedCalls()).toEqual([]);
  });
});

describe("recoverFromText", () => {
  it("recovers a Hermes-format call the server failed to parse", () => {
    const text =
      'Let me look.\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const out = recovery().recoverFromText(text, "t0_repair");
    expect(out.calls.length).toBe(1);
    expect(out.calls[0]?.name).toBe("bash");
    expect(out.calls[0]?.input).toEqual({ command: "ls" });
    expect(out.calls[0]?.stage).toBe("recovered_text");
    expect(out.cleanedText).toBe("Let me look.");
  });

  it("mentions the serving-layer flags in the repair trail", () => {
    const out = recovery().recoverFromText(
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      "t0_repair",
    );
    expect(out.calls[0]?.repairs[0]).toContain("--tool-call-parser");
  });

  it("assigns unique ids", () => {
    const text =
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' +
      '<tool_call>{"name":"grep","arguments":{"pattern":"x"}}</tool_call>';
    const out = recovery().recoverFromText(text, "t0_repair");
    expect(out.calls.map((c) => c.id)).toEqual(["t0_repair_0", "t0_repair_1"]);
  });

  it("drops an extracted call naming a tool that is not registered", () => {
    const out = recovery().recoverFromText(
      '<tool_call>{"name":"summon_unicorn","arguments":{}}</tool_call>',
      "t0_repair",
    );
    expect(out.calls).toEqual([]);
  });

  it("leaves ordinary prose alone", () => {
    const text = "I finished the task; the tests pass.";
    const out = recovery().recoverFromText(text, "t0_repair");
    expect(out.calls).toEqual([]);
    expect(out.cleanedText).toBe(text);
  });

  it("does not mine bare JSON at standard level", () => {
    const text = 'Call it like {"name":"bash","arguments":{"command":"ls"}}.';
    expect(recovery("standard").recoverFromText(text, "t0").calls).toEqual([]);
    expect(recovery("aggressive").recoverFromText(text, "t0").calls.length).toBe(1);
  });

  it("is inert when disabled", () => {
    const out = recovery("off").recoverFromText(
      '<tool_call>{"name":"bash","arguments":{}}</tool_call>',
      "t0",
    );
    expect(out.calls).toEqual([]);
  });
});

describe("diagnoseSilentStop", () => {
  it("flags text carrying unrecovered tool-call syntax", () => {
    const msg = recovery().diagnoseSilentStop('<tool_call>{"name":"nope"}</tool_call>');
    expect(msg).toContain("--enable-auto-tool-choice");
  });

  it("stays quiet on a genuine final answer", () => {
    expect(recovery().diagnoseSilentStop("All done — tests pass.")).toBeUndefined();
    expect(recovery().diagnoseSilentStop("")).toBeUndefined();
  });
});

describe("toolCallRepairedEvent", () => {
  it("renders the observational event", () => {
    const event = toolCallRepairedEvent({
      id: "t1",
      name: "bash",
      input: {},
      repairs: ["aliased"],
      stage: "delivered",
      originalName: "shell",
    });
    expect(event).toEqual({
      type: "tool_call_repaired",
      id: "t1",
      stage: "delivered",
      toolName: "bash",
      repairs: ["aliased"],
      originalName: "shell",
    });
  });

  it("omits absent optional fields", () => {
    const event = toolCallRepairedEvent({
      id: "t1",
      name: "bash",
      input: {},
      repairs: [],
      stage: "recovered_stream",
    });
    expect(event).not.toHaveProperty("originalName");
    expect(event).not.toHaveProperty("format");
  });
});

describe("applyRecovery", () => {
  function run(
    r: ToolCallRecovery,
    assistantContent: RecoveryAssistantBlock[],
    toolUseBuffer: RecoveryPendingToolUse[] = [],
  ): { events: NormalizedEvent[]; assistantContent: RecoveryAssistantBlock[]; toolUseBuffer: RecoveryPendingToolUse[] } {
    const events = [
      ...applyRecovery({ recovery: r, assistantContent, toolUseBuffer, turnId: "t0" }),
    ];
    return { events, assistantContent, toolUseBuffer };
  }

  it("admits a dropped streaming call into both buffers", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"');
    const out = run(r, []);
    expect(out.toolUseBuffer).toEqual([
      { id: "t1", name: "bash", input: { command: "ls" } },
    ]);
    expect(out.assistantContent).toEqual([
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]);
    // The block was already announced during streaming — re-announcing would
    // reset consumers' input accumulators, so only the close is emitted.
    expect(out.events.map((e) => e.type)).toEqual([
      "tool_use_end",
      "tool_call_repaired",
    ]);
  });

  it("announces a text-recovered call in full, with the repaired arguments", () => {
    const out = run(recovery(), [
      {
        type: "text",
        text: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      },
    ]);
    expect(out.events.map((e) => e.type)).toEqual([
      "tool_use_start",
      "tool_use_input",
      "tool_use_end",
      "tool_call_repaired",
    ]);
    const input = out.events.find((e) => e.type === "tool_use_input");
    expect(input).toMatchObject({ jsonDelta: '{"command":"ls"}' });
  });

  it("recovers from text only when the turn has no structured calls", () => {
    const text = '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const withCall = run(recovery(), [{ type: "text", text }], [
      { id: "real", name: "grep", input: {} },
    ]);
    // A turn that already made a call is never re-read.
    expect(withCall.toolUseBuffer.length).toBe(1);

    const withoutCall = run(recovery(), [{ type: "text", text }]);
    expect(withoutCall.toolUseBuffer.length).toBe(1);
    expect(withoutCall.toolUseBuffer[0]?.name).toBe("bash");
  });

  it("replaces the text block with prose stripped of the malformed syntax", () => {
    const text =
      'Listing now.\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const out = run(recovery(), [{ type: "text", text }]);
    expect(out.assistantContent[0]).toEqual({ type: "text", text: "Listing now." });
    expect(out.assistantContent[1]).toMatchObject({ type: "tool_use", name: "bash" });
  });

  it("preserves reasoning blocks through text recovery", () => {
    const text = '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const out = run(recovery(), [
      { type: "reasoning", signature: "sig" },
      { type: "text", text },
    ]);
    expect(out.assistantContent[0]).toEqual({ type: "reasoning", signature: "sig" });
    // All syntax was excised, so no text block survives.
    expect(out.assistantContent.some((b) => b.type === "text")).toBe(false);
  });

  it("emits a diagnostic when tool-call syntax survives unrecovered", () => {
    const out = run(recovery(), [
      { type: "text", text: '<tool_call>{"name":"summon_unicorn","arguments":{}}</tool_call>' },
    ]);
    expect(out.toolUseBuffer).toEqual([]);
    const info = out.events.find((e) => e.type === "info");
    expect(info).toBeDefined();
    expect(JSON.stringify(info)).toContain("--tool-call-parser");
  });

  it("emits nothing for a clean terminal turn", () => {
    const out = run(recovery(), [{ type: "text", text: "All done." }]);
    expect(out.events).toEqual([]);
    expect(out.assistantContent).toEqual([{ type: "text", text: "All done." }]);
  });

  it("is a no-op when disabled", () => {
    const r = recovery("off");
    const out = run(r, [
      { type: "text", text: '<tool_call>{"name":"bash","arguments":{}}</tool_call>' },
    ]);
    expect(out.events).toEqual([]);
    expect(out.toolUseBuffer).toEqual([]);
  });

  it("reports recovered calls through onRecovered for the eager path", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"}');
    const seen: string[] = [];
    const buffer: RecoveryPendingToolUse[] = [];
    [
      ...applyRecovery({
        recovery: r,
        assistantContent: [],
        toolUseBuffer: buffer,
        turnId: "t0",
        onRecovered: (c) => seen.push(c.id),
      }),
    ];
    expect(seen).toEqual(["t1"]);
  });
});

describe("ToolChoiceEscalation", () => {
  it("arms once, then reports the override exactly once", () => {
    const e = new ToolChoiceEscalation(1, false);
    expect(e.arm()).toBe(true);
    expect(e.consume()).toBe("required");
    // Consumed — the forced turn must not force itself again.
    expect(e.consume()).toBeUndefined();
  });

  it("respects the per-run budget", () => {
    const e = new ToolChoiceEscalation(1, false);
    expect(e.arm()).toBe(true);
    e.consume();
    expect(e.arm()).toBe(false);
    expect(e.escalationCount).toBe(1);
  });

  it("honours a budget above one", () => {
    const e = new ToolChoiceEscalation(2, false);
    expect(e.arm()).toBe(true);
    e.consume();
    expect(e.arm()).toBe(true);
    e.consume();
    expect(e.arm()).toBe(false);
  });

  it("will not double-arm before the pending override is consumed", () => {
    const e = new ToolChoiceEscalation(5, false);
    expect(e.arm()).toBe(true);
    expect(e.arm()).toBe(false);
  });

  it("is disabled when the caller pinned toolChoice", () => {
    const e = new ToolChoiceEscalation(1, true);
    expect(e.enabled).toBe(false);
    expect(e.arm()).toBe(false);
  });

  it("is disabled at budget zero", () => {
    expect(new ToolChoiceEscalation(0, false).arm()).toBe(false);
  });
});

describe("resolveEscalationBudget", () => {
  it("defaults to one per run", () => {
    expect(resolveEscalationBudget({})).toBe(1);
  });

  it("recognises the off spellings", () => {
    expect(resolveEscalationBudget({ OPENSWARM_TOOL_CHOICE_ESCALATION: "0" })).toBe(0);
    expect(resolveEscalationBudget({ OPENSWARM_TOOL_CHOICE_ESCALATION: "off" })).toBe(0);
  });

  it("accepts an explicit budget", () => {
    expect(resolveEscalationBudget({ OPENSWARM_TOOL_CHOICE_ESCALATION: "3" })).toBe(3);
  });

  it("degrades a malformed value to the default", () => {
    expect(resolveEscalationBudget({ OPENSWARM_TOOL_CHOICE_ESCALATION: "lots" })).toBe(1);
  });
});

describe("applyRecovery + escalation", () => {
  const SYNTAX = '<tool_call>{"name":"summon_unicorn","arguments":{}}</tool_call>';

  function runWith(escalation?: ToolChoiceEscalation) {
    const assistantContent: RecoveryAssistantBlock[] = [
      { type: "text", text: SYNTAX },
    ];
    const toolUseBuffer: RecoveryPendingToolUse[] = [];
    const events: NormalizedEvent[] = [];
    const gen = applyRecovery({
      recovery: recovery(),
      assistantContent,
      toolUseBuffer,
      turnId: "t0",
      ...(escalation !== undefined ? { escalation } : {}),
    });
    let next = gen.next();
    while (!next.done) {
      events.push(next.value);
      next = gen.next();
    }
    return { events, outcome: next.value };
  }

  it("arms an escalation instead of only diagnosing", () => {
    const { events, outcome } = runWith(new ToolChoiceEscalation(1, false));
    expect(outcome.escalated).toBe(true);
    const info = events.find((e) => e.type === "info");
    expect(info).toMatchObject({ method: "tool_choice_escalation" });
  });

  it("falls back to the plain diagnosis once the budget is spent", () => {
    const escalation = new ToolChoiceEscalation(1, false);
    escalation.arm();
    escalation.consume();
    const { events, outcome } = runWith(escalation);
    expect(outcome.escalated).toBe(false);
    expect(events.find((e) => e.type === "info")).toMatchObject({
      method: "unrecovered_text_tool_call",
    });
  });

  it("diagnoses without escalating when no escalation is supplied", () => {
    const { outcome, events } = runWith(undefined);
    expect(outcome.escalated).toBe(false);
    expect(events.find((e) => e.type === "info")).toMatchObject({
      method: "unrecovered_text_tool_call",
    });
  });

  it("never escalates a turn whose call was successfully recovered", () => {
    const assistantContent: RecoveryAssistantBlock[] = [
      { type: "text", text: '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' },
    ];
    const toolUseBuffer: RecoveryPendingToolUse[] = [];
    const escalation = new ToolChoiceEscalation(1, false);
    const gen = applyRecovery({
      recovery: recovery(),
      assistantContent,
      toolUseBuffer,
      turnId: "t0",
      escalation,
    });
    let next = gen.next();
    while (!next.done) next = gen.next();
    expect(next.value).toEqual({ recovered: 1, escalated: false });
    expect(escalation.escalationCount).toBe(0);
  });

  it("reports the recovered count", () => {
    const r = recovery();
    r.noteInputStart("t1", "bash");
    r.noteInputDelta("t1", '{"command":"ls"');
    const buffer: RecoveryPendingToolUse[] = [];
    const gen = applyRecovery({
      recovery: r,
      assistantContent: [],
      toolUseBuffer: buffer,
      turnId: "t0",
    });
    let next = gen.next();
    while (!next.done) next = gen.next();
    expect(next.value).toEqual({ recovered: 1, escalated: false });
  });
});

describe("createToolCallRecovery", () => {
  it("honours an explicit level over the environment", () => {
    expect(createToolCallRecovery(TOOLS, "off").enabled).toBe(false);
    expect(createToolCallRecovery(TOOLS, "standard").enabled).toBe(true);
  });

  it("counts repairs for telemetry", () => {
    const r = createToolCallRecovery(TOOLS, "standard");
    expect(r.repairCount).toBe(0);
    r.repairDelivered("t1", "shell", { command: "ls" });
    expect(r.repairCount).toBe(1);
  });
});
