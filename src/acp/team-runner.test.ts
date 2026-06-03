import { describe, it, expect } from "vitest";
import { createOrchestratorRunner } from "./team-runner.js";

describe("createOrchestratorRunner", () => {
  it("constructs the runner surface; subscribe/unsubscribe resolve the lane bus", () => {
    // Guards the duck-typed StandaloneHost.events access (team-daemon's pattern).
    const runner = createOrchestratorRunner({ permissionMode: "read-only" });
    expect(typeof runner.runTeam).toBe("function");

    let calls = 0;
    const unsubscribe = runner.subscribeEvents(() => {
      calls += 1;
    });
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();

    expect(runner.getActiveTeam()).toBeUndefined();
    expect(calls).toBe(0);
  });
});
