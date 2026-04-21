import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HookRuntime, matcherMatches } from "./runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.resolve(__dirname, "../../test/fixtures/hooks");

const allowHook = path.join(FIXTURES, "allow-hook.sh");
const denyHook = path.join(FIXTURES, "deny-hook.sh");
const failHook = path.join(FIXTURES, "fail-hook.sh");
const mutateHook = path.join(FIXTURES, "mutate-hook.sh");
const timeoutHook = path.join(FIXTURES, "timeout-hook.sh");

describe("HookRuntime.invoke — PreToolUse shell hooks", () => {
  it("allow-hook returns decision: allow", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: allowHook }],
    });
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: { command: "ls" },
    });
    expect(result.decision).toBe("allow");
  });

  it("deny-hook returns decision: deny with systemMessage", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: denyHook }],
    });
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: { command: "rm -rf /" },
    });
    expect(result.decision).toBe("deny");
    expect(result.systemMessage).toBe("blocked by policy");
    expect(result.permissionDecision).toBe("deny");
  });

  it("fail-hook returns decision: fail with error field", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: failHook }],
    });
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: {},
    });
    expect(result.decision).toBe("fail");
    expect(result.error).toMatch(/exited 1/);
  });

  it("mutate-hook propagates updatedInput", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: mutateHook }],
    });
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "read_file",
      toolInput: { foo: "original" },
    });
    expect(result.decision).toBe("allow");
    expect(result.updatedInput).toEqual({ foo: "mutated" });
  });

  it("timeout-hook reports timeout via decision: fail", async () => {
    const rt = new HookRuntime({
      PreToolUse: [
        { matcher: "*", command: timeoutHook, timeoutMs: 150 },
      ],
    });
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: {},
    });
    expect(result.decision).toBe("fail");
    expect(result.error).toMatch(/timed out after 150ms/);
  }, 10_000);
});

describe("HookRuntime.invoke — matcher logic", () => {
  it("matcher 'bash' matches only tool named 'bash'", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "bash", command: denyHook }],
    });
    const forBash = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: {},
    });
    expect(forBash.decision).toBe("deny");

    const forWrite = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "write_file",
      toolInput: {},
    });
    expect(forWrite.decision).toBe("allow"); // no matching hook → allow default
  });

  it("matcher '*' matches everything", () => {
    expect(matcherMatches("*", "anything")).toBe(true);
    expect(matcherMatches("*", "")).toBe(true);
  });

  it("glob wildcard in middle — 'read_*' matches 'read_file' but not 'write_file'", () => {
    expect(matcherMatches("read_*", "read_file")).toBe(true);
    expect(matcherMatches("read_*", "read_many_files")).toBe(true);
    expect(matcherMatches("read_*", "write_file")).toBe(false);
  });

  it("regex matcher '/^bash$/i' is case-insensitive", () => {
    expect(matcherMatches("/^bash$/i", "BASH")).toBe(true);
    expect(matcherMatches("/^bash$/i", "bash")).toBe(true);
    expect(matcherMatches("/^bash$/i", "bashful")).toBe(false);
  });

  it("literal matcher is an exact string match", () => {
    expect(matcherMatches("bash", "bash")).toBe(true);
    expect(matcherMatches("bash", "bashful")).toBe(false);
    expect(matcherMatches("bash", "Bash")).toBe(false);
  });
});

describe("HookRuntime.buildSdkHooks", () => {
  it("empty config produces empty map", () => {
    const rt = new HookRuntime({});
    expect(rt.buildSdkHooks()).toEqual({});
  });

  it("PreToolUse config produces a HookCallbackMatcher entry", () => {
    const rt = new HookRuntime({
      PreToolUse: [
        { matcher: "bash", command: allowHook, timeoutMs: 5000 },
      ],
    });
    const sdk = rt.buildSdkHooks();
    expect(sdk.PreToolUse).toHaveLength(1);
    const entry = sdk.PreToolUse![0]!;
    expect(entry.matcher).toBe("bash");
    // SDK timeout is in seconds
    expect(entry.timeout).toBe(5);
    expect(entry.hooks).toHaveLength(1);
    expect(typeof entry.hooks[0]).toBe("function");
  });

  it("multiple events and matchers round-trip", () => {
    const rt = new HookRuntime({
      PreToolUse: [
        { matcher: "bash", command: allowHook },
        { matcher: "write_*", command: denyHook },
      ],
      PostToolUse: [{ matcher: "*", command: allowHook }],
    });
    const sdk = rt.buildSdkHooks();
    expect(sdk.PreToolUse).toHaveLength(2);
    expect(sdk.PostToolUse).toHaveLength(1);
    expect(sdk.SessionStart).toBeUndefined();
  });

  it("SDK callback invokes the shell command and returns a valid HookJSONOutput shape", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: mutateHook }],
    });
    const sdk = rt.buildSdkHooks();
    const callback = sdk.PreToolUse![0]!.hooks[0]!;
    const out = (await callback(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/tmp/x",
        cwd: "/",
        tool_name: "read_file",
        tool_input: { foo: "x" },
        tool_use_id: "tu",
      } as never,
      "tu",
      { signal: new AbortController().signal },
    )) as {
      hookSpecificOutput?: {
        hookEventName: "PreToolUse";
        updatedInput?: Record<string, unknown>;
      };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput?.updatedInput).toEqual({ foo: "mutated" });
  });

  it("SDK callback translates deny → decision: block", async () => {
    const rt = new HookRuntime({
      PreToolUse: [{ matcher: "*", command: denyHook }],
    });
    const sdk = rt.buildSdkHooks();
    const callback = sdk.PreToolUse![0]!.hooks[0]!;
    const out = (await callback(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/tmp/x",
        cwd: "/",
        tool_name: "bash",
        tool_input: {},
        tool_use_id: "tu",
      } as never,
      "tu",
      { signal: new AbortController().signal },
    )) as { decision?: string };
    expect(out.decision).toBe("block");
  });
});

describe("HookRuntime.invoke — empty / no-match paths", () => {
  it("empty HookRuntime returns allow for any event", async () => {
    const rt = new HookRuntime({});
    const result = await rt.invoke("PreToolUse", {
      event: "PreToolUse",
      toolName: "bash",
      toolInput: {},
    });
    expect(result.decision).toBe("allow");
  });

  it("PostToolUse payload includes toolResult and is observable", async () => {
    const rt = new HookRuntime({
      PostToolUse: [{ matcher: "*", command: allowHook }],
    });
    const result = await rt.invoke("PostToolUse", {
      event: "PostToolUse",
      toolName: "bash",
      toolInput: { command: "echo hi" },
      toolResult: { status: "ok", output: "hi\n" },
    });
    expect(result.decision).toBe("allow");
  });
});
