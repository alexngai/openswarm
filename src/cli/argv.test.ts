import { describe, it, expect } from "vitest";
import { parseArgv } from "./argv.js";

describe("parseArgv", () => {
  // ---- Bare positional → prompt -------------------------------------------

  it("bare positional string is treated as prompt text", () => {
    const result = parseArgv(["say hi"]);
    expect(result).toMatchObject({ kind: "prompt", text: "say hi" });
  });

  it("multiple bare positionals are joined as prompt text", () => {
    const result = parseArgv(["say", "hello", "world"]);
    expect(result).toMatchObject({ kind: "prompt", text: "say hello world" });
  });

  // ---- Explicit subcommands ------------------------------------------------

  it("explicit prompt subcommand with text", () => {
    const result = parseArgv(["prompt", "do something"]);
    expect(result).toMatchObject({ kind: "prompt", text: "do something" });
  });

  it("doctor subcommand returns doctor kind with default text format", () => {
    const result = parseArgv(["doctor"]);
    expect(result).toMatchObject({ kind: "doctor", outputFormat: "text" });
  });

  it("init subcommand returns init kind", () => {
    const result = parseArgv(["init"]);
    expect(result).toMatchObject({ kind: "init" });
  });

  it("init subcommand with positional cwd", () => {
    const result = parseArgv(["init", "/some/path"]);
    expect(result).toMatchObject({ kind: "init", cwd: "/some/path" });
  });

  it("help subcommand returns help kind", () => {
    expect(parseArgv(["help"])).toEqual({ kind: "help" });
  });

  it("version subcommand returns version kind", () => {
    expect(parseArgv(["version"])).toEqual({ kind: "version" });
  });

  // ---- Flags ---------------------------------------------------------------

  it("--model flag sets model in opts", () => {
    const result = parseArgv(["--model", "sonnet", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.model).toBe("sonnet");
  });

  it("--permission-mode read-only is parsed correctly", () => {
    const result = parseArgv(["--permission-mode", "read-only", "hello"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.permissionMode).toBe("read-only");
  });

  it("--permission-mode workspace-write is the default", () => {
    const result = parseArgv(["hello"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.permissionMode).toBe("workspace-write");
  });

  it("--permission-mode danger-full-access is parsed", () => {
    const result = parseArgv(["--permission-mode", "danger-full-access", "go"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.permissionMode).toBe("danger-full-access");
  });

  it("--headless flag sets headless in opts", () => {
    const result = parseArgv(["--headless", "say hi"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.headless).toBe(true);
  });

  it("headless defaults to false", () => {
    const result = parseArgv(["say hi"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.headless).toBe(false);
  });

  it("--resume latest sets resume in opts", () => {
    const result = parseArgv(["--resume", "latest", "continue"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.resume).toBe("latest");
  });

  it("--resume with session id sets resume in opts", () => {
    const result = parseArgv(["--resume", "abc-123", "continue"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.resume).toBe("abc-123");
  });

  it("--output-format json sets outputFormat in opts", () => {
    const result = parseArgv(["--output-format", "json", "hello"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.outputFormat).toBe("json");
  });

  it("--output-format json propagates to doctor subcommand", () => {
    const result = parseArgv(["doctor", "--output-format", "json"]);
    expect(result).toMatchObject({ kind: "doctor", outputFormat: "json" });
  });

  // ---- Short flags ---------------------------------------------------------

  it("-h returns help kind", () => {
    expect(parseArgv(["-h"])).toEqual({ kind: "help" });
  });

  it("-V returns version kind", () => {
    expect(parseArgv(["-V"])).toEqual({ kind: "version" });
  });

  // ---- --flag=value form ---------------------------------------------------

  it("--flag=value form: --model=sonnet", () => {
    const result = parseArgv(["--model=sonnet", "task"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.model).toBe("sonnet");
  });

  it("--flag=value form: --permission-mode=read-only", () => {
    const result = parseArgv(["--permission-mode=read-only", "task"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.permissionMode).toBe("read-only");
  });

  it("--flag=value form: --output-format=json", () => {
    const result = parseArgv(["--output-format=json", "task"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.outputFormat).toBe("json");
  });

  // ---- Error cases ---------------------------------------------------------

  it("unknown flag returns error kind", () => {
    const result = parseArgv(["--unknown-flag", "hello"]);
    expect(result).toMatchObject({ kind: "error", showHelp: true });
  });

  it("invalid --permission-mode value returns error kind", () => {
    const result = parseArgv(["--permission-mode", "superuser", "hello"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid --permission-mode"),
      showHelp: true,
    });
  });

  it("invalid --output-format value returns error kind", () => {
    const result = parseArgv(["--output-format", "xml", "hello"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid --output-format"),
      showHelp: true,
    });
  });

  it("prompt subcommand with no text returns error", () => {
    const result = parseArgv(["prompt"]);
    expect(result).toMatchObject({ kind: "error" });
  });

  // ---- No args → help ------------------------------------------------------

  it("no args returns help kind", () => {
    expect(parseArgv([])).toEqual({ kind: "help" });
  });

  // ---- --version / --help as flags anywhere --------------------------------

  it("--version flag anywhere returns version kind", () => {
    expect(parseArgv(["--version"])).toEqual({ kind: "version" });
  });

  it("--help flag anywhere returns help kind", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
  });

  // ---- Flags can appear after subcommand -----------------------------------

  it("flags after subcommand are parsed correctly", () => {
    const result = parseArgv(["prompt", "--model", "opus", "hello"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.model).toBe("opus");
    expect(result.text).toBe("hello");
  });

  // ---- swarm run + dead-letter flags ---------------------------------------

  it("swarm run with --dead-letter sets deadLetter path", () => {
    const result = parseArgv(["swarm", "run", "tasks.json", "--dead-letter", "/tmp/dl.jsonl"]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.deadLetter).toBe("/tmp/dl.jsonl");
  });

  it("swarm run --allow-dead-letter sets the boolean", () => {
    const result = parseArgv(["swarm", "run", "tasks.json", "--allow-dead-letter"]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.allowDeadLetter).toBe(true);
  });

  it("swarm run with both --dead-letter and --allow-dead-letter parses without error", () => {
    const result = parseArgv([
      "swarm", "run", "tasks.json",
      "--dead-letter", "/tmp/dl.jsonl",
      "--allow-dead-letter",
    ]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.deadLetter).toBe("/tmp/dl.jsonl");
    expect(result.allowDeadLetter).toBe(true);
  });

  it("swarm run defaults: deadLetter = ./dead-letter.jsonl, allowDeadLetter = false", () => {
    const result = parseArgv(["swarm", "run", "tasks.json"]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.deadLetter).toBe("./dead-letter.jsonl");
    expect(result.allowDeadLetter).toBe(false);
  });
});
