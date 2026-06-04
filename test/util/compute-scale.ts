/**
 * compute-scale — gracefully throttle test-side deadlines with available compute.
 *
 * The subprocess integration suites assert against wall-clock tolerances (e.g.
 * "a heartbeat arrives within 2s", "the orchestrator exits within 8s"). Those
 * tolerances are TEST-side slack, not production contracts — the production
 * timing values (e.g. the 500ms per-attempt budget) stay fixed. Under heavy
 * parallel load the machine spawns subprocesses slowly and the slack is
 * exceeded, producing flakes that have nothing to do with correctness.
 *
 * `scaleMs(base)` multiplies a tolerance by a factor derived from how slow this
 * machine currently spawns a trivial process — the exact bottleneck. On an idle
 * machine the factor is ~1 (deadlines unchanged); under contention it grows so
 * the tolerance tracks reality. Override with `TEST_TIME_SCALE` (e.g. in CI).
 *
 * Only apply this to test-side tolerances. Never scale a value that encodes a
 * behavior under test.
 */

import { spawnSync } from "node:child_process";

let cachedScale: number | undefined;

/** A trivial spawn on an unloaded modern dev machine lands well under this. */
const BASELINE_SPAWN_MS = 80;
const MIN_SCALE = 1;
const MAX_SCALE = 8;

export function computeScale(): number {
  if (cachedScale !== undefined) return cachedScale;

  const override = Number(process.env.TEST_TIME_SCALE);
  if (Number.isFinite(override) && override > 0) {
    cachedScale = override;
    return cachedScale;
  }

  let measured = BASELINE_SPAWN_MS;
  try {
    // Two samples, averaged — one warm-up is enough to smooth jitter while
    // still reflecting current contention.
    const samples: number[] = [];
    for (let i = 0; i < 2; i++) {
      const start = Date.now();
      spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
      samples.push(Date.now() - start);
    }
    measured = (samples[0]! + samples[1]!) / 2;
  } catch {
    // If probing fails, stay neutral.
    measured = BASELINE_SPAWN_MS;
  }

  cachedScale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, measured / BASELINE_SPAWN_MS),
  );
  return cachedScale;
}

/** Scale a test-side deadline/timeout (ms) by the machine's measured load. */
export function scaleMs(baseMs: number): number {
  return Math.round(baseMs * computeScale());
}
