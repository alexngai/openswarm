/**
 * Tests for the `agent` Tier 2 tool — v0.4 stage 4E.1 additions.
 *
 * Focused on the new `team` and `framework` parameters: verifies they
 * propagate to the SpawnRequest correctly and that backward-compatible
 * callers (no team / framework) keep their existing behavior.
 */

import { describe, it, expect } from "vitest";
import { agentTool } from "./agent.js";
import { makeFakeHost } from "./_fake-host.js";
import type { AgentId } from "../../core/types.js";

const CTX_CWD = process.cwd();

describe("agent tool — team parameter", () => {
  it('team: "self" sets teamScope on the SpawnRequest to the caller\'s scope', async () => {
    const { host, calls } = makeFakeHost();
    // Augment the fake host with scopeOf so the tool's standalone branch
    // can resolve the caller's team. Caller is a synthetic team scope.
    const callerScope = "swarm:team-a";
    (host as unknown as { scopeOf: (id: AgentId) => string }).scopeOf = () =>
      callerScope;

    const result = await agentTool.execute(
      { prompt: "do work", team: "self", wait: false },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]?.teamScope).toBe(callerScope);
  });

  it('team: "child" leaves teamScope undefined (today\'s default behavior)', async () => {
    const { host, calls } = makeFakeHost();
    (host as unknown as { scopeOf: (id: AgentId) => string }).scopeOf = () =>
      "swarm:team-a";

    const result = await agentTool.execute(
      { prompt: "do work", team: "child", wait: false },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]?.teamScope).toBeUndefined();
  });

  it("omitting team is equivalent to team: 'child' — teamScope undefined", async () => {
    const { host, calls } = makeFakeHost();
    (host as unknown as { scopeOf: (id: AgentId) => string }).scopeOf = () =>
      "swarm:team-a";

    const result = await agentTool.execute(
      { prompt: "do work", wait: false },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]?.teamScope).toBeUndefined();
  });
});

describe("agent tool — framework parameter", () => {
  it("plumbs framework through to the SpawnRequest", async () => {
    const { host, calls } = makeFakeHost();
    const result = await agentTool.execute(
      { prompt: "do work", framework: "codex-chatgpt", wait: false },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]?.framework).toBe("codex-chatgpt");
  });

  it("omitted framework leaves it undefined on SpawnRequest", async () => {
    const { host, calls } = makeFakeHost();
    const result = await agentTool.execute(
      { prompt: "do work", wait: false },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(calls.spawn).toHaveLength(1);
    expect(calls.spawn[0]?.framework).toBeUndefined();
  });
});
