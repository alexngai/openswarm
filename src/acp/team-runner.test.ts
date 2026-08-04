import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createOrchestratorRunner,
  resolveSteerTarget,
  steerRecipients,
} from "./team-runner.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { RoleRegistry } from "../swarm/roles.js";
import type { TeamSpec } from "../swarm/team-spec.js";

// Capture what the runner hands the Orchestrator. The bug this guards was invisible from the
// outside: the runner built a working orchestrator that simply had no role registry, so roles
// failed at dispatch rather than at construction.
const orchestratorOpts: { readonly roles?: RoleRegistry }[] = [];
vi.mock("../swarm/orchestrator.js", () => ({
  Orchestrator: class {
    constructor(opts: { readonly roles?: RoleRegistry }) {
      orchestratorOpts.push(opts);
    }
    runTeam(): Promise<unknown> {
      return Promise.resolve({});
    }
    getActiveTeam(): undefined {
      return undefined;
    }
  },
}));

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

  describe("role wiring (.openswarm/roles.json on the ACP team path)", () => {
    let cwd: string;
    let tmp: string;

    beforeEach(() => {
      orchestratorOpts.length = 0;
      cwd = process.cwd();
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-roles-"));
      process.chdir(tmp);
    });
    afterEach(() => {
      process.chdir(cwd);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const writeRoles = (): void => {
      fs.mkdirSync(path.join(tmp, ".openswarm"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".openswarm", "roles.json"),
        JSON.stringify({
          roles: [
            {
              name: "bug-reproducer",
              systemPromptSuffix: "Reproduce the failure before editing.",
              allowedTools: ["bash", "read_file"],
            },
          ],
        }),
      );
    };
    const spec: TeamSpec = {
      name: "t",
      topology: "coordinator",
      members: [{ role: "lead", prompt: "go" }],
      coordination: { completion: { kind: "all" } },
    };

    it("hands the orchestrator a registry carrying the built-ins", () => {
      createOrchestratorRunner({ permissionMode: "read-only" });
      const roles = orchestratorOpts[0]?.roles;
      expect(roles, "orchestrator got no registry — roles fail at dispatch").toBeDefined();
      expect(roles?.get("architect")).toBeDefined();
    });

    it("registers custom roles before the first dispatch", async () => {
      writeRoles();
      const runner = createOrchestratorRunner({ permissionMode: "read-only" });
      const roles = orchestratorOpts[0]?.roles;
      // Loaded lazily — the factory is synchronous, so the file cannot be read at construction.
      expect(roles?.get("bug-reproducer")).toBeUndefined();

      await runner.runTeam(spec);
      const custom = roles?.get("bug-reproducer");
      expect(custom?.systemPromptSuffix).toBe("Reproduce the failure before editing.");
      // Built-ins survive the merge rather than being replaced by the custom set.
      expect(roles?.get("architect")).toBeDefined();
    });

    it("reads roles.json once, not per run", async () => {
      writeRoles();
      const runner = createOrchestratorRunner({ permissionMode: "read-only" });
      await runner.runTeam(spec);
      fs.rmSync(path.join(tmp, ".openswarm", "roles.json"));
      await runner.runTeam(spec);
      expect(orchestratorOpts[0]?.roles?.get("bug-reproducer")).toBeDefined();
    });

    it("runs with built-ins when no roles.json exists", async () => {
      const runner = createOrchestratorRunner({ permissionMode: "read-only" });
      await expect(runner.runTeam(spec)).resolves.toBeDefined();
      expect(orchestratorOpts[0]?.roles?.get("architect")).toBeDefined();
    });
  });

  it("steer is a no-op (delivered:false) when there is no live team", async () => {
    const runner = createOrchestratorRunner({ permissionMode: "read-only" });
    const res = await runner.steer("go", "architect");
    expect(res).toEqual({ delivered: false, to: "role:architect" });
  });
});

describe("resolveSteerTarget", () => {
  it("defaults to the lead; maps bare names to roles; passes selectors through", () => {
    expect(resolveSteerTarget()).toBe("role:lead");
    expect(resolveSteerTarget("")).toBe("role:lead");
    expect(resolveSteerTarget("lead")).toBe("role:lead");
    expect(resolveSteerTarget("architect")).toBe("role:architect");
    expect(resolveSteerTarget("role:reviewer")).toBe("role:reviewer");
    expect(resolveSteerTarget("*")).toBe("*");
  });
});

describe("steerRecipients", () => {
  function m(role: string, id: string): [AgentId, MemberInfo] {
    return [
      id as AgentId,
      { memberId: `m-${id}`, role, agentId: id as AgentId, state: "running", handle: {} as MemberInfo["handle"] },
    ];
  }
  const roster = new Map<AgentId, MemberInfo>([m("lead", "L"), m("architect", "A1"), m("architect", "A2")]);

  it("defaults to the lead; resolves roles; '*' is everyone; falls back to a direct id", () => {
    expect(steerRecipients(roster)).toEqual(["L"]);
    expect(steerRecipients(roster, "lead")).toEqual(["L"]);
    expect(steerRecipients(roster, "architect").sort()).toEqual(["A1", "A2"]);
    expect(steerRecipients(roster, "role:architect").sort()).toEqual(["A1", "A2"]);
    expect(steerRecipients(roster, "*").sort()).toEqual(["A1", "A2", "L"]);
    expect(steerRecipients(roster, "A2")).toEqual(["A2"]); // direct id fallback
    expect(steerRecipients(roster, "ghost")).toEqual([]); // unknown -> none
  });
});
