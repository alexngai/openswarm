import { describe, it, expect, afterEach } from "vitest";
import {
  hardenEnv,
  strippedVars,
  getHardenedEnv,
  resetHardenedEnvCache,
  applyProcessHardening,
} from "./process-hardening.js";

afterEach(() => {
  resetHardenedEnvCache();
});

describe("hardenEnv", () => {
  it("strips LD_PRELOAD", () => {
    const env = { PATH: "/usr/bin", LD_PRELOAD: "/evil.so", HOME: "/home/user" };
    const result = hardenEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.LD_PRELOAD).toBeUndefined();
  });

  it("strips LD_LIBRARY_PATH", () => {
    const env = { LD_LIBRARY_PATH: "/evil", OTHER: "ok" };
    const result = hardenEnv(env);
    expect(result.LD_LIBRARY_PATH).toBeUndefined();
    expect(result.OTHER).toBe("ok");
  });

  it("strips all LD_ prefixed vars", () => {
    const env = { LD_AUDIT: "x", LD_DEBUG: "y", LD_CUSTOM: "z" };
    const result = hardenEnv(env);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("strips DYLD_ prefixed vars", () => {
    const env = { DYLD_INSERT_LIBRARIES: "/evil.dylib", DYLD_FRAMEWORK_PATH: "/x" };
    const result = hardenEnv(env);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("strips NODE_OPTIONS", () => {
    const env = { NODE_OPTIONS: "--require /evil.js", NODE_ENV: "test" };
    const result = hardenEnv(env);
    expect(result.NODE_OPTIONS).toBeUndefined();
    expect(result.NODE_ENV).toBe("test");
  });

  it("strips PYTHONSTARTUP and PYTHONPATH", () => {
    const env = { PYTHONSTARTUP: "/evil.py", PYTHONPATH: "/evil" };
    const result = hardenEnv(env);
    expect(result.PYTHONSTARTUP).toBeUndefined();
    expect(result.PYTHONPATH).toBeUndefined();
  });

  it("strips PERL5LIB and RUBYLIB", () => {
    const env = { PERL5LIB: "/evil", RUBYLIB: "/evil" };
    const result = hardenEnv(env);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("strips BASH_ENV and PROMPT_COMMAND", () => {
    const env = { BASH_ENV: "/evil.sh", PROMPT_COMMAND: "evil", TERM: "xterm" };
    const result = hardenEnv(env);
    expect(result.BASH_ENV).toBeUndefined();
    expect(result.PROMPT_COMMAND).toBeUndefined();
    expect(result.TERM).toBe("xterm");
  });

  it("strips JAVA_TOOL_OPTIONS", () => {
    const env = { JAVA_TOOL_OPTIONS: "-javaagent:/evil.jar" };
    const result = hardenEnv(env);
    expect(result.JAVA_TOOL_OPTIONS).toBeUndefined();
  });

  it("strips DOTNET_STARTUP_HOOKS", () => {
    const env = { DOTNET_STARTUP_HOOKS: "/evil.dll" };
    const result = hardenEnv(env);
    expect(result.DOTNET_STARTUP_HOOKS).toBeUndefined();
  });

  it("preserves safe vars", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      USER: "user",
      SHELL: "/bin/bash",
      TERM: "xterm",
      LANG: "en_US.UTF-8",
      EDITOR: "vim",
    };
    const result = hardenEnv(env);
    expect(Object.keys(result)).toHaveLength(7);
  });

  it("skips undefined values", () => {
    const env = { PATH: "/usr/bin", UNDEF: undefined } as NodeJS.ProcessEnv;
    const result = hardenEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect("UNDEF" in result).toBe(false);
  });

  it("does not mutate the input", () => {
    const env = { LD_PRELOAD: "/evil.so", PATH: "/usr/bin" };
    hardenEnv(env);
    expect(env.LD_PRELOAD).toBe("/evil.so");
  });
});

describe("strippedVars", () => {
  it("returns list of stripped var names", () => {
    const env = { LD_PRELOAD: "/evil", NODE_OPTIONS: "--x", PATH: "/bin" };
    const stripped = strippedVars(env);
    expect(stripped).toContain("LD_PRELOAD");
    expect(stripped).toContain("NODE_OPTIONS");
    expect(stripped).not.toContain("PATH");
  });
});

describe("getHardenedEnv", () => {
  it("returns a cached hardened env", () => {
    const e1 = getHardenedEnv();
    const e2 = getHardenedEnv();
    expect(e1).toBe(e2);
  });

  it("does not contain dangerous vars from process.env", () => {
    const env = getHardenedEnv();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.BASH_ENV).toBeUndefined();
  });
});

describe("applyProcessHardening", () => {
  it("returns list of stripped vars", () => {
    const stripped = applyProcessHardening();
    expect(Array.isArray(stripped)).toBe(true);
  });
});
