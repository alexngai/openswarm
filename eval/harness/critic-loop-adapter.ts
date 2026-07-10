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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /** Visible-correctness command (docs/50 §10.4 step 1): when it passes the loop approves and
   *  STOPS before the critic can regress a passing fix. Pairs with executorPromptPrefix telling
   *  the executor to author the test it runs. Omit ⇒ pure critic-driven approval. */
  readonly greenCommand?: string;
  /** Pass-rate threshold for greenCommand (default 1 = all pass). */
  readonly greenThreshold?: number;
  /** docs/52 Phase B ①a — keep executor + critic resident (longLived + runMore) across rounds
   *  so both accumulate context, instead of a cold re-spawn each round. Default false. */
  readonly residentDialogue?: boolean;
  readonly env?: Record<string, string>;
  readonly permissionMode?: string;
  readonly timeoutMs?: number;
  readonly bin?: string;
  readonly name?: string;
  /** Diagnostic (docs/50 §10.4): copy the sandbox's lane trace + per-agent transcripts
   *  to this LOCAL dir before teardown — the only way to audit the executor↔critic
   *  exchange after the E2B sandbox dies. Falls back to $CL_EXTRACT_DIR. */
  readonly extractDir?: string;
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
        ...(this.opts.residentDialogue === true && { residentDialogue: true }),
        ...(this.opts.greenCommand !== undefined && {
          greenCommand: this.opts.greenCommand,
          ...(this.opts.greenThreshold !== undefined && { greenThreshold: this.opts.greenThreshold }),
        }),
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

    // Diagnostic: pull transcripts OUT of the sandbox before the core tears it down.
    const extractDir = this.opts.extractDir ?? process.env.CL_EXTRACT_DIR;
    if (extractDir) {
      await extractSandboxTranscripts(ws, join(extractDir, sanitizeName(`${cell.task.id}__${agentId}`)), dir, {
        "trace.jsonl": traceOutputPath,
        "results.jsonl": resultsPath,
        "team.json": `${dir}/team.json`,
      }).catch((e: unknown) => console.error(`[critic-loop] transcript extraction failed: ${String(e)}`));
    }

    // Compact audit signal (docs/50 §10.4 step 1): how many executor↔critic rounds ran
    // and when the critic approved — parsed from the same lane trace, persisted per cell so
    // over/under-consulting is visible across a run without un-tarring each transcript.
    const summary = await readCriticLoopSummary(ws, traceOutputPath).catch(() => undefined);

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
          // Team-wide LLM-call count → context-per-call in the frontier (docs/53 TE-14).
          ...(teamUsage?.team.calls !== undefined && { teamCalls: teamUsage.team.calls }),
          exitCode: r.exitCode,
          ...(summary && {
            rounds: summary.rounds,
            ...(summary.approvedAtRound !== null && { approvedAtRound: summary.approvedAtRound }),
          }),
          ...(r.exitCode !== 0 && { stderrTail: r.stderr.slice(-2000) }),
        },
      },
    };
  }
}

const sanitizeName = (s: string): string => s.replace(/[^\w.-]/g, "_").slice(0, 120);

/** Minimal Workspace surface the extractor needs. */
interface ExtractWs {
  readFile(path: string): Promise<string | null>;
  run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string }>;
}

/**
 * Copy the sandbox's transcripts to a LOCAL dir before teardown (docs/50 §10.4).
 * `known` files are read directly; then every session/event `*.jsonl` the run wrote
 * (per-agent engine transcripts, event logs) is discovered and tar'd out as one blob —
 * the executor↔critic exchange is otherwise unrecoverable once E2B kills the sandbox.
 */
async function extractSandboxTranscripts(
  ws: ExtractWs,
  outDir: string,
  workDir: string,
  known: Record<string, string>,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  for (const [name, path] of Object.entries(known)) {
    const c = await ws.readFile(path).catch(() => null);
    if (c !== null) writeFileSync(join(outDir, name), c);
  }
  // Discover every transcript file the run wrote (workspace + the engine's ~/.openswarm),
  // list them for provenance, then tar+base64 them through stdout.
  const roots = [workDir, "$HOME/.openswarm", "/root/.openswarm", "/home/user/.openswarm", "/tmp/openswarm"].join(" ");
  const find = `find ${roots} -type f \\( -name '*.jsonl' -o -name '*.ndjson' -o -name 'events*.json' -o -name '*.session.json' \\) 2>/dev/null | sort -u`;
  const listing = await ws.run(`bash -lc ${shq(find)}`, { timeoutMs: 60_000 }).catch(() => null);
  if (listing?.stdout?.trim()) {
    writeFileSync(join(outDir, "FILES.txt"), listing.stdout);
    const tar = await ws
      .run(`bash -lc ${shq(`tar czf - $(${find}) 2>/dev/null | base64 -w0`)}`, { timeoutMs: 120_000 })
      .catch(() => null);
    const b64 = tar?.stdout?.trim();
    if (b64) writeFileSync(join(outDir, "sandbox-transcripts.tgz"), Buffer.from(b64, "base64"));
  }
}

/**
 * `{rounds, approvedAtRound}` from a critic-loop lane trace. `rounds` counts executor
 * turns; `approvedAtRound` is the iteration the critic emitted APPROVED (null ⇒ never —
 * hit the cap or the executor failed). Pure so it can be tested on an extracted trace.
 */
export function parseCriticLoopSummary(traceText: string): { rounds: number; approvedAtRound: number | null } {
  let rounds = 0;
  let approvedAtRound: number | null = null;
  for (const line of traceText.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let o: { type?: string; payload?: { role?: string; note?: string } };
    try {
      o = JSON.parse(s) as typeof o;
    } catch {
      continue;
    }
    if (o.type === "worker_spawned" && o.payload?.role === "executor") rounds++;
    else if (o.type === "team_note") {
      const m = /after iteration (\d+)/.exec(o.payload?.note ?? "");
      if (m) approvedAtRound = Number(m[1]);
    }
  }
  return { rounds, approvedAtRound };
}

/** Grep the critic-loop lifecycle lines out of the sandbox trace and summarise them (cheap:
 *  transfers only the worker_spawned/team_note lines, not the full message stream). */
export async function readCriticLoopSummary(
  ws: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string }> },
  traceOutputPath: string,
): Promise<{ rounds: number; approvedAtRound: number | null } | undefined> {
  const grep = `grep -aE '"type":"(worker_spawned|team_note)"' ${shq(traceOutputPath)} 2>/dev/null || true`;
  const r = await ws.run(`bash -lc ${shq(grep)}`, { timeoutMs: 30_000 }).catch(() => null);
  if (r?.stdout === undefined) return undefined;
  const sum = parseCriticLoopSummary(r.stdout);
  return sum.rounds > 0 ? sum : undefined;
}
