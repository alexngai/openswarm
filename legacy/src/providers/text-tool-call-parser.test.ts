import { describe, it, expect } from "vitest";
import {
  exciseSpans,
  extractToolCallsFromText,
  looksLikeTextToolCall,
} from "./text-tool-call-parser.js";

describe("looksLikeTextToolCall", () => {
  it("detects each delimited family", () => {
    expect(looksLikeTextToolCall('<tool_call>{"name":"bash"}</tool_call>')).toBe(true);
    expect(looksLikeTextToolCall('<|python_tag|>{"name":"bash"}')).toBe(true);
    expect(looksLikeTextToolCall("<function=bash>{}</function>")).toBe(true);
    expect(looksLikeTextToolCall('[TOOL_CALLS] [{"name":"bash"}]')).toBe(true);
  });

  it("stays quiet on ordinary prose", () => {
    expect(looksLikeTextToolCall("I ran the tests and they pass.")).toBe(false);
    expect(looksLikeTextToolCall('{"command":"ls"}')).toBe(false);
  });
});

describe("extractToolCallsFromText", () => {
  it("extracts a Hermes/Qwen call", () => {
    const text = '<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("bash");
    expect(call?.format).toBe("hermes");
    expect(JSON.parse(call!.rawArguments)).toEqual({ command: "ls" });
  });

  it("extracts a Hermes call whose closing tag was truncated away", () => {
    const text = '<tool_call>{"name": "bash", "arguments": {"command": "ls"}}';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("bash");
  });

  it("extracts multiple Hermes calls in source order", () => {
    const text =
      '<tool_call>{"name":"read_file","arguments":{"path":"/a"}}</tool_call>' +
      'some prose' +
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const calls = extractToolCallsFromText(text);
    expect(calls.map((c) => c.name)).toEqual(["read_file", "bash"]);
  });

  it("extracts a Llama 3.1 python_tag call", () => {
    const text = '<|python_tag|>{"name": "bash", "parameters": {"command": "pwd"}}<|eom_id|>';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("bash");
    expect(call?.format).toBe("python_tag");
    expect(JSON.parse(call!.rawArguments)).toEqual({ command: "pwd" });
  });

  it("extracts a Llama 3.2 function_tag call, taking the name from the tag", () => {
    const text = '<function=read_file>{"path": "/tmp/x"}</function>';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("read_file");
    expect(call?.format).toBe("function_tag");
    expect(JSON.parse(call!.rawArguments)).toEqual({ path: "/tmp/x" });
  });

  it("extracts every element of a Mistral [TOOL_CALLS] array", () => {
    const text =
      '[TOOL_CALLS] [{"name":"bash","arguments":{"command":"ls"}},' +
      '{"name":"grep","arguments":{"pattern":"x"}}]';
    const calls = extractToolCallsFromText(text);
    expect(calls.map((c) => c.name)).toEqual(["bash", "grep"]);
    expect(JSON.parse(calls[1]!.rawArguments)).toEqual({ pattern: "x" });
  });

  it("extracts a DeepSeek call", () => {
    const text =
      '<｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n```json\n{"command":"ls"}\n```<｜tool▁call▁end｜>';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("bash");
    expect(call?.format).toBe("deepseek");
    expect(JSON.parse(call!.rawArguments)).toEqual({ command: "ls" });
  });

  it("ignores prose that merely describes a tool call", () => {
    const text =
      'I would call the bash tool with {"command": "ls"} but I need permission first.';
    expect(extractToolCallsFromText(text)).toEqual([]);
  });

  it("does not mine bare JSON unless explicitly allowed", () => {
    const text = 'Here is the call: {"name": "bash", "arguments": {"command": "ls"}}';
    expect(extractToolCallsFromText(text)).toEqual([]);
    const [call] = extractToolCallsFromText(text, { allowBareJson: true });
    expect(call?.name).toBe("bash");
    expect(call?.format).toBe("bare_json");
  });

  it("mines fenced JSON only under allowBareJson", () => {
    const text = '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```';
    expect(extractToolCallsFromText(text)).toEqual([]);
    const calls = extractToolCallsFromText(text, { allowBareJson: true });
    expect(calls.length).toBe(1);
    expect(calls[0]?.name).toBe("bash");
  });

  it("does not double-count a bare object nested in a fenced block", () => {
    const text = '```json\n{"name":"bash","arguments":{"command":"ls"}}\n```';
    const calls = extractToolCallsFromText(text, { allowBareJson: true });
    expect(calls.length).toBe(1);
  });

  it("defaults arguments to {} when the call carries none", () => {
    const text = '<tool_call>{"name": "todo_write"}</tool_call>';
    const [call] = extractToolCallsFromText(text);
    expect(call?.name).toBe("todo_write");
    expect(JSON.parse(call!.rawArguments)).toEqual({});
  });

  it("returns [] for empty text", () => {
    expect(extractToolCallsFromText("")).toEqual([]);
  });
});

describe("exciseSpans", () => {
  it("removes the extracted syntax and keeps the prose", () => {
    const text =
      'Let me list the files.\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
    const calls = extractToolCallsFromText(text);
    expect(exciseSpans(text, calls)).toBe("Let me list the files.");
  });

  it("removes multiple spans without shifting later offsets", () => {
    const text =
      'A<tool_call>{"name":"bash","arguments":{}}</tool_call>B' +
      '<tool_call>{"name":"grep","arguments":{}}</tool_call>C';
    const calls = extractToolCallsFromText(text);
    expect(exciseSpans(text, calls)).toBe("ABC");
  });

  it("is a no-op with no calls", () => {
    expect(exciseSpans("plain text", [])).toBe("plain text");
  });
});
