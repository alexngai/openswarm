/**
 * bash-mode.test.ts — `!cmd` shell escape runner (doc 49 Phase E1).
 */

import { describe, it, expect } from "vitest";
import { runBangCommand } from "./bash-mode.js";

describe("runBangCommand", () => {
  it("captures stdout and a zero exit code", async () => {
    const res = await runBangCommand("echo hello-bash-mode");
    expect(res.code).toBe(0);
    expect(res.output).toContain("hello-bash-mode");
  });

  it("reports a non-zero exit code", async () => {
    const res = await runBangCommand("exit 3");
    expect(res.code).toBe(3);
  });

  it("captures stderr output", async () => {
    const res = await runBangCommand("echo oops 1>&2");
    expect(res.output).toContain("oops");
  });
});
