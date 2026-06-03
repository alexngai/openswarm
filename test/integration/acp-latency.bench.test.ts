/**
 * First-event latency benchmark (docs/33 §9) — gated by SWARM_ACP_BENCH=1.
 *
 * Team-by-default routes every prompt through a spawned root worker (dist/cli.js)
 * + a worker_ready handshake, where --single runs the engine in-process. This
 * measures that overhead deterministically (scripted engine, no model): wall-clock
 * from runTeam() to the root's first engine event ("first token" equivalent).
 * The single path's in-process equivalent is sub-millisecond, so the team number
 * IS approximately the team-vs-single delta.
 *
 *   SWARM_ACP_BENCH=1 npx vitest run test/integration/acp-latency.bench.test.ts
 */

import { describe, it } from "vitest";
import * as path from "node:path";
import { createOrchestratorRunner } from "../../src/acp/team-runner.js";
import { buildCoordinatorSpec } from "../../src/acp/team-config.js";

const BENCH = process.env.SWARM_ACP_BENCH === "1";
const TEXT_FIXTURE = path.resolve(
  process.cwd(),
  "test/fixtures/worker-scripts/text-only.json",
);

function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

describe("ACP team first-event latency (bench)", () => {
  (BENCH ? it : it.skip)(
    "measures runTeam -> first root engine event over N iterations",
    async () => {
      process.env.SWARM_HARNESS_TEST_SCRIPT = TEXT_FIXTURE;
      const N = Number(process.env.SWARM_ACP_BENCH_N ?? "8");
      const samples: number[] = [];

      for (let i = 0; i < N; i++) {
        const runner = createOrchestratorRunner({ permissionMode: "workspace-write" });
        let first = 0;
        const start = performance.now();
        const unsub = runner.subscribeEvents((e) => {
          if (first === 0 && e.type === "text_delta") first = performance.now();
        });
        await runner.runTeam(buildCoordinatorSpec("hi"));
        unsub();
        await runner.getActiveTeam()?.dispose().catch(() => {});
        if (first > 0) samples.push(first - start);
      }

      samples.sort((a, b) => a - b);
      const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
      // eslint-disable-next-line no-console
      console.log(
        `\n[acp-bench] team first-event latency over ${samples.length} runs (ms):` +
          `\n  min=${samples[0]?.toFixed(0)} p50=${pct(samples, 50).toFixed(0)} ` +
          `p90=${pct(samples, 90).toFixed(0)} max=${samples[samples.length - 1]?.toFixed(0)} ` +
          `mean=${mean.toFixed(0)}\n  (--single in-process equivalent is sub-ms; this ~= the delta)\n`,
      );
    },
    120_000,
  );
});
