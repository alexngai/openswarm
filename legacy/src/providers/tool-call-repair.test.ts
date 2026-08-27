import { describe, it, expect } from "vitest";
import {
  boundedEditDistance,
  closeUnbalanced,
  coerceArgumentJson,
  extractFirstJsonRegion,
  repairToolCall,
  repairToolName,
  unwrapArgumentEnvelope,
} from "./tool-call-repair.js";

const TOOLS = [
  "bash",
  "read_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "glob",
  "grep",
  "todo_write",
];

describe("repairToolName", () => {
  it("returns the exact name with no repair recorded", () => {
    expect(repairToolName("bash", TOOLS)).toEqual({ name: "bash" });
  });

  it("strips namespace prefixes servers prepend", () => {
    expect(repairToolName("functions.bash", TOOLS)?.name).toBe("bash");
    expect(repairToolName("default_api.read_file", TOOLS)?.name).toBe("read_file");
  });

  it("corrects case", () => {
    expect(repairToolName("Bash", TOOLS)?.name).toBe("bash");
    expect(repairToolName("READ_FILE", TOOLS)?.name).toBe("read_file");
  });

  it("resolves the aliases open-weight models hallucinate", () => {
    expect(repairToolName("shell", TOOLS)?.name).toBe("bash");
    expect(repairToolName("run_command", TOOLS)?.name).toBe("bash");
    expect(repairToolName("python", TOOLS)?.name).toBe("bash");
    expect(repairToolName("str_replace_editor", TOOLS)?.name).toBe("edit_file");
    expect(repairToolName("cat", TOOLS)?.name).toBe("read_file");
    expect(repairToolName("ripgrep", TOOLS)?.name).toBe("grep");
  });

  it("never lets an alias shadow a registered tool of the same name", () => {
    // `apply_patch` aliases to edit_file, but only when it is not itself a tool.
    const withApplyPatch = [...TOOLS, "apply_patch"];
    expect(repairToolName("apply_patch", withApplyPatch)).toEqual({
      name: "apply_patch",
    });
    expect(repairToolName("apply_patch", TOOLS)?.name).toBe("edit_file");
  });

  it("normalizes punctuation drift", () => {
    expect(repairToolName("edit-file", TOOLS)?.name).toBe("edit_file");
    expect(repairToolName("editFile", TOOLS)?.name).toBe("edit_file");
    expect(repairToolName("write file", TOOLS)?.name).toBe("write_file");
  });

  it("fuzzy-matches a near-miss typo", () => {
    expect(repairToolName("read_fil", TOOLS)?.name).toBe("read_file");
    expect(repairToolName("gerp", TOOLS)?.name).toBe("grep");
  });

  it("refuses an ambiguous match rather than guessing", () => {
    // Equidistant from both — must not silently pick one.
    expect(repairToolName("ba", ["bar", "baz"])).toBeUndefined();
  });

  it("returns undefined for a genuinely invented tool", () => {
    expect(repairToolName("summon_unicorn", TOOLS)).toBeUndefined();
  });

  it("returns undefined when there are no registered tools", () => {
    expect(repairToolName("bash", [])).toBeUndefined();
  });
});

describe("boundedEditDistance", () => {
  it("computes small distances", () => {
    expect(boundedEditDistance("abc", "abc", 2)).toBe(0);
    expect(boundedEditDistance("abc", "abd", 2)).toBe(1);
    expect(boundedEditDistance("abc", "axd", 2)).toBe(2);
  });

  it("short-circuits past the bound", () => {
    expect(boundedEditDistance("abc", "zzzzzzzz", 2)).toBeGreaterThan(2);
  });
});

describe("extractFirstJsonRegion", () => {
  it("extracts a balanced object out of surrounding prose", () => {
    expect(extractFirstJsonRegion('I will run: {"command":"ls"} now')).toBe(
      '{"command":"ls"}',
    );
  });

  it("respects braces inside string literals", () => {
    const raw = '{"command":"echo {not a brace}"}';
    expect(extractFirstJsonRegion(raw)).toBe(raw);
  });

  it("respects escaped quotes", () => {
    const raw = '{"command":"echo \\"hi\\""}';
    expect(extractFirstJsonRegion(raw)).toBe(raw);
  });

  it("returns the unterminated remainder when truncated", () => {
    expect(extractFirstJsonRegion('{"command":"ls"')).toBe('{"command":"ls"');
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(extractFirstJsonRegion("no json here")).toBeUndefined();
  });
});

describe("closeUnbalanced", () => {
  it("closes a truncated object", () => {
    expect(closeUnbalanced('{"a":1')).toBe('{"a":1}');
  });

  it("closes a nested truncation in the right order", () => {
    expect(closeUnbalanced('{"a":[1,2')).toBe('{"a":[1,2]}');
  });

  it("closes a string truncated mid-value", () => {
    expect(closeUnbalanced('{"command":"npm te')).toBe('{"command":"npm te"}');
  });

  it("drops a dangling key that cannot be closed into anything valid", () => {
    const closed = closeUnbalanced('{"a":1,"b":');
    expect(closed).toBeDefined();
    expect(() => JSON.parse(closed!)).not.toThrow();
  });

  it("returns undefined when nothing is open", () => {
    expect(closeUnbalanced('{"a":1}')).toBeUndefined();
  });
});

describe("coerceArgumentJson", () => {
  it("passes well-formed JSON through with no repairs", () => {
    const out = coerceArgumentJson('{"command":"ls"}');
    expect(out?.value).toEqual({ command: "ls" });
    expect(out?.repairs).toEqual([]);
  });

  it("unwraps a markdown code fence", () => {
    const out = coerceArgumentJson('```json\n{"command":"ls"}\n```');
    expect(out?.value).toEqual({ command: "ls" });
    expect(out?.repairs).toContain("unwrapped markdown code fence");
  });

  it("strips leaked tool-call wrapper tags", () => {
    const out = coerceArgumentJson('<|python_tag|>{"command":"ls"}');
    expect(out?.value).toEqual({ command: "ls" });
  });

  it("recovers JSON embedded in prose", () => {
    const out = coerceArgumentJson('Sure! {"command":"ls -la"} should do it.');
    expect(out?.value).toEqual({ command: "ls -la" });
  });

  it("normalizes Python literals", () => {
    const out = coerceArgumentJson('{"replace_all": True, "x": None}');
    expect(out?.value).toEqual({ replace_all: true, x: null });
  });

  it("removes trailing commas", () => {
    const out = coerceArgumentJson('{"command":"ls",}');
    expect(out?.value).toEqual({ command: "ls" });
  });

  it("quotes bare object keys", () => {
    const out = coerceArgumentJson('{command: "ls"}');
    expect(out?.value).toEqual({ command: "ls" });
  });

  it("converts single quotes when unambiguous", () => {
    const out = coerceArgumentJson("{'command': 'ls'}");
    expect(out?.value).toEqual({ command: "ls" });
  });

  it("closes JSON truncated by max_tokens", () => {
    const out = coerceArgumentJson('{"command":"npm test"');
    expect(out?.value).toEqual({ command: "npm test" });
    expect(out?.repairs).toContain("closed truncated JSON");
  });

  it("decodes double-encoded argument strings", () => {
    const out = coerceArgumentJson('"{\\"command\\":\\"ls\\"}"');
    expect(out?.value).toEqual({ command: "ls" });
  });

  it("returns undefined for input with no recoverable JSON", () => {
    expect(coerceArgumentJson("I think I should list the files")).toBeUndefined();
    expect(coerceArgumentJson("   ")).toBeUndefined();
  });

  it("does not corrupt apostrophes inside a well-formed string", () => {
    const out = coerceArgumentJson('{"command":"echo don\'t"}');
    expect(out?.value).toEqual({ command: "echo don't" });
    expect(out?.repairs).toEqual([]);
  });
});

describe("unwrapArgumentEnvelope", () => {
  it("unwraps a bare arguments envelope", () => {
    expect(unwrapArgumentEnvelope({ arguments: { command: "ls" } })?.value).toEqual({
      command: "ls",
    });
  });

  it("unwraps name + parameters", () => {
    expect(
      unwrapArgumentEnvelope({ name: "bash", parameters: { command: "ls" } })?.value,
    ).toEqual({ command: "ls" });
  });

  it("unwraps a JSON-string envelope value", () => {
    expect(
      unwrapArgumentEnvelope({ arguments: '{"command":"ls"}' })?.value,
    ).toEqual({ command: "ls" });
  });

  it("leaves a real argument object that happens to have an input field", () => {
    // Two keys where the second is not `name` → a genuine argument object.
    expect(
      unwrapArgumentEnvelope({ input: "x", file_path: "/a" }),
    ).toBeUndefined();
  });

  it("leaves a plain argument object alone", () => {
    expect(unwrapArgumentEnvelope({ command: "ls" })).toBeUndefined();
  });

  it("ignores non-objects", () => {
    expect(unwrapArgumentEnvelope("nope")).toBeUndefined();
    expect(unwrapArgumentEnvelope(null)).toBeUndefined();
    expect(unwrapArgumentEnvelope([1, 2])).toBeUndefined();
  });
});

describe("repairToolCall", () => {
  it("reports no repairs for an already-valid call", () => {
    const out = repairToolCall({
      name: "bash",
      input: { command: "ls" },
      availableTools: TOOLS,
    });
    expect(out).toEqual({ name: "bash", input: { command: "ls" }, repairs: [] });
  });

  it("repairs name and envelope together", () => {
    const out = repairToolCall({
      name: "shell",
      input: { arguments: { command: "ls" } },
      availableTools: TOOLS,
    });
    expect(out?.name).toBe("bash");
    expect(out?.input).toEqual({ command: "ls" });
    expect(out?.originalName).toBe("shell");
    expect(out?.repairs.length).toBe(2);
  });

  it("coerces a raw argument string when the transport produced none", () => {
    const out = repairToolCall({
      name: "bash",
      rawArguments: '{"command":"npm test"',
      availableTools: TOOLS,
    });
    expect(out?.input).toEqual({ command: "npm test" });
  });

  it("decodes string-encoded input handed back by a transport", () => {
    const out = repairToolCall({
      name: "bash",
      input: '{"command":"ls"}',
      availableTools: TOOLS,
    });
    expect(out?.input).toEqual({ command: "ls" });
  });

  it("falls back to empty arguments rather than dropping the call", () => {
    const out = repairToolCall({
      name: "bash",
      rawArguments: "not json at all",
      availableTools: TOOLS,
    });
    // Empty args reach the dispatcher and produce an actionable schema error,
    // which beats the call vanishing.
    expect(out?.input).toEqual({});
    expect(out?.repairs).toContain("could not parse arguments; dispatching empty object");
  });

  it("returns undefined when the name cannot be resolved", () => {
    expect(
      repairToolCall({ name: "summon_unicorn", input: {}, availableTools: TOOLS }),
    ).toBeUndefined();
  });
});
