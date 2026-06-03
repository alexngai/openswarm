/**
 * Deterministic integration test for the ACP team permission path.
 *
 * The single LIVE-gated e2e aside (src/acp/e2e.test.ts), nothing in CI exercised
 * the *real* coordinator+worker+IPC+permission round-trip — the fakes in
 * team-agent.test.ts bypass the orchestrator and the subprocess entirely. This
 * closes that gap without a model:
 *
 *   createOrchestratorRunner (real Orchestrator + StandaloneHost)
 *     -> coordinator topology spawns a real `dist/cli.js --worker` root
 *        -> ScriptedTestEngine invokes config.canUseTool("write_file", …)
 *           -> buildWorkerCanUseTool denies under read-only + escalates
 *              -> permission.request IPC -> StandaloneHost.resolvePermission
 *                 -> our InteractionHandler captures the escalation.
 *
 * The scripted `canUseTool` directive (test-engine.ts) is what makes the worker
 * trigger the gate deterministically.
 *
 * Prereq: dist built via test/integration/global-setup.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import { scaleMs } from "../util/compute-scale.js";
import { createOrchestratorRunner } from "../../src/acp/team-runner.js";
import type { TeamRunner } from "../../src/acp/team-runner.js";
import { buildCoordinatorSpec } from "../../src/acp/team-config.js";
import type {
  InteractionHandler,
  PermissionRequest,
} from "../../src/swarm/host.js";

const ESCALATE_FIXTURE = path.resolve(
  process.cwd(),
  "test/fixtures/worker-scripts/escalate-write.json",
);

let runner: TeamRunner | undefined;

afterEach(async () => {
  await runner
    ?.getActiveTeam()
    ?.dispose()
    .catch(() => {});
  runner = undefined;
});

/** Set an env var, returning a restore thunk that resets it precisely. */
function withEnv(key: string, value: string): () => void {
  const prev = process.env[key];
  process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

describe("ACP team — real coordinator+worker+IPC permission escalation", () => {
  it(
    "routes a member's mode-denied write to the InteractionHandler",
    async () => {
      // Spawned workers inherit these via subprocess-spawner's ...process.env.
      const restoreScript = withEnv("SWARM_HARNESS_TEST_SCRIPT", ESCALATE_FIXTURE);
      const restoreEsc = withEnv("SWARM_HARNESS_PERMISSION_ESCALATION", "1");

      const captured: PermissionRequest[] = [];
      const handler: InteractionHandler = {
        requestPermission: async (req) => {
          captured.push(req);
          // Deny so nothing is actually written — we only verify the round-trip.
          return { outcome: "deny", reason: "test-policy" };
        },
      };

      const r = createOrchestratorRunner({
        permissionMode: "read-only",
        interactionHandler: handler,
      });
      runner = r;

      try {
        const result = await r.runTeam(buildCoordinatorSpec("probe a write"));

        // The root attempted write_file under read-only -> escalated over IPC.
        expect(captured.length).toBeGreaterThan(0);
        expect(captured[0]!.toolName).toBe("write_file");
        expect(captured[0]!.currentMode).toBe("read-only");
        expect(captured[0]!.requiredPermission).toBe("write");
        // The escalation is attributed to the requesting member (the root).
        expect(captured[0]!.agentId).toBeTruthy();
        // The scripted engine still completes the turn (message_stop) -> success.
        expect(result.succeeded).toBe(1);
      } finally {
        await r
          .getActiveTeam()
          ?.dispose()
          .catch(() => {});
        runner = undefined;
        restoreEsc();
        restoreScript();
      }
    },
    scaleMs(30_000),
  );
});
