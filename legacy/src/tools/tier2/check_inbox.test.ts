/**
 * Focused tests for the `check_inbox` tool. Most integration coverage lives in
 * `send_message.test.ts`; this file pins down the input-schema behavior and
 * host-missing error surface so those stay stable.
 */

import { describe, it, expect } from "vitest";
import { checkInboxTool } from "./check_inbox.js";
import { makeFakeHost } from "./_fake-host.js";

describe("check_inbox tool — schema + host presence", () => {
  it("throws when no host is present (dispatcher wraps into ToolResult)", async () => {
    await expect(
      checkInboxTool.execute({ max: 5 }, { cwd: process.cwd() }),
    ).rejects.toThrow(/check_inbox requires SwarmHost/);
  });

  it("applies the default max when input is empty", async () => {
    const { host } = makeFakeHost();
    const res = await checkInboxTool.execute(
      {},
      { cwd: process.cwd(), host },
    );
    expect(res.status).toBe("ok");
    expect(
      JSON.parse((res as { status: "ok"; output: string }).output),
    ).toEqual([]);
  });

  it("rejects non-positive max", async () => {
    const { host } = makeFakeHost();
    const res = await checkInboxTool.execute(
      { max: 0 },
      { cwd: process.cwd(), host },
    );
    expect(res.status).toBe("error");
  });

  it("returns [] from the fake host's always-empty inbox", async () => {
    const { host } = makeFakeHost();
    const res = await checkInboxTool.execute(
      { max: 3 },
      { cwd: process.cwd(), host },
    );
    expect(res.status).toBe("ok");
    expect((res as { status: "ok"; output: string }).output).toBe("[]");
  });
});
