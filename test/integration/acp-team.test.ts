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
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { scaleMs } from "../util/compute-scale.js";
import { createOrchestratorRunner } from "../../src/acp/team-runner.js";
import type { TeamRunner } from "../../src/acp/team-runner.js";
import { buildCoordinatorSpec } from "../../src/acp/team-config.js";
import {
  startSpineRecorder,
  acpEventsPath,
  acpSessionDir,
} from "../../src/acp/spine.js";
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
      // The worker inherits the fixture path via subprocess-spawner's
      // ...process.env. Escalation is NOT set here: the host enables it because
      // it holds an interactionHandler (scoped to the worker's env), so this
      // also exercises that wiring (no process.env mutation).
      const restoreScript = withEnv("SWARM_HARNESS_TEST_SCRIPT", ESCALATE_FIXTURE);

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
        restoreScript();
      }
    },
    scaleMs(30_000),
  );

  it(
    "persists an attributed orchestration spine from the real lane bus (B1.3)",
    async () => {
      const restoreScript = withEnv("SWARM_HARNESS_TEST_SCRIPT", ESCALATE_FIXTURE);
      const handler: InteractionHandler = {
        requestPermission: async () => ({ outcome: "deny", reason: "test-policy" }),
      };
      const r = createOrchestratorRunner({
        permissionMode: "read-only",
        interactionHandler: handler,
      });
      runner = r;

      const sessionId = randomUUID();
      const dir = acpSessionDir(sessionId);
      const spine = startSpineRecorder(r);
      try {
        spine.start(sessionId);
        await r.runTeam(buildCoordinatorSpec("probe a write"));
        await spine.stop();

        const lines = fs
          .readFileSync(acpEventsPath(sessionId), "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>);

        // Header, then real recorded lane events — each ts + agentId attributed.
        expect(lines[0]!.type).toBe("_metadata");
        const events = lines.slice(1);
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(typeof e.ts).toBe("number");
          expect(typeof e.agentId).toBe("string");
        }
        // The root worker's lifecycle is on the spine; live-only text_delta is not.
        const types = new Set(events.map((e) => e.type));
        expect(types.has("worker_spawned")).toBe(true);
        expect(types.has("text_delta")).toBe(false);
      } finally {
        await spine.stop().catch(() => {});
        await r.getActiveTeam()?.dispose().catch(() => {});
        runner = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
        restoreScript();
      }
    },
    scaleMs(30_000),
  );
});
