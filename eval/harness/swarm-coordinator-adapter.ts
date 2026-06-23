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
}

const TEAMMATES = [
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

    // Coordinator TeamSpec: an architect root that spawns the two teammates; all on the same model.
    const spec = {
      name: "h1-team",
      topology: "coordinator",
      members: [
        { role: "architect", prompt: cell.task.prompt, longLived: true, model },
        ...TEAMMATES.map((t) => ({ ...t, model })),
      ],
      coordination: { completion: { kind: "all" } },
    };
    await ws.writeFiles([{ path: `${dir}/team.json`, content: JSON.stringify(spec, null, 2) }]);

    const cmd =
      `${bin} topology coordinator --spec ${dir}/team.json ` +
      `--model ${shq(model)} --permission-mode ${permissionMode} --headless --output-format json`;
    const env: Record<string, string> = {
      NO_COLOR: "1",
      DISABLE_OMC: "1",
      OMC_SKIP_HOOKS: "1",
      ...this.opts.env, // CLAUDE_CODE_USE_BEDROCK + AWS creds → inherited by spawned workers
      ...(cell.arm.scaffold.env ?? {}),
      ...(ctx.env ?? {}),
      AGENT_ID: agentId,
    };

    const start = Date.now();
    const r = await ws.run(cmd, { env, timeoutMs: this.opts.timeoutMs ?? 1_800_000 });
    const parsed = swarmHarnessParse(r.stdout);
    const raw: RawRun = {
      output: parsed.output || r.stdout.slice(0, 2000),
      workdir: ws.root,
      usage: parsed.usage,
      trajectory: parsed.trajectory,
      durationMs: Date.now() - start,
    };
    return raw;
  }
}
