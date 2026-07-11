/**
 * cascade-adapter.ts — the CascadeTopology as one eval cell (docs/51 B1).
 *
 * Writes a cascade TeamSpec (ordered cheap→expensive tiers, each its own model, plus
 * the escalation gate τ and the visible-test confidence COMMAND) into the workspace,
 * invokes `openswarm topology cascade`, and returns a RawRun. Per-tier token cost
 * (`byModel`) + the escalation count ride out on `submission.cascade` for the
 * CostModel / G2 frontier; the SCORE is workspace-based (the benchmark's scoring
 * grader runs after, on the finished workspace).
 *
 * The confidence signal is IN-PROCESS: `escalationCommand` (e.g. `python3 -m pytest -q`)
 * is run by the topology in the tier workspace → a visible-test pass-rate (docs/51 §1).
 * It MUST be VISIBLE-only — never the held-out scoring tests (docs/50 §8.1 leakage).
 */
import {
  openSwarmParse,
  shq,
  type ExecutionAdapter,
  type PublicCell,
  type RunContext,
  type RawRun,
} from "swarmkit-eval";

export interface CascadeTierSpec {
  /** The model this tier runs (the heterogeneity). Cheapest tier first. */
  readonly model: string;
  readonly role?: string;
  /** Prompt override; defaults to the task prompt. */
  readonly prompt?: string;
}

export interface CascadeAdapterOptions {
  /** Ordered tiers, cheap → expensive. */
  readonly tiers: ReadonlyArray<CascadeTierSpec>;
  /** Escalation gate τ ∈ [0,1]: escalate when a tier's confidence is below τ. */
  readonly tau: number;
  /** VISIBLE-only confidence command run in the tier workspace (→ pass-rate). Omit for
   *  single-tier (mono) arms, which never escalate. */
  readonly escalationCommand?: string;
  /** Composite gate (docs/50 §10.4 step 3): several visible checks (e.g. [compile-gate,
   *  authored-repro]) combined weakest-link — ALL must clear τ. Supersedes escalationCommand. */
  readonly escalationCommands?: readonly string[];
  readonly env?: Record<string, string>;
  readonly permissionMode?: string;
  readonly timeoutMs?: number;
  readonly bin?: string;
  readonly name?: string;
  /** Prepended to every tier's prompt (e.g. the "write a repro test, then fix" instruction). */
  readonly promptPrefix?: string;
}

/** Shape of a `UsageTotals` line (matches src/swarm/usage-aggregator.ts). */
interface UsageTotalsLine {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly totalTokens: number;
  /** LLM calls (docs/53 TE-14) — present once the harness records it. */
  readonly calls?: number;
  readonly costUsd: number;
}
interface TeamUsageLine {
  readonly type: "team_usage";
  readonly byModel: Record<string, UsageTotalsLine>;
  readonly team: UsageTotalsLine;
}

export class CascadeAdapter implements ExecutionAdapter {
  readonly id = "cascade";
  readonly placement = "backend" as const;

  constructor(private readonly opts: CascadeAdapterOptions) {
    if (opts.tiers.length === 0) throw new Error("CascadeAdapter: at least one tier is required");
  }

  async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
    const ws = ctx.workspace;
    if (!ws) throw new Error("CascadeAdapter requires a backend-provisioned workspace");
    const bin = this.opts.bin ?? "openswarm";
    const permissionMode = this.opts.permissionMode ?? "danger-full-access";
    const agentId = ctx.env?.AGENT_ID ?? "agent";
    const dir = `.sbx/${agentId.replace(/[^\w.-]/g, "_")}`;

    const prefix = this.opts.promptPrefix ? `${this.opts.promptPrefix}\n\n` : "";
    const members = this.opts.tiers.map((t, i) => ({
      id: `tier-${i}`,
      role: t.role ?? "worker",
      prompt: `${prefix}${t.prompt ?? cell.task.prompt}`,
      model: t.model,
    }));
    const spec = {
      name: this.opts.name ?? "cascade",
      topology: "cascade",
      members,
      coordination: {
        completion: { kind: "all" },
        escalationTau: this.opts.tau,
        ...(this.opts.escalationCommands !== undefined && this.opts.escalationCommands.length > 0
          ? { escalationEvaluator: "command", escalationCommands: this.opts.escalationCommands }
          : this.opts.escalationCommand !== undefined && {
              escalationEvaluator: "command",
              escalationCommand: this.opts.escalationCommand,
            }),
      },
    };
    await ws.writeFiles([{ path: `${dir}/team.json`, content: JSON.stringify(spec, null, 2) }]);

    const resultsPath = `${dir}/results.jsonl`;
    const traceOutputPath = `${dir}/trace.jsonl`;
    const cmd =
      `${bin} topology cascade --spec ${dir}/team.json --output ${resultsPath} ` +
      `--trace-output ${traceOutputPath} --model ${shq(this.opts.tiers[0]!.model)} ` +
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
    // Contain sandbox deaths (e.g. E2B "terminated" mid-run): one dying cell must
    // not crash the whole sweep. A zero-token failed RawRun is recorded instead —
    // aggregate()'s infra-failure guard already excludes it from frontier means.
    let r: Awaited<ReturnType<typeof ws.run>>;
    try {
      r = await ws.run(cmd, { env, timeoutMs: this.opts.timeoutMs ?? 1_800_000 });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cascade] sandbox died for ${cell.task.id}: ${msg}`);
      return {
        output: `[env-error] sandbox died: ${msg.slice(0, 300)}`,
        workdir: ws.root,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0 },
        trajectory: [],
        durationMs: Date.now() - start,
        metadata: { cascade: { tiers: this.opts.tiers.map((t) => t.model), tau: this.opts.tau, perModel: {}, exitCode: -1, stderrTail: msg.slice(0, 500) } },
      };
    }
    const parsed = openSwarmParse(r.stdout);

    const teamUsage = await readTeamUsage(ws, resultsPath);
    const escalations = await readEscalations(ws, traceOutputPath);
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
      // Fall back to the command's stderr tail so a failed `topology cascade` is diagnosable
      // (the topology command's real error goes to stderr, not stdout).
      output: parsed.output || r.stdout.slice(0, 2000) || `[exit ${r.exitCode}] ${r.stderr.slice(-2000)}`,
      workdir: ws.root,
      usage,
      trajectory: parsed.trajectory,
      durationMs: Date.now() - start,
      // Per-tier cost + escalation count for the CostModel/G2 frontier (docs/51 §5).
      // `metadata` (not `submission`): swarmkit-eval persists raw.metadata onto the
      // cached cell result (orchestrator.ts), whereas submission is grader-only and
      // not stored — so the frontier analyzer can read this back per cell.
      metadata: {
        cascade: {
          tiers: this.opts.tiers.map((t) => t.model),
          tau: this.opts.tau,
          ...(escalations !== undefined && { escalations }),
          perModel: teamUsage?.byModel ?? {},
          // Team-wide LLM-call count → context-per-call in the frontier (docs/53 TE-14).
          ...(teamUsage?.team.calls !== undefined && { teamCalls: teamUsage.team.calls }),
          exitCode: r.exitCode,
          ...(r.exitCode !== 0 && { stderrTail: r.stderr.slice(-2000) }),
        },
      },
    };
  }
}

/** Read the `{type:"team_usage", byModel, team}` line runTopology writes to --output. */
export async function readTeamUsage(
  ws: { readFile(path: string): Promise<string | null> },
  resultsPath: string,
): Promise<TeamUsageLine | undefined> {
  const content = await ws.readFile(resultsPath).catch(() => null);
  if (!content) return undefined;
  for (const line of content.split("\n").reverse()) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const obj = JSON.parse(s) as { type?: string };
      if (obj.type === "team_usage") return obj as TeamUsageLine;
    } catch {
      /* skip non-JSON */
    }
  }
  return undefined;
}

/** Escalation count from the cascade's team_note lane event ("… after N escalation(s) …"). */
export async function readEscalations(
  ws: { readFile(path: string): Promise<string | null> },
  traceOutputPath: string,
): Promise<number | undefined> {
  const content = await ws.readFile(traceOutputPath).catch(() => null);
  if (!content) return undefined;
  for (const line of content.split("\n")) {
    const m = /after (\d+) escalation/.exec(line);
    if (m) return Number(m[1]);
  }
  return undefined;
}
