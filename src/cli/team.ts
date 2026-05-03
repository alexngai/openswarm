/**
 * team.ts — implementation of `swarm-harness team start <template>`.
 *
 * v0.4 stage 4F: minimal CLI surface that loads an openteams template,
 * maps it to a TeamSpec, and runs it through the Orchestrator. Full CLI
 * surface (`team send`, `team list`, `team stop`, `--map`) lands in 4K.
 */

import * as fs from "node:fs";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator } from "../swarm/orchestrator.js";
import { loadTemplate } from "../swarm/openteams/loader.js";
import { openteamsToTeamSpec } from "../swarm/openteams/mapping.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TeamStartOptions {
  readonly permissionMode: PermissionMode;
  readonly concurrency: number;
  /** Results JSONL file. Default upstream of here: ./results.jsonl */
  readonly output: string;
  /** Override openteams binary (testing). */
  readonly openteamsBinary?: string;
  /** Read template from a fixture dir instead of shelling out (testing). */
  readonly fixtureDir?: string;
}

// ---------------------------------------------------------------------------
// runTeamStart
// ---------------------------------------------------------------------------

export async function runTeamStart(
  templateName: string,
  opts: TeamStartOptions,
): Promise<number> {
  // 1. Load openteams template.
  let config;
  try {
    config = await loadTemplate(templateName, {
      ...(opts.openteamsBinary !== undefined && {
        openteamsBinary: opts.openteamsBinary,
      }),
      ...(opts.fixtureDir !== undefined && { fixtureDir: opts.fixtureDir }),
    });
  } catch (err) {
    process.stderr.write(
      `error: failed to load template "${templateName}": ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 2. Map to TeamSpec.
  let spec;
  try {
    spec = openteamsToTeamSpec(config);
  } catch (err) {
    process.stderr.write(
      `error: failed to map template "${templateName}" to TeamSpec: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  // 3. Open results stream + orchestrator.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
  });

  // 4. Run.
  const startedAt = Date.now();
  const result = await orch.runTeam(spec);
  const elapsed = Date.now() - startedAt;

  await new Promise<void>((resolve) => resultsOut.end(resolve));

  process.stderr.write(
    `[swarm-harness] team "${spec.name}" complete in ${elapsed}ms: ` +
      `${result.succeeded} succeeded, ${result.failed} failed, ${result.timeout} timeout, ${result.cancelled} cancelled\n`,
  );
  if (result.aggregateOutput !== undefined) {
    process.stdout.write(`${result.aggregateOutput}\n`);
  }

  return result.failed > 0 || result.timeout > 0 || result.cancelled > 0
    ? 1
    : 0;
}
