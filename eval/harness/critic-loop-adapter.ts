/**
 * critic-loop-adapter.ts — the `advisor` arm (docs/50 §10.4): advise-don't-redo,
 * reproduced natively via the `critic-loop` topology instead of a bespoke tool.
 *
 * A cheap EXECUTOR (member 0, `executor` role → full tools) authors the deliverable;
 * a stronger, READ-ONLY CRITIC (member 1, `reviewer` role → no bash/write/edit) reviews
 * and advises. The executor revises with the critic's feedback; the loop ends when the
 * critic replies "APPROVED" or after `criticMaxIterations` rounds. The strong model
 * NEVER authors the fix — its cost is bounded to short review turns — which is the
 * Advisor tool's economics, but cross-provider and open-weight-capable (docs/50 §10.4).
 *
 * Per-tier token cost rides out on `metadata.cascade.perModel` — the shared per-model
 * cost contract `cost-frontier.parseCell` reads (NOT cascade-specific: it prices each
 * tier at its own model's rate). No `tau` ⇒ the τ-sweep correctly ignores the advisor
 * arm, but it still lands on the cost/quality frontier with no analyzer change.
 */
import {
  openSwarmParse,
  shq,
  type ExecutionAdapter,
  type PublicCell,
  type RunContext,
  type RawRun,
} from "swarmkit-eval";
import { readTeamUsage } from "./cascade-adapter.js";

export interface CriticLoopAdapterOptions {
  /** Cheap tier that authors the deliverable (`executor` role, full tools). */
  readonly executorModel: string;
  /** Strong tier that only advises (`reviewer` role — read-only, no writes). */
  readonly criticModel: string;
  /** Max executor↔critic rounds before giving up (bounds cost). Default 3. */
  readonly maxIterations?: number;
  /** Prepended to the executor's task prompt (e.g. a repro instruction). */
  readonly executorPromptPrefix?: string;
  /** The critic's standing instruction; the executor output is appended by the topology. */
  readonly criticInstruction?: string;
  readonly env?: Record<string, string>;
  readonly permissionMode?: string;
  readonly timeoutMs?: number;
  readonly bin?: string;
  readonly name?: string;
}

const DEFAULT_CRITIC_INSTRUCTION =
  "You are advising an engineer fixing the bug below. Review their latest change against " +
  "the actual repository. If the fix is correct and complete, reply with the single word " +
  "APPROVED. Otherwise give brief, specific, actionable guidance (≤80 words) on what to " +
  "change — do NOT rewrite the code yourself.";

export class CriticLoopAdapter implements ExecutionAdapter {
  readonly id = "critic-loop";
  readonly placement = "backend" as const;

  constructor(private readonly opts: CriticLoopAdapterOptions) {}

  async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
    const ws = ctx.workspace;
    if (!ws) throw new Error("CriticLoopAdapter requires a backend-provisioned workspace");
    const bin = this.opts.bin ?? "openswarm";
    const permissionMode = this.opts.permissionMode ?? "danger-full-access";
    const agentId = ctx.env?.AGENT_ID ?? "agent";
    const dir = `.sbx/${agentId.replace(/[^\w.-]/g, "_")}`;

    const prefix = this.opts.executorPromptPrefix ? `${this.opts.executorPromptPrefix}\n\n` : "";
    // Member 0 = executor (full tools, authors the fix). Member 1 = critic (reviewer role
    // → read-only; the worker's ToolDispatcher filters out bash/write/edit at registration).
    const members = [
      { id: "executor", role: "executor", model: this.opts.executorModel, prompt: `${prefix}${cell.task.prompt}` },
      { id: "critic", role: "reviewer", model: this.opts.criticModel, prompt: this.opts.criticInstruction ?? DEFAULT_CRITIC_INSTRUCTION },
    ];
    const spec = {
      name: this.opts.name ?? "advisor",
      topology: "critic-loop",
      members,
      coordination: {
        completion: { kind: "all" },
        criticMaxIterations: this.opts.maxIterations ?? 3,
      },
    };
    await ws.writeFiles([{ path: `${dir}/team.json`, content: JSON.stringify(spec, null, 2) }]);

    const resultsPath = `${dir}/results.jsonl`;
    const traceOutputPath = `${dir}/trace.jsonl`;
    const cmd =
      `${bin} topology critic-loop --spec ${dir}/team.json --output ${resultsPath} ` +
      `--trace-output ${traceOutputPath} --model ${shq(this.opts.executorModel)} ` +
      `--permission-mode ${permissionMode} --headless --output-format json`;
    const env: Record<string, string> = {
      NO_COLOR: "1",
      DISABLE_OMC: "1",
      OMC_SKIP_HOOKS: "1",
      ...this.opts.env,
      ...(cell.arm.scaffold.env ?? {}),
      ...(ctx.env ?? {}),
      AGENT_ID: agentId,
    };

    const start = Date.now();
    const r = await ws.run(cmd, { env, timeoutMs: this.opts.timeoutMs ?? 1_800_000 });
    const parsed = openSwarmParse(r.stdout);

    const teamUsage = await readTeamUsage(ws, resultsPath);
    const usage = teamUsage
      ? {
          inputTokens: teamUsage.team.inputTokens,
          outputTokens: teamUsage.team.outputTokens,
          cacheReadTokens: teamUsage.team.cacheReadInputTokens,
          cacheCreationTokens: teamUsage.team.cacheWriteInputTokens,
          totalTokens: teamUsage.team.totalTokens,
        }
      : (parsed.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 0,
        });

    return {
      output: parsed.output || r.stdout.slice(0, 2000) || `[exit ${r.exitCode}] ${r.stderr.slice(-2000)}`,
      workdir: ws.root,
      usage,
      trajectory: parsed.trajectory,
      durationMs: Date.now() - start,
      // Per-tier cost for the G2 frontier. `metadata.cascade` is the shared per-model
      // cost breakdown contract cost-frontier.parseCell reads (executor tier + critic
      // tier); no `tau` ⇒ the τ-sweep skips the advisor arm (correct — it has no gate).
      metadata: {
        cascade: {
          tiers: [this.opts.executorModel, this.opts.criticModel],
          perModel: teamUsage?.byModel ?? {},
          exitCode: r.exitCode,
          ...(r.exitCode !== 0 && { stderrTail: r.stderr.slice(-2000) }),
        },
      },
    };
  }
}
