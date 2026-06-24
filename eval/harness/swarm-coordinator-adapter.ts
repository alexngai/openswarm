/**
 * swarm-coordinator-adapter.ts — the H1 "team" arm: a real swarm-harness COORDINATOR team.
 *
 * The generic CLI-harness adapter can't drive `swarm-harness topology coordinator --spec <file>` (the
 * prompt lives inside the spec JSON, not as a positional), so this custom ExecutionAdapter writes a
 * coordinator TeamSpec (architect root + executor + reviewer, all on the same Bedrock model) into the
 * workspace and invokes the existing `topology` command. The root spawns the two teammates via the
 * agent tool (worker-entry has the spawn capability); they edit the shared workspace (/testbed), which
 * the swebench grader scores. Output parsing is best-effort (usage only) — the SCORE is workspace-based.
 *
 * Same model + same task as `single`; the only difference is single-agent vs a 3-agent coordinator team
 * → the H1 paired comparison.
 */
import {
  swarmHarnessParse,
  shq,
  type ExecutionAdapter,
  type PublicCell,
  type RunContext,
  type RawRun,
} from "swarmkit-eval";

export interface SwarmCoordinatorOptions {
  /** Bedrock/Anthropic env forwarded to the in-sandbox process AND its spawned workers. */
  readonly env?: Record<string, string>;
  /** Fallback model when the cell's model name is unset. */
  readonly defaultModel?: string;
  readonly permissionMode?: string;
  /** Per-cell timeout (a 3-agent team is slower than one agent). Default 30 min. */
  readonly timeoutMs?: number;
  /** Absolute path to the in-sandbox CLI (default: the installed `swarm-harness`). */
  readonly bin?: string;
  /** Teammates the architect coordinates. Default = a generic executor + reviewer (the "homogeneous"
   *  baseline). Pass a specialized roster (distinct roles/prompts, optionally per-member models) for a
   *  HETEROGENEOUS team. */
  readonly roster?: ReadonlyArray<{ role: string; prompt: string; model?: string }>;
  /** Prepended to the task prompt for the architect root — lead/orchestration framing for hetero teams. */
  readonly architectPreamble?: string;
  /** Team name in the spec (cosmetic; disambiguates logs). Default "h1-team". */
  readonly name?: string;
}

const TEAMMATES: ReadonlyArray<{ role: string; prompt: string; model?: string }> = [
  { role: "executor", prompt: "Implement the required code change in this repository to satisfy the task." },
  { role: "reviewer", prompt: "Review the implementer's change for correctness and regressions; flag fixes." },
];

export class SwarmCoordinatorAdapter implements ExecutionAdapter {
  readonly id = "swarm-coordinator";
  readonly placement = "backend" as const;

  constructor(private readonly opts: SwarmCoordinatorOptions = {}) {}

  async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
    const ws = ctx.workspace;
    if (!ws) throw new Error("SwarmCoordinatorAdapter requires a backend-provisioned workspace");

    const model = cell.model.name || this.opts.defaultModel || "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const bin = this.opts.bin ?? "swarm-harness";
    const permissionMode = this.opts.permissionMode ?? "danger-full-access";
    const agentId = ctx.env?.AGENT_ID ?? "agent";
    const dir = `.sbx/${agentId.replace(/[^\w.-]/g, "_")}`;

    // Coordinator TeamSpec: an architect root that spawns + coordinates the roster (default = the generic
    // executor+reviewer "homogeneous" baseline; a specialized roster makes it heterogeneous).
    const roster = this.opts.roster ?? TEAMMATES;
    const architectPrompt = this.opts.architectPreamble
      ? `${this.opts.architectPreamble}\n\n${cell.task.prompt}`
      : cell.task.prompt;
    const spec = {
      name: this.opts.name ?? "h1-team",
      topology: "coordinator",
      members: [
        { role: "architect", prompt: architectPrompt, longLived: true, model },
        ...roster.map((t) => ({ role: t.role, prompt: t.prompt, model: t.model ?? model })),
      ],
      coordination: { completion: { kind: "all" } },
    };
    // Requires swarm-harness with the worker model-propagation fix (commit 4d0aae1): spawned coordinator
    // workers now use the configured model (the Bedrock id). Before that fix they hardcoded the default
    // model in the RunConfig, which 400s as invalid on Bedrock.
    await ws.writeFiles([{ path: `${dir}/team.json`, content: JSON.stringify(spec, null, 2) }]);

    const resultsPath = `${dir}/results.jsonl`;
    const cmd =
      `${bin} topology coordinator --spec ${dir}/team.json --output ${resultsPath} ` +
      `--model ${shq(model)} --permission-mode ${permissionMode} --headless --output-format json`;
    const env: Record<string, string> = {
      NO_COLOR: "1",
      DISABLE_OMC: "1",
      OMC_SKIP_HOOKS: "1",
      ...this.opts.env, // CLAUDE_CODE_USE_BEDROCK + AWS creds → inherited by spawned workers
      ...(cell.arm.scaffold.env ?? {}),
      ...(ctx.env ?? {}),
      // The subprocess spawner inherits process.env; without this the spawned coordinator workers fall
      // back to swarm-harness's default model (claude-sonnet-4-6, invalid on Bedrock). Pin the Bedrock id.
      SWARM_HARNESS_MODEL: model,
      AGENT_ID: agentId,
    };

    const start = Date.now();
    const r = await ws.run(cmd, { env, timeoutMs: this.opts.timeoutMs ?? 1_800_000 });
    const parsed = swarmHarnessParse(r.stdout);
    // Best-effort token usage: the `topology coordinator` command does NOT currently surface usage —
    // stdout is just the architect's final text, and the --output stream stays empty (the coordinator
    // tallies only the root, and spawned-peer usage is never aggregated up the spawn tree). So this yields
    // nothing today and the team/hetero cost axis reads 0. Proper fix is a swarm-harness change: aggregate
    // usage across the whole spawn tree (root + peers) and emit it (ResultLine to --output, or a JSON line).
    // sumTeamUsage already handles the --output path for when that lands.
    const usage = (await sumTeamUsage(ws, resultsPath)) ?? parsed.usage;
    const raw: RawRun = {
      output: parsed.output || r.stdout.slice(0, 2000),
      workdir: ws.root,
      usage,
      trajectory: parsed.trajectory,
      durationMs: Date.now() - start,
    };
    return raw;
  }
}

/** Sum per-member token usage from the coordinator's JSONL results stream (one ResultLine per member). */
async function sumTeamUsage(
  ws: { readFile(path: string): Promise<string | null> },
  resultsPath: string,
): Promise<RawRun["usage"] | undefined> {
  const content = await ws.readFile(resultsPath).catch(() => null);
  if (!content) return undefined;
  let inT = 0, outT = 0, cr = 0, cw = 0, seen = false;
  for (const line of content.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const u = (JSON.parse(s) as {
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
      }).usage;
      if (!u) continue;
      seen = true;
      inT += u.inputTokens ?? 0;
      outT += u.outputTokens ?? 0;
      cr += u.cacheReadInputTokens ?? 0;
      cw += u.cacheWriteInputTokens ?? 0;
    } catch {
      /* skip non-JSON lines */
    }
  }
  if (!seen) return undefined;
  return { inputTokens: inT, outputTokens: outT, cacheReadTokens: cr, cacheCreationTokens: cw, totalTokens: inT + outT };
}
