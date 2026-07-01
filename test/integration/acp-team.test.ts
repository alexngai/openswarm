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
  readSpine,
  acpEventsPath,
  acpSessionDir,
  acpSidecarPath,
} from "../../src/acp/spine.js";
import { replayTeamSpine } from "../../src/acp/team-history.js";
import { readSessionSidecar } from "../../src/cli/session-sidecar.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  InteractionHandler,
  PermissionRequest,
} from "../../src/swarm/host.js";

const ESCALATE_FIXTURE = path.resolve(
  process.cwd(),
  "test/fixtures/worker-scripts/escalate-write.json",
);
const TEXT_FIXTURE = path.resolve(
  process.cwd(),
  "test/fixtures/worker-scripts/text-only.json",
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
      const restoreScript = withEnv("OPENSWARM_TEST_SCRIPT", ESCALATE_FIXTURE);

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
    "steers a live team: swarm/steer delivers to the real root's inbox (B2.0)",
    async () => {
      const restoreScript = withEnv("OPENSWARM_TEST_SCRIPT", TEXT_FIXTURE);
      const r = createOrchestratorRunner({ permissionMode: "workspace-write" });
      runner = r;
      try {
        await r.runTeam(buildCoordinatorSpec("hi"));
        // The long-lived root is registered under role "lead"; steering it
        // resolves to its inbox.
        const res = await r.steer("focus on auth", "lead");
        expect(res).toEqual({ delivered: true, to: "role:lead" });
        // A bogus role has no recipient -> not delivered.
        const miss = await r.steer("nobody home", "ghost");
        expect(miss.delivered).toBe(false);
      } finally {
        await r.getActiveTeam()?.dispose().catch(() => {});
        runner = undefined;
        restoreScript();
      }
    },
    scaleMs(30_000),
  );

  it(
    "persists an attributed orchestration spine from the real lane bus (B1.3)",
    async () => {
      const restoreScript = withEnv("OPENSWARM_TEST_SCRIPT", ESCALATE_FIXTURE);
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

        // B1.4: the persisted spine re-projects via session/load replay.
        const replayed: SessionUpdate[] = [];
        await replayTeamSpine(
          { sessionUpdate: async (n) => { replayed.push(n.update); } },
          sessionId,
          readSpine(sessionId),
        );
        // Replay reconstructs a roster from worker_spawned -> a plan board.
        expect(replayed.some((u) => u.sessionUpdate === "plan")).toBe(true);
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

  it(
    "persists then resumes the lead engine session across processes (B1.4 live resume)",
    async () => {
      const sessionId = randomUUID();
      const dir = acpSessionDir(sessionId);
      const sidecarPath = acpSidecarPath(sessionId);
      const restoreScript = withEnv("OPENSWARM_TEST_SCRIPT", TEXT_FIXTURE);
      const restoreSid = withEnv("OPENSWARM_TEST_SESSION_ID", "sess-1");
      try {
        // Process 1: the root persists its engine session id to the sidecar.
        const r1 = createOrchestratorRunner({ permissionMode: "workspace-write" });
        runner = r1;
        await r1.runTeam(buildCoordinatorSpec("hello", undefined, sidecarPath));
        await r1.getActiveTeam()?.dispose().catch(() => {});
        expect(readSessionSidecar(sidecarPath)).toBe("sess-1");

        // Process 2: a fresh team reads the sidecar and resumes that session on
        // its first turn (the scripted engine echoes the resumed id).
        const restoreEcho = withEnv("OPENSWARM_TEST_ECHO_RESUME", "1");
        try {
          const r2 = createOrchestratorRunner({ permissionMode: "workspace-write" });
          runner = r2;
          const texts: string[] = [];
          const unsub = r2.subscribeEvents((e) => {
            if (e.type === "text_delta") {
              const t = (e.payload as { text?: string }).text;
              if (t !== undefined) texts.push(t);
            }
          });
          await r2.runTeam(buildCoordinatorSpec("again", undefined, sidecarPath));
          unsub();
          await r2.getActiveTeam()?.dispose().catch(() => {});
          // The fresh root resumed sess-1 from the sidecar — cross-process.
          expect(texts.join("")).toContain("RESUMED:sess-1");
        } finally {
          restoreEcho();
        }
      } finally {
        runner = undefined;
        fs.rmSync(dir, { recursive: true, force: true });
        restoreSid();
        restoreScript();
      }
    },
    scaleMs(45_000),
  );
});
