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

  // ---- team start (v0.4 stage 4F) ------------------------------------------

  it("team start <template> returns team-start kind with the template name", () => {
    const result = parseArgv(["team", "start", "gsd"]);
    expect(result).toMatchObject({ kind: "team-start", template: "gsd" });
  });

  it("team start propagates --concurrency, --output, and --permission-mode", () => {
    const result = parseArgv([
      "team", "start", "gsd",
      "--concurrency", "5",
      "--output", "/tmp/team-results.jsonl",
      "--permission-mode", "read-only",
    ]);
    if (result.kind !== "team-start") throw new Error("expected team-start");
    expect(result.template).toBe("gsd");
    expect(result.concurrency).toBe(5);
    expect(result.output).toBe("/tmp/team-results.jsonl");
    expect(result.permissionMode).toBe("read-only");
  });

  it("team without a sub-subcommand errors", () => {
    const result = parseArgv(["team"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team requires a sub-subcommand"),
    });
  });

  it("team start without a template errors", () => {
    const result = parseArgv(["team", "start"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("team start requires a template name"),
    });
  });

  it("team <unknown> errors with a helpful message", () => {
    const result = parseArgv(["team", "send", "msg"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("unknown team sub-subcommand"),
    });
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

  // ---- swarm run --role (M3a Phase 6) --------------------------------------

  it("swarm run with --role architect propagates the role name", () => {
    const result = parseArgv([
      "swarm", "run", "tasks.json",
      "--role", "architect",
    ]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.role).toBe("architect");
  });

  it("swarm run --role without a value errors clearly", () => {
    const result = parseArgv(["swarm", "run", "tasks.json", "--role"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--role requires a value"),
      showHelp: true,
    });
  });

  it("swarm run with --role, --dead-letter and --allow-dead-letter all parse and propagate", () => {
    const result = parseArgv([
      "swarm", "run", "tasks.json",
      "--role", "executor",
      "--dead-letter", "/tmp/dl.jsonl",
      "--allow-dead-letter",
    ]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.role).toBe("executor");
    expect(result.deadLetter).toBe("/tmp/dl.jsonl");
    expect(result.allowDeadLetter).toBe(true);
  });

  it("swarm run --role=executor (equals form) works", () => {
    const result = parseArgv([
      "swarm", "run", "tasks.json",
      "--role=executor",
    ]);
    if (result.kind !== "swarm-run") throw new Error("expected swarm-run");
    expect(result.role).toBe("executor");
  });

  // ---- --framework flag (M4a Phase 6) --------------------------------------

  it("--framework native is parsed correctly", () => {
    const result = parseArgv(["--framework", "native", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("native");
  });

  it("--framework claude-agent-sdk is parsed correctly", () => {
    const result = parseArgv(["--framework", "claude-agent-sdk", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("claude-agent-sdk");
  });

  it("--framework auto is the default when the flag is omitted", () => {
    const result = parseArgv(["do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("auto");
  });

  it("--framework auto is parsed explicitly", () => {
    const result = parseArgv(["--framework", "auto", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("auto");
  });

  it("--framework with invalid value returns error kind", () => {
    const result = parseArgv(["--framework", "foobar", "do work"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("invalid --framework"),
      showHelp: true,
    });
  });

  it("--dump-engine flag is parsed and sets dumpEngine: true", () => {
    const result = parseArgv(["--dump-engine", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.dumpEngine).toBe(true);
  });

  // ---- Phase 7: codex-chatgpt framework ------------------------------------

  it("--framework codex-chatgpt is parsed correctly", () => {
    const result = parseArgv(["--framework", "codex-chatgpt", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("codex-chatgpt");
  });

  it("--framework codex-chatgpt --model gpt-5.4 is accepted (forwarded to Codex App Server)", () => {
    const result = parseArgv(["--framework", "codex-chatgpt", "--model", "gpt-5.4", "do work"]);
    if (result.kind !== "prompt") throw new Error("expected prompt");
    expect(result.opts.framework).toBe("codex-chatgpt");
    expect(result.opts.model).toBe("gpt-5.4");
  });

  // ---- Phase 7: plugin subcommand ------------------------------------------

  it("plugin install . is detected as plugin subcommand", () => {
    const result = parseArgv(["plugin", "install", "."]);
    expect(result).toMatchObject({ kind: "plugin", pluginArgv: ["install", "."] });
  });

  it("plugin list is detected as plugin subcommand", () => {
    const result = parseArgv(["plugin", "list"]);
    expect(result).toMatchObject({ kind: "plugin", pluginArgv: ["list"] });
  });

  // ---- Phase 7: login subcommand -------------------------------------------

  it("login --provider codex-chatgpt is detected", () => {
    const result = parseArgv(["login", "--provider", "codex-chatgpt"]);
    expect(result).toMatchObject({ kind: "login", provider: "codex-chatgpt" });
  });

  it("login --provider claude-agent-sdk is detected", () => {
    const result = parseArgv(["login", "--provider", "claude-agent-sdk"]);
    expect(result).toMatchObject({ kind: "login", provider: "claude-agent-sdk" });
  });

  it("login without --provider defaults to claude-agent-sdk", () => {
    const result = parseArgv(["login"]);
    expect(result).toMatchObject({ kind: "login", provider: "claude-agent-sdk" });
  });

  // ---- Phase 7: logout subcommand ------------------------------------------

  it("logout --provider codex-chatgpt is detected", () => {
    const result = parseArgv(["logout", "--provider", "codex-chatgpt"]);
    expect(result).toMatchObject({ kind: "logout", provider: "codex-chatgpt" });
  });

  it("logout --provider claude-agent-sdk is detected", () => {
    const result = parseArgv(["logout", "--provider", "claude-agent-sdk"]);
    expect(result).toMatchObject({ kind: "logout", provider: "claude-agent-sdk" });
  });

  it("logout without --provider returns error", () => {
    const result = parseArgv(["logout"]);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("logout requires --provider"),
    });
  });
});
