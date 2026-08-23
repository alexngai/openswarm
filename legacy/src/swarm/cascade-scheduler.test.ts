import { describe, it, expect, vi } from "vitest";
import { CascadeScheduler } from "./cascade-scheduler.js";
import type { CascadeRebaseResult } from "./adapters/git-cascade-branch-policy.js";

const ok: CascadeRebaseResult = { success: true, rebased: [] };

describe("CascadeScheduler", () => {
  it("coalesces repeated requests for the same root into one run on flush", async () => {
    const run = vi.fn(async () => ok);
    const s = new CascadeScheduler({ run, debounceMs: 10_000 });
    s.request("root");
    s.request("root");
    s.request("root");
    const results = await s.flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("root");
    expect(results.get("root")).toEqual(ok);
  });

  it("runs distinct roots independently", async () => {
    const run = vi.fn(async (r: string) => ({ success: true, rebased: [{ streamId: r }] }));
    const s = new CascadeScheduler({ run, debounceMs: 10_000 });
    s.request("a");
    s.request("b");
    const results = await s.flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(results.get("a")).toMatchObject({ success: true });
    expect(results.get("b")).toMatchObject({ success: true });
  });

  it("auto-fires once after the debounce window", async () => {
    const run = vi.fn(async () => ok);
    const s = new CascadeScheduler({ run, debounceMs: 20 });
    s.request("root");
    s.request("root"); // re-arms; still one fire
    await new Promise((r) => setTimeout(r, 60));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush is idempotent when nothing is pending (post auto-fire)", async () => {
    const run = vi.fn(async () => ok);
    const s = new CascadeScheduler({ run, debounceMs: 10 });
    s.request("root");
    await new Promise((r) => setTimeout(r, 40)); // auto-fires
    const results = await s.flush(); // nothing pending
    expect(run).toHaveBeenCalledTimes(1);
    expect(results.get("root")).toEqual(ok);
  });

  it("captures a thrown run as a failure result", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const s = new CascadeScheduler({ run, debounceMs: 10_000 });
    s.request("root");
    const results = await s.flush();
    expect(results.get("root")).toMatchObject({ success: false, error: "boom" });
  });

  it("cancel() drops pending timers without running", async () => {
    const run = vi.fn(async () => ok);
    const s = new CascadeScheduler({ run, debounceMs: 20 });
    s.request("root");
    s.cancel();
    await new Promise((r) => setTimeout(r, 60));
    expect(run).not.toHaveBeenCalled();
  });
});
