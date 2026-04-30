/**
 * Regression guard for M3b audit finding C1.
 *
 * Every Tier 2 tool touches shared orchestrator state (TaskRegistry,
 * AgentInbox, RoleIndex, spawnParents, stdin, transports). The dispatcher
 * defaults `concurrencySafe !== false` to true and fan-outs via Promise.all,
 * so forgetting to mark a Tier 2 tool as unsafe would silently fan out
 * non-reentrant operations — e.g. two parallel ask_user_question calls
 * would both try to read stdin.
 *
 * This test fails if any Tier 2 tool omits `concurrencySafe: false`.
 */

import { describe, it, expect } from "vitest";
import { buildTier2Tools } from "./index.js";

describe("Tier 2 concurrency classification", () => {
  it("every Tier 2 tool declares concurrencySafe: false", () => {
    const tools = buildTier2Tools();
    for (const t of tools) {
      expect(t.spec.tier).toBe(2);
      expect(
        t.spec.concurrencySafe,
        `${t.spec.name} must declare concurrencySafe: false`,
      ).toBe(false);
    }
    // Sanity: we expect all 10 Tier 2 tools registered.
    expect(tools.length).toBeGreaterThanOrEqual(10);
  });
});
