import * as path from "node:path";
import type { AgentId } from "../core/types.js";
import { ParentTransport } from "../swarm/ipc/parent-transport.js";
import { WorkerHost } from "../swarm/worker-host.js";
import { ClaudeAgentSdkEngine } from "../engine/claude-agent-sdk.js";
import { resolveTrust } from "../trust/gate.js";
import { getProcessBroker } from "../process/broker.js";
import { CodexFrameworkEngine } from "../engine/codex-framework.js";
import { NativeEngine } from "../engine/native.js";
import { HardenedNativeEngine } from "../engine/hardened-native.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
import { CodexResponsesTransportProvider } from "../providers/codex-responses/index.js";
import { OpenAICodexAuth } from "../auth/openai-codex-oauth.js";
import {
  DEFAULT_COMPACTION,
  autoCompactThreshold,
} from "../engine/compactor.js";
import { filterCodexPeerTools } from "../tools/codex-peer-tools.js";
import { loadAliases, resolveAlias } from "../providers/aliases.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import { planEngine } from "./select-engine.js";
import type { AuthSource } from "../auth/index.js";
import type { AgentEngine, PermissionDecision } from "../engine/index.js";
import type { RetryPolicy } from "../engine/retry-policy.js";
import type { FrameworkChoice } from "./argv.js";
import type { ResolvedProvider } from "../providers/index.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { setToolRegistry } from "../tools/tier1/tool_search.js";
import {
  enrichTurnInputs,
  observeTurnEvents,
  endMemorySession,
  type TurnRecord,
} from "../memory/index.js";
import { buildTier2Tools } from "../tools/tier2/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { makeCanUseTool, type AttemptRecorder } from "../permissions/gate.js";
import { openAuditJournal, type AuditJournal } from "../kernel/audit-journal.js";
import type { AttemptResolver } from "../engine/operation-ledger.js";
import type { LaneEvent } from "../swarm/events.js";
import { PermissionBridge } from "../permissions/bridge.js";
import type { BridgeDecision } from "../permissions/bridge.js";
import type { PendingPermission } from "../ui/repl/state.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import { createHash } from "node:crypto";
import {
  BUILTIN_ROLES,
  RoleRegistry,
  loadCustomRoles,
} from "../swarm/roles.js";
import { normalizedEventToLaneType } from "../swarm/events.js";
import { startSessionRecorder, type SessionRecorder } from "../swarm/session-recorder.js";
import type {
  AgentResult,
  TaskPacket,
  PermissionRequest,
  PermissionDecisionResponse,
} from "../swarm/host.js";
import type { IpcRequest } from "../swarm/ipc/protocol.js";
import { RunMoreParamsSchema, IPC_ERROR_CODES } from "../swarm/ipc/protocol.js";
import type { PermissionMode, Usage, NormalizedEvent } from "../core/types.js";
import { ToolInputAccumulator, parseToolInput } from "../core/tool-input.js";
import { isEditTool } from "../acp/tool-kind.js";
import { redactSecrets } from "../tools/tier0/secrets.js";
import type { ToolExecutionContext, ToolImpl } from "../tools/types.js";
import { bumpGeneration, withWriteLease } from "../kernel/write-lease.js";
import { readSessionSidecar, writeSessionSidecar } from "./session-sidecar.js";
import { buildSystemPrompt } from "../engine/default-system-prompt.js";
import { resolveSamplingConfig } from "../engine/sampling.js";
import {
  ensureScratchpadDir,
  formatScratchpadForSystemPrompt,
  resolveWorkerScratchpadDir,
  SCRATCHPAD_ENV_VAR,
} from "../engine/scratchpad.js";
import {
  loadProjectInstructions,
  formatInstructionsForSystemPrompt,
} from "../engine/project-instructions.js";
import {
  buildToolUseWarmupPrompt,
  formatUnknownToolFeedback,
} from "../tools/tool-feedback.js";

function parseIntEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return Number.parseInt(raw, 10);
}

/**
 * Issue #26 — carry a bounded, secret-redacted `input` on the recorded
 * `tool_use_end` for edit/write tools so `team watch` can reconstruct inline
 * diffs on live/replay runs. `tool_use_input` deltas are stripped as live-only
 * before events.jsonl (src/swarm/wire-protocol.ts), so the recorded
 * `tool_use_end` is the only place a replay consumer can recover the args.
 */

/** Per-field char cap for the reconstructable diff fields (a few KB each). */
const MAX_EDIT_INPUT_FIELD_CHARS = 16_000;

/** Fields we size-cap; other strings are redacted but left un-capped. */
const CAPPED_EDIT_FIELDS = new Set(["old_string", "new_string", "content"]);

/**
 * Produce a persisted-safe copy of an edit tool's parsed input:
 *  - run every string field through `redactSecrets` (recursively),
 *  - cap `old_string` / `new_string` / `content` to a sane char limit,
 *  - leave `apply_patch`'s `patch` field verbatim so it stays parseable by
 *    parsePatch (bounding the raw patch is a documented follow-up).
 */
/**
 * Decide the `input` to attach to a forwarded `tool_use_end`. Returns the
 * bounded + redacted args for edit/write tools, or `undefined` for every
 * other tool (so non-edit tool_use_end events forward unchanged). Exported so
 * the redaction/bounding contract can be unit-tested without a live worker.
 */
export function editInputForToolEnd(
  toolName: string | undefined,
  rawArgs: string,
): unknown | undefined {
  if (toolName === undefined || !isEditTool(toolName)) return undefined;
  return boundAndRedactEditInput(parseToolInput(rawArgs, "empty-object"));
}

function boundAndRedactEditInput(input: unknown): unknown {
  if (Array.isArray(input)) {
    return input.map((v) => boundAndRedactEditInput(v));
  }
  if (input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === "patch") {
      // Deferred (issue #26 follow-up): keep apply_patch `patch` verbatim.
      out[k] = v;
    } else if (typeof v === "string") {
      let s = redactSecrets(v).redacted;
      if (CAPPED_EDIT_FIELDS.has(k) && s.length > MAX_EDIT_INPUT_FIELD_CHARS) {
        s = s.slice(0, MAX_EDIT_INPUT_FIELD_CHARS) + "…";
      }
      out[k] = s;
    } else if (v !== null && typeof v === "object") {
      out[k] = boundAndRedactEditInput(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const DEFAULT_WORKER_MODEL = "claude-sonnet-4-6";

async function resolveWorkerModel(rawModel: string): Promise<string> {
  const aliases = await loadAliases();
  return resolveAlias(rawModel, aliases);
}

async function buildWorkerProviderAuth(
  resolved: ResolvedProvider,
  modelId: string,
): Promise<AuthSource> {
  if (resolved.authFactory !== undefined) {
    return await resolved.authFactory();
  }
  if (/^(gpt|o[134]|openai\/)/i.test(modelId)) {
    return new OpenAIEnvAuth();
  }
  throw new Error(`no auth source wired for worker model ${modelId}`);
}

async function buildNativeWorkerEngine({
  resolved,
  agentId,
  hardened,
}: {
  readonly resolved: ResolvedProvider;
  readonly agentId: AgentId;
  readonly hardened: boolean;
}): Promise<AgentEngine> {
  const providerModelId = resolved.modelId!;
  const providerAuth = await buildWorkerProviderAuth(resolved, providerModelId);
  const provider = await resolved.providerFactory!(providerAuth, providerModelId);
  // Size compaction to the provider's real context window. Omitting this silently falls
  // back to DEFAULT_COMPACTION's 10k floor (native.ts:
  // `opts.compactionConfig ?? DEFAULT_COMPACTION`), which exists for tiny-context models.
  // On a 200k-window model that makes every agent compact from ~10k tokens onward and
  // re-compact almost every turn, which trips the rapid-refill breaker
  // ("context refills too quickly after compaction") and kills the run. The
  // codex-native worker path below already sized this correctly; the native path did not.
  const compactionConfig = {
    preserveRecentMessages: DEFAULT_COMPACTION.preserveRecentMessages,
    maxEstimatedTokens: autoCompactThreshold(provider.capabilities.maxContextTokens),
  };
  if (!hardened) {
    return new NativeEngine({ provider, sessionId: agentId, compactionConfig });
  }
  const retryPolicy: RetryPolicy = {
    maxRetries: parseIntEnv("OPENSWARM_RETRY_MAX_RETRIES", 3),
    backoffBaseMs: parseIntEnv("OPENSWARM_RETRY_BACKOFF_BASE_MS", 100),
  };
  return new HardenedNativeEngine({
    provider,
    sessionId: agentId,
    retryPolicy,
    compactionConfig,
    audit: workerAttemptResolver(agentId),
    eagerToolDispatch: process.env.OPENSWARM_EAGER_TOOL_DISPATCH === "1",
    midTurnCompaction: process.env.OPENSWARM_MID_TURN_COMPACTION === "1",
  });
}

/**
 * codex-native worker engine — the in-process ChatGPT-subscription path
 * (docs/42), the worker-side mirror of runtime.ts's codex-native branch so a
 * team member can be spawned with `framework: "codex-native"`. Compaction is
 * sized to the provider's real context window to preserve the byte-stable
 * cached prefix (docs/42 §6.2).
 */
async function buildCodexNativeWorkerEngine({
  codexModelId,
  agentId,
}: {
  readonly codexModelId: string;
  readonly agentId: AgentId;
}): Promise<AgentEngine> {
  const provider = new CodexResponsesTransportProvider({
    modelId: codexModelId,
    credentials: new OpenAICodexAuth(),
    sessionId: agentId,
  });
  return new HardenedNativeEngine({
    provider,
    sessionId: agentId,
    audit: workerAttemptResolver(agentId),
    eagerToolDispatch: process.env.OPENSWARM_EAGER_TOOL_DISPATCH === "1",
    midTurnCompaction: process.env.OPENSWARM_MID_TURN_COMPACTION === "1",
    compactionConfig: {
      preserveRecentMessages: DEFAULT_COMPACTION.preserveRecentMessages,
      // Estimator-fallback threshold, CC-aligned (window − 13k reserve;
      // the primary trigger is the engine's usage-token check).
      maxEstimatedTokens: autoCompactThreshold(
        provider.capabilities.maxContextTokens,
      ),
    },
  });
}

/**
 * Combine the parent's base system prompt with the role's system-prompt
 * suffix. Role suffix APPENDS to base (role wins on conflicts because it
 * lands last — matches the plan §6.6 "last-writer-wins" guidance).
 *
 * Exported so unit tests can assert the join behavior without standing up
 * a full worker IPC process (M1 regression).
 */
export function composeSystemPrompt(
  basePrompt: string | undefined,
  roleSuffix: string | undefined,
  toolWarmup?: string,
): string {
  return [basePrompt ?? "", toolWarmup ?? "", roleSuffix ?? ""]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Per-turn execution context built once at worker startup and reused across
 * runs in long-lived mode. The engine, dispatcher, and auth are all
 * preserved across turns so we don't rebuild them between prompts.
 */
interface TurnContext {
  readonly agentId: AgentId;
  readonly host: WorkerHost;
  readonly transport: ParentTransport;
  readonly engine: AgentEngine;
  /** Resolved model id passed to the engine run config (e.g. a Bedrock inference-profile id).
   *  Drives the actual model call — distinct from the value used for engine selection. */
  readonly model: string;
  readonly auth: AnthropicEnvAuth;
  readonly dispatcher: ToolDispatcher;
  readonly permissionMode: PermissionMode;
  readonly permissionEngine: PermissionEngine;
  readonly roleSuffix: string;
  readonly resolvedAllowedTools: readonly string[] | undefined;
  readonly parentToolUseId: string | undefined;
  /**
   * Phase 3 B1 — per-worker memory turn log. executeTurn appends one
   * TurnRecord per turn (via the observer); runWorkerEntry archives them at
   * worker shutdown through endMemorySession.
   */
  readonly memoryTurns: TurnRecord[];
}

/**
 * The worker's audit journal, opened once per process.
 *
 * Workers share the workspace, so they share the journal root and separate by
 * session id. The agent id is that id, matching what the engines already use as
 * their session id, and it is what makes reconciliation's single-session scope
 * correct here: a worker owns its own stream and no other process writes it.
 */
let workerJournal: AuditJournal | undefined;
const journalForWorker = (): AuditJournal =>
  (workerJournal ??= openAuditJournal(process.cwd()));

/** The gate's half: record the authorized attempt before it runs. */
function workerAttempts(agentId: string): AttemptRecorder {
  const journal = journalForWorker();
  return {
    prepare: (payload) =>
      journal
        .append({
          sessionId: agentId,
          type: "AttemptPrepared",
          payload,
          causationId: payload.request.operationId,
        })
        .then(() => undefined),
  };
}

/**
 * The ledger's half. Wired wherever `workerAttempts` is, and not optionally:
 * a prepare with no resolve is the signature recovery reads as a crash, so
 * recording only the first half would have every worker tool call look like a
 * process that died. That was a live bug on the CLI's default dispatch path
 * (docs/67 `WP-00a`); this is the same trap one surface over.
 */
function workerAttemptResolver(agentId: string): AttemptResolver {
  const journal = journalForWorker();
  return {
    resolve: (outcome) =>
      journal
        .append({
          sessionId: agentId,
          type: "AttemptResolved",
          payload: { outcome },
          causationId: outcome.operationId,
        })
        .then(() => undefined),
  };
}

/**
 * Forwards a gate prompt to the orchestrator, or refuses when nobody is there.
 *
 * The gate prompts through a `PermissionBridge`, and a worker has no terminal to
 * prompt at, so this plays the same role for the swarm that `AcpPermissionBridge`
 * plays for ACP. Without an `escalate` callback there is no one to ask and the
 * answer is no, which is the behaviour a worker spawned outside the ACP team path
 * already had.
 */
class WorkerEscalationBridge extends PermissionBridge {
  constructor(
    private readonly escalate?: (req: PermissionRequest) => Promise<PermissionDecisionResponse>,
  ) {
    super();
  }

  override async request(pending: PendingPermission): Promise<BridgeDecision> {
    if (this.escalate === undefined) {
      return { allow: false, reason: pending.reason ?? "denied by permission mode" };
    }
    const res = await this.escalate({
      toolName: pending.toolName,
      input: pending.input,
      requiredPermission: pending.requiredPermission,
      currentMode: pending.currentMode,
    });
    // Approval is named; anything else is not one. Same rule as the ACP bridge,
    // for the same reason: treating an unrecognised outcome as consent approves
    // silently.
    return res.outcome === "allow"
      ? { allow: true }
      : { allow: false, reason: res.reason ?? "denied by operator" };
  }
}

/**
 * Build a worker's `canUseTool` gate.
 *
 * This delegates to `makeCanUseTool` — the same gate the CLI and ACP use —
 * rather than reimplementing authorization. It used to be its own
 * implementation: containment, then a check of the *tool's* declared permission,
 * then escalation. That was weaker than the CLI's in three ways at once, and
 * `worker-gate-parity.test.ts` records each as a differential fixture.
 *
 * It never ran the bash-validation pipeline, so a command the product classifies
 * as never-allowable was merely graded by mode. With an operator who approves —
 * or in danger-full-access, where nobody is asked at all — a worker would run
 * `cat /etc/passwd`, which the CLI refuses in every mode. Swarm orchestration is
 * this product's primary surface, so that was the real posture and the CLI's was
 * the one being read.
 *
 * It emitted no lane events. `bash_validation_blocked` and
 * `bash_validation_warned` are `LaneEvent` types that exist so the orchestrator
 * can see what its workers were stopped from doing, and `bash-gate.ts` is their
 * only emitter — so the events the swarm schema was extended to carry were never
 * produced by a swarm.
 *
 * And it graded tools rather than resources, which is why nothing here could
 * record an attempt: `makePathContainment` derives complete `OperationRequest`s
 * and returns only whether one escaped, so the requests an audit record is built
 * from were computed and dropped.
 *
 * Containment is still never escalated — the shared gate refuses an escaping path
 * before any prompt, because no mode grants it and asking would offer a choice
 * that does not exist. Exported for testing.
 */
export function buildWorkerCanUseTool(deps: {
  dispatcher: ToolDispatcher;
  permissionEngine: PermissionEngine;
  permissionMode: PermissionMode;
  cwd: string;
  escalate?: (req: PermissionRequest) => Promise<PermissionDecisionResponse>;
  /** The worker's lane, so the orchestrator sees validation events. */
  emitLaneEvent?: (event: unknown) => void;
  /** Where an authorized attempt is recorded before it runs (docs/67 `WP-00a`). */
  attempts?: AttemptRecorder;
}): (toolName: string, input: unknown) => Promise<PermissionDecision> {
  const gate = makeCanUseTool({
    dispatcher: deps.dispatcher,
    permEngine: deps.permissionEngine,
    bridge: new WorkerEscalationBridge(deps.escalate),
    // A worker's prompts go to the orchestrator, never to stdin: its stdin is
    // the IPC transport.
    useHeadless: false,
    // Fixed for the worker's lifetime: a worker is spawned with its mode and has
    // no `/permissions` to change it mid-session.
    getCurrentMode: () => deps.permissionMode,
    cwd: deps.cwd,
    ...(deps.emitLaneEvent !== undefined ? { emitLaneEvent: deps.emitLaneEvent } : {}),
    ...(deps.attempts !== undefined ? { attempts: deps.attempts } : {}),
  });

  return async (toolName, input) => {
    // Kept ahead of the shared gate for its feedback rather than its verdict:
    // both refuse an unknown tool, but this names the ones that exist, which is
    // what lets a worker recover instead of retrying the same wrong name.
    if (deps.dispatcher.get(toolName) === undefined) {
      return {
        allow: false,
        reason: formatUnknownToolFeedback(toolName, deps.dispatcher.list()),
      };
    }
    return gate(toolName, input);
  };
}

/**
 * Run one turn against the engine and emit the resulting AgentResult.
 * Reused for the initial run AND each subsequent `run_more` in long-lived
 * mode. Lifecycle transitions are handled by the caller.
 */
/**
 * Long enough that an ordinary tool call never has to renew, short enough that a
 * worker killed mid-write does not park the queue. `withWriteLease` renews for
 * anything slower.
 */
const LEASE_TTL_MS = 15_000;

/**
 * Whether a call needs the write lease.
 *
 * Read-only calls must not take it: the lease is single-writer precisely so that
 * readers stay concurrent, and putting reads behind it would serialize the
 * common case for nothing. A tool that cannot describe its accesses is treated
 * as writing, matching what the access model already does with malformed
 * accesses — a needless lease costs throughput, a missing one costs the
 * guarantee.
 */
function mutates(
  tool: ToolImpl,
  input: unknown,
  ctx: ToolExecutionContext,
): boolean {
  let accesses;
  try {
    accesses = tool.accesses(input, ctx);
  } catch {
    return true;
  }
  return accesses.some(
    (a) =>
      a.kind === "all" ||
      (a.kind === "file" && (a.operation === "write" || a.operation === "readwrite")),
  );
}

async function executeTurn(
  ctx: TurnContext,
  task: TaskPacket,
): Promise<AgentResult> {
  const { agentId, transport, engine, auth, dispatcher, permissionMode,
    permissionEngine, roleSuffix, resolvedAllowedTools, parentToolUseId, model } = ctx;

  const startedAt = Date.now();
  let finalText = "";
  let errMsg: string | undefined;
  let usage: Usage | undefined;
  let recorder: SessionRecorder | null = null;

  try {
    // Build the tool list the engine sees. When an allowlist is in effect,
    // only tools that survived dispatcher filtering are advertised —
    // dispatcher.list() is the source of truth.
    const allImpls: readonly ToolImpl[] = [
      ...buildTier0Tools(),
      ...buildTier2Tools(),
    ];
    const filtered = allImpls.filter((t) => dispatcher.get(t.spec.name) !== undefined);
    const allTools = filtered.map((t) => ({
      ...t,
      execute: async (input: unknown, ec: ToolExecutionContext) => {
        // Inject SwarmHost into the execution context for Tier 2 tools.
        const withHost: ToolExecutionContext = { ...ec, host: ctx.host };
        if (!mutates(t, input, withHost)) {
          return t.execute(input, withHost);
        }
        // Exactly one writer per working directory (docs/67 §A5, `WP-11`).
        // Keyed on the worker's own cwd, so a member that was given a worktree
        // gets an uncontended lease of its own and only members that genuinely
        // share a directory serialize against each other.
        return withWriteLease(
          ec.cwd,
          { agentId, ttlMs: LEASE_TTL_MS, signal: ec.abort },
          async (lease) => {
            const result = await t.execute(input, withHost);
            // The generation advances on a committed mutation, and is what a
            // reader's `ReadSet` is judged against. Failing to advance it would
            // make stale work look current, so a bump that throws must not be
            // swallowed into a successful tool result.
            if (result.status === "ok") {
              await bumpGeneration(ec.cwd, lease);
            }
            return result;
          },
        );
      },
    }));

    const envBasePrompt = process.env.OPENSWARM_BASE_SYSTEM_PROMPT;
    const useNativePrompt =
      engine.id === "native" || engine.id === "hardened-native";
    // Fold CLAUDE.md/AGENTS.md into the worker's system prompt (F1 startup
    // parity — native/hardened engines don't get them from an SDK preset).
    const instructionsExt = formatInstructionsForSystemPrompt(
      loadProjectInstructions(process.cwd()),
    );
    // Session scratchpad: inherit the orchestrator's root (env, spread by the
    // subprocess spawner) and carve a per-agent subdir to avoid write
    // collisions between workers; standalone workers allocate a fresh one.
    // The bash-validation exemption keys off OPENSWARM_SCRATCHPAD_DIR, which
    // prefix-covers the per-agent subdir. Failure is non-fatal.
    let scratchpadExt = "";
    try {
      const scratchpadDir = ensureScratchpadDir(
        resolveWorkerScratchpadDir(process.cwd(), agentId),
      );
      const envRoot = process.env[SCRATCHPAD_ENV_VAR];
      if (envRoot === undefined || envRoot.length === 0) {
        process.env[SCRATCHPAD_ENV_VAR] = scratchpadDir;
      }
      scratchpadExt = formatScratchpadForSystemPrompt(scratchpadDir);
    } catch {
      scratchpadExt = "";
    }
    const nativeExtensions = [envBasePrompt, instructionsExt, scratchpadExt]
      .filter((s): s is string => s !== undefined && s.length > 0)
      .join("\n\n");
    const basePrompt = useNativePrompt
      ? buildSystemPrompt({
          cwd: process.cwd(),
          ...(nativeExtensions.length > 0
            ? { extensions: nativeExtensions }
            : {}),
        })
      : (envBasePrompt ?? "");
    const toolWarmup =
      process.env.OPENSWARM_TOOL_USE_WARMUP === "1"
        ? buildToolUseWarmupPrompt(allTools.map((t) => t.spec))
        : undefined;
    const systemPrompt = composeSystemPrompt(basePrompt, roleSuffix, toolWarmup);

    // Long-lived workers resume the prior turn's session so conversation
    // context carries across run_more (the engine tracks its latest session id).
    // undefined on the first turn -> a fresh conversation.
    // B1.4: on the first turn (no in-memory id) fall back to the session sidecar
    // so a freshly-spawned root resumes the prior conversation across processes
    // (ACP session/load live resume).
    const sidecarPath = process.env.OPENSWARM_SESSION_SIDECAR;
    let priorSessionId = engine.getSessionId?.();
    if (priorSessionId === undefined && sidecarPath !== undefined) {
      priorSessionId = readSessionSidecar(sidecarPath);
    }

    // Surface memory (minimem + skills) into this turn via the shared seam.
    const enriched = await enrichTurnInputs(systemPrompt, task.prompt, {
      query: task.prompt,
      agentId,
      ...(priorSessionId !== undefined && { sessionId: priorSessionId }),
    });

    const runConfig = {
      systemPrompt: enriched.systemPrompt,
      prompt: enriched.prompt,
      model,
      auth,
      tools: allTools,
      dispatcher,
      // Native engines dispatch tools through the dispatcher directly, bypassing
      // the host-injecting tool wrappers above. Thread the host so Tier 2 TEAM
      // tools (agent/send_message/check_inbox/task_list) receive ctx.host.
      host: ctx.host,
      permissionMode,
      ...(priorSessionId !== undefined && {
        resumeFrom: {
          engineId: engine.id,
          data: { sessionId: priorSessionId },
        },
      }),
      canUseTool: buildWorkerCanUseTool({
        dispatcher,
        permissionEngine,
        permissionMode,
        cwd: process.cwd(),
        // Validation events go to the worker's lane, which is what the
        // `bash_validation_*` LaneEvent types were added for. The host restamps
        // agentId, so the orchestrator learns which worker was stopped rather
        // than that some gate somewhere stopped something.
        emitLaneEvent: (event: unknown) =>
          ctx.host.emit(event as Omit<LaneEvent, "ts" | "agentId">),
        // Keyed by agent id: workers share the workspace, so they share the
        // journal root and each needs its own stream — which is also what makes
        // reconciliation's single-session scope correct for a worker.
        attempts: workerAttempts(agentId),
        // Escalate denied calls to the orchestrator only when the ACP team path
        // enabled it (env flag set on the spawned worker); else deny directly.
        ...(process.env.OPENSWARM_PERMISSION_ESCALATION === "1"
          ? { escalate: (req: PermissionRequest) => ctx.host.requestPermission(req) }
          : {}),
      }),
      ...(resolvedAllowedTools !== undefined && {
        allowedTools: resolvedAllowedTools,
      }),
      // Sampling + tool-choice levers (docs/63 F2/F3). Env-only here: the
      // subprocess spawner spreads process.env, so whatever the orchestrator
      // resolved reaches every worker without a new IPC field.
      ...resolveSamplingConfig(),
    };

    // Layer 0: record this worker's session transcript (opt-in, best-effort) so
    // sessionlog's openswarm adapter + cognitive-core can distill it.
    recorder = await startSessionRecorder({
      sessionId: priorSessionId ?? agentId,
      agentId,
      prompt: task.prompt,
      surfacedSkills: enriched.surfacedSkills,
    });

    // Compaction continuation messages point the model at the live transcript
    // ("read the full transcript at: …", docs/48-compaction-design.md §L4).
    if (recorder !== null) {
      (
        engine as { setTranscriptPath?: (p: string) => void }
      ).setTranscriptPath?.(recorder.transcriptPath);
    }

    // Crash-recovery T2: persist the engine session id to the sidecar as soon
    // as it's known (not just at turn end), so a daemon crash MID-turn still
    // leaves a resumable session id for the re-dispatched worker.
    let sidecarPersisted = false;
    const persistSidecarEarly = (): void => {
      if (sidecarPersisted || sidecarPath === undefined) return;
      const sid = engine.getSessionId?.();
      if (sid !== undefined) {
        writeSessionSidecar(sidecarPath, sid);
        sidecarPersisted = true;
      }
    };

    // Phase 3 B1 — the observer fires onAfterTurn / onCompaction as the
    // events stream through, and appends this turn's TurnRecord.
    const observedEvents = observeTurnEvents(engine.run(runConfig), {
      sessionId: priorSessionId ?? agentId,
      turnIndex: ctx.memoryTurns.length,
      agentId,
      onRecord: (record) => ctx.memoryTurns.push(record),
    });
    // Issue #26: reassemble edit-tool args from the streamed tool_use_input
    // deltas so we can attach a bounded, redacted `input` on the recorded
    // tool_use_end. Scoped per turn; tracks toolUseId → toolName.
    const editInputAcc = new ToolInputAccumulator<string>();
    for await (const evt of observedEvents) {
      if (evt.type === "text_delta") {
        finalText += evt.text;
      } else if (evt.type === "error") {
        errMsg = evt.error.message;
      } else if (evt.type === "message_stop") {
        usage = evt.usage;
      }
      persistSidecarEarly();
      // Issue #26: accumulate streamed edit args, then on tool_use_end attach a
      // bounded + redacted `input` for edit tools only. Non-edit tools forward
      // unchanged (no `input`). tool_use_input itself stays live-only.
      if (evt.type === "tool_use_start") {
        editInputAcc.start(evt.id, evt.name);
      } else if (evt.type === "tool_use_input") {
        editInputAcc.append(evt.id, evt.jsonDelta);
      }
      let payload: NormalizedEvent = evt;
      if (evt.type === "tool_use_end") {
        const buffered = editInputAcc.end(evt.id);
        const input = editInputForToolEnd(buffered?.meta, buffered?.raw ?? "");
        if (input !== undefined) {
          payload = { ...evt, input };
        }
      }
      // Forward each engine event as a lane_event, preserving its real type so
      // events.jsonl records the semantic spine and the ACP layer can translate
      // member activity. Events with no lane equivalent are
      // dropped (they were never usefully consumed).
      const laneType = normalizedEventToLaneType(evt.type);
      if (laneType !== undefined) {
        const laneEvent = {
          ts: Date.now(),
          agentId,
          type: laneType,
          payload,
          ...(parentToolUseId !== undefined && { parentToolUseId }),
        };
        recorder?.record(laneEvent);
        await transport.notify("lane_event", laneEvent);
      }
    }
    // B1.4: persist this turn's engine session id so a fresh process can resume
    // the conversation from the sidecar on its first turn.
    if (sidecarPath !== undefined) {
      const sid = engine.getSessionId?.();
      if (sid !== undefined) writeSessionSidecar(sidecarPath, sid);
    }
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  } finally {
    if (recorder !== null) {
      await recorder.close();
      // Layer 1: signal the host→MAP bridge to report this session's trajectory
      // (sessionId links to the recorded sessionlog session). Best-effort.
      try {
        await transport.notify("lane_event", {
          ts: Date.now(),
          agentId,
          type: "trajectory_checkpoint",
          payload: {
            sessionId: recorder.sessionId,
            label: task.prompt.slice(0, 200),
            transcriptPath: recorder.transcriptPath,
          },
        });
      } catch {
        // trajectory reporting must never fail the turn
      }
    }
  }

  // docs/52 — usage source of truth. The `usage` scraped above is only the LAST
  // `message_stop` event's payload; on a multi-turn agentic run that undercounts,
  // and when the final stop carries no tokens it reads 0 — which is how long
  // executor runs reported $0 despite doing real work (the message_stop loss was
  // in the engine→worker capture, not the lane bus). The engine keeps an
  // authoritative cumulative tally across every turn of the run; prefer it
  // whenever it has data, never downgrading a good scrape to 0.
  try {
    const engineUsage = engine.getCumulativeUsage();
    const engineTotal =
      engineUsage.inputTokens +
      engineUsage.outputTokens +
      (engineUsage.cacheReadInputTokens ?? 0) +
      (engineUsage.cacheWriteInputTokens ?? 0);
    if (engineTotal > 0) usage = engineUsage;
  } catch {
    /* engine can't report cumulative usage → keep the scraped value */
  }

  const wallClockMs = Date.now() - startedAt;
  const result: AgentResult = errMsg
    ? { status: "failure", error: errMsg, wallClockMs, ...(usage && { usage }) }
    : {
        status: "success",
        output: finalText,
        usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        wallClockMs,
      };
  return result;
}

export async function runWorkerEntry(): Promise<number> {
  const agentId = (process.env.OPENSWARM_AGENT_ID ?? "unknown") as AgentId;
  const depthStr = process.env.OPENSWARM_DEPTH ?? "0";
  const depth = Number.parseInt(depthStr, 10);
  const parentToolUseId = process.env.OPENSWARM_PARENT_TOOL_USE_ID;

  const heartbeatIntervalMs = process.env.OPENSWARM_HEARTBEAT_MS
    ? Number.parseInt(process.env.OPENSWARM_HEARTBEAT_MS, 10)
    : undefined;
  const transport = new ParentTransport({ agentId, heartbeatIntervalMs });
  const permissionMode = (process.env.OPENSWARM_PERMISSION_MODE ??
    "workspace-write") as PermissionMode;
  // Inherited from the root, which resolved it from --sandbox or the
  // environment. A worker confines its children the same way the root does,
  // or the policy only holds for whichever agent the user happened to type at.
  const sandbox = process.env.OPENSWARM_SANDBOX;
  if (sandbox === "require" || sandbox === "prefer" || sandbox === "off") {
    getProcessBroker().setPolicy(sandbox);
  }
  // v0.4 stage 4M.7: WorkerHost reads team scope from env so its scopeOf()
  // can resolve the worker's own scope when the agent tool spawns a peer
  // via team: "self". Falls back to "swarm:default" when unset.
  const teamScope = process.env.OPENSWARM_TEAM_SCOPE;
  const host = new WorkerHost(
    agentId,
    depth,
    permissionMode,
    transport,
    parentToolUseId,
    undefined,
    teamScope,
  );

  // v0.4 stage 4D: opt-in long-lived worker mode.
  const longLived = process.env.OPENSWARM_LONG_LIVED === "1";
  const idleTimeoutRaw = process.env.OPENSWARM_IDLE_TIMEOUT_MS;
  const idleTimeoutMs =
    idleTimeoutRaw !== undefined && /^\d+$/.test(idleTimeoutRaw)
      ? Number.parseInt(idleTimeoutRaw, 10)
      : 600_000;

  // Announce readiness.
  await transport.notify("worker_ready", {
    agentId,
    depth,
    pid: process.pid,
  });
  host.markReadyForPrompt();
  transport.startHeartbeat();

  // Await the run request.
  const runReq = await new Promise<IpcRequest>((resolve) => {
    transport.once("run", resolve);
  });
  const initialTask = runReq.params as TaskPacket;

  // Ack the run immediately.
  transport.respond(runReq.id, { accepted: true });
  host.markRunning(initialTask.id);

  // M3a Phase 6: role overlay + allowedTools filter.
  // `OPENSWARM_ROLE` names a role; we look it up in a worker-local
  // RoleRegistry (built-ins + custom roles loaded fresh from cwd).
  // `OPENSWARM_ALLOWED_TOOLS` carries an explicit JSON array that wins
  // over the role-derived list when both are present. The system prompt
  // suffix is appended to RunConfig.systemPrompt (role suffix wins on
  // conflicts per the plan).
  const roleName = process.env.OPENSWARM_ROLE;
  let roleSuffix = "";
  let resolvedAllowedTools: readonly string[] | undefined;
  if (roleName !== undefined && roleName.length > 0) {
    const roleReg = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roleReg.register(r);
    try {
      const custom = await loadCustomRoles(
        path.join(process.cwd(), ".openswarm", "roles.json"),
      );
      for (const r of custom) roleReg.register(r);
    } catch {
      // loader is fault-tolerant — any surprise error is swallowed to
      // keep the worker alive.
    }
    const role = roleReg.get(roleName);
    if (role !== undefined) {
      roleSuffix = role.systemPromptSuffix;
      resolvedAllowedTools = role.allowedTools;
      // Success was silent, which made the roles carrier unmeasurable: an eval could not tell a
      // role that shaped the prompt from one that was never read. The digest ties the marker to the
      // suffix ACTUALLY applied, so a stale or different role cannot satisfy a probe looking for a
      // specific one. Emitted here rather than at load because this is where the suffix binds to
      // this worker's prompt — loading roles.json proves delivery, not application.
      process.stderr.write(
        `[openswarm] worker: role "${roleName}" applied ` +
          `(suffix ${roleSuffix.length} chars, sha256 ${createHash("sha256")
            .update(roleSuffix)
            .digest("hex")
            .slice(0, 12)})\n`,
      );
    } else {
      process.stderr.write(
        `[openswarm] worker: unknown role "${roleName}" — proceeding without role overlay\n`,
      );
    }
  }
  const envAllowed = process.env.OPENSWARM_ALLOWED_TOOLS;
  if (envAllowed !== undefined && envAllowed.length > 0) {
    try {
      const parsed = JSON.parse(envAllowed);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        resolvedAllowedTools = parsed as readonly string[];
      }
    } catch {
      // keep role-derived list if env is malformed
    }
  }

  // Build tools + permission engine. When a role allowlist is in effect,
  // the dispatcher filters tools at registration — the model never sees
  // tools outside the list.
  const dispatcher = new ToolDispatcher(
    resolvedAllowedTools !== undefined
      ? { allowedTools: resolvedAllowedTools }
      : {},
  );
  for (const tool of [...buildTier0Tools(), ...buildTier2Tools()]) {
    dispatcher.register(tool);
  }
  // Populate the tool_search registry with this worker's surface (tier0 +
  // tier2, post-allowlist) so discovery matches what's executable here.
  setToolRegistry(dispatcher.list());

  const permissionEngine = new PermissionEngine(permissionMode);
  const auth = new AnthropicEnvAuth();

  // Engine selection: read OPENSWARM_MODEL and OPENSWARM_FRAMEWORK.
  // Defaults preserve the historical Claude worker path, while per-task or
  // per-member models can route through native OpenAI-compatible transports.
  // TAC/Bedrock containers also provide ANTHROPIC_MODEL; use it as a final
  // provider-specific fallback before the built-in alias.
  const frameworkEnv = (process.env.OPENSWARM_FRAMEWORK ?? "auto") as FrameworkChoice;
  const requestedModel = await resolveWorkerModel(
    process.env.OPENSWARM_MODEL ?? initialTask.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_WORKER_MODEL,
  );

  // Shared CLI↔worker engine selection (Phase 2.1). Same model+framework+env
  // inputs produce the same engine here as in runtime.ts: workers now build a
  // codex-native engine and hard-error on an explicit native/hardened-native
  // framework paired with a Claude model instead of silently downgrading to
  // the Agent SDK.
  const planResult = planEngine({
    framework: frameworkEnv,
    resolvedModelId: requestedModel,
    scripted: !!process.env.OPENSWARM_TEST_SCRIPT,
  });
  if (!planResult.ok) {
    throw new Error(planResult.message);
  }
  const workerModel = planResult.effectiveModelId;
  const plan = planResult.plan;

  let engine: AgentEngine;
  switch (plan.kind) {
    case "scripted":
      engine = new ScriptedTestEngine();
      break;
    case "claude-sdk":
      // Inherited from the parent, which resolved trust for this workspace
      // before spawning us. Absent that inheritance this is false, so a worker
      // reached by some other route does not read project settings.
      engine = new ClaudeAgentSdkEngine({
        allowWorkspaceConfig: (await resolveTrust({ cwd: process.cwd() }))
          .allowWorkspaceConfig,
      });
      break;
    case "codex-chatgpt": {
      // V0.4.Q11: register the 8-tool peer subset with the codex agent as
      // host dynamicTools. Routed back through this worker's SwarmHost so
      // calls into send_message / team_members / etc. observe the same
      // team scope as a claude-agent-sdk worker would.
      const tier2 = buildTier2Tools();
      const codexPeerTools = filterCodexPeerTools(tier2);
      engine = new CodexFrameworkEngine({
        tools: codexPeerTools,
        host,
        permissionMode,
      });
      break;
    }
    case "codex-native":
      engine = await buildCodexNativeWorkerEngine({
        codexModelId: plan.codexModelId,
        agentId,
      });
      break;
    case "native":
      engine = await buildNativeWorkerEngine({
        resolved: plan.resolved,
        agentId,
        hardened: plan.hardened,
      });
      break;
    default: {
      const _exhaustive: never = plan;
      throw new Error(`unreachable engine plan: ${String(_exhaustive)}`);
    }
  }

  const ctx: TurnContext = {
    agentId,
    host,
    transport,
    engine,
    model: workerModel,
    auth,
    dispatcher,
    permissionMode,
    permissionEngine,
    roleSuffix,
    resolvedAllowedTools,
    parentToolUseId,
    memoryTurns: [],
  };

  // Phase 3 B1/B2 — archive this worker's turns at shutdown (best-effort,
  // hard 5s timeout inside endMemorySession; never blocks worker exit).
  const finishMemorySession = async (): Promise<void> => {
    await endMemorySession({
      sessionId: engine.getSessionId?.() ?? agentId,
      turns: ctx.memoryTurns,
    });
  };

  // Run the initial task.
  const initialResult = await executeTurn(ctx, initialTask);
  if (!longLived) {
    // Default (non-long-lived): mark terminal; the FSM stays in finished/
    // failed and the worker exits below.
    if (initialResult.status === "success") {
      host.markFinished();
    } else {
      host.markFailed(
        "panic",
        initialResult.status === "failure" ? initialResult.error : "non-success",
      );
    }
    await transport.notify("task_result", initialResult);
    // Default behaviour (preserved): exit immediately after the initial task.
    await finishMemorySession();
    transport.stopHeartbeat();
    transport.close();
    return initialResult.status === "success" ? 0 : 1;
  }

  // -------------------------------------------------------------------------
  // v0.4 stages 4D + 4M.3: long-lived loop with proper FSM transitions and
  // persistent request listener (no race window between worker_idle notify
  // and listener re-attach).
  // -------------------------------------------------------------------------

  // M5: long-lived workers transition `running → idle` after each turn,
  // NOT `running → finished`. The FSM allows `idle → prompt_accepted →
  // running` for re-entry on run_more. Pure-failure turns still keep the
  // worker available for retry — the orchestrator decides whether to drain
  // or retry; failure status surfaces via task_result + per-turn stderr.
  if (initialResult.status === "success") {
    host.markIdle();
  } else {
    // Per-turn failure in long-lived mode: still go idle (the orchestrator
    // can decide retry vs drain). The state-file failureClass/reason fields
    // would lie if we marked failed here; instead the failure is encoded
    // in the task_result payload.
    host.markIdle();
    process.stderr.write(
      `[openswarm] long-lived worker initial turn failed (agentId=${agentId}): ${
        initialResult.status === "failure" ? initialResult.error : initialResult.status
      }\n`,
    );
  }
  await transport.notify("task_result", initialResult);

  // M6: install the request listener ONCE at top-level. Frames arrive
  // synchronously from ParentTransport.handleFrame; without a persistent
  // listener, frames between iterations would be dropped on the floor.
  // Buffer pending frames; each loop iteration drains the buffer first.
  const pendingFrames: IpcRequest[] = [];
  type Wakeup = { kind: "frame"; frame: IpcRequest } | { kind: "close" };
  let pendingResolve: ((wakeup: Wakeup) => void) | undefined;
  const onRequest = (frame: IpcRequest): void => {
    if (frame.method !== "run_more" && frame.method !== "drain") return;
    if (pendingResolve !== undefined) {
      const resolver = pendingResolve;
      pendingResolve = undefined;
      resolver({ kind: "frame", frame });
    } else {
      pendingFrames.push(frame);
    }
  };
  let closeFired = false;
  const onClose = (): void => {
    closeFired = true;
    if (pendingResolve !== undefined) {
      const resolver = pendingResolve;
      pendingResolve = undefined;
      resolver({ kind: "close" });
    }
  };
  transport.on("request", onRequest);
  transport.once("close", onClose);

  let exitCode = 0;
  while (true) {
    // Notify orchestrator we're idle.
    const idleAt = Date.now();
    await transport.notify("worker_idle", {
      agentId,
      readyForRunMoreAt: idleAt,
    });

    // If the close listener already fired, exit cleanly.
    if (closeFired) {
      exitCode = 0;
      break;
    }

    // Wait for either a buffered frame, the next request, the idle timeout,
    // or close. The persistent listener guarantees no race window.
    const next = await new Promise<
      { kind: "run_more"; frame: IpcRequest }
      | { kind: "drain"; frame: IpcRequest }
      | { kind: "timeout" }
      | { kind: "close" }
    >((resolve) => {
      // Drain any buffered frame first (non-blocking).
      if (pendingFrames.length > 0) {
        const frame = pendingFrames.shift()!;
        if (frame.method === "run_more") {
          resolve({ kind: "run_more", frame });
        } else if (frame.method === "drain") {
          resolve({ kind: "drain", frame });
        }
        return;
      }
      // Otherwise await the next frame OR the idle timeout OR close.
      const timer = setTimeout(() => {
        cleanup();
        resolve({ kind: "timeout" });
      }, idleTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      const cleanup = (): void => {
        clearTimeout(timer);
        pendingResolve = undefined;
      };
      pendingResolve = (wakeup: Wakeup): void => {
        cleanup();
        if (wakeup.kind === "close") {
          resolve({ kind: "close" });
        } else if (wakeup.frame.method === "run_more") {
          resolve({ kind: "run_more", frame: wakeup.frame });
        } else if (wakeup.frame.method === "drain") {
          resolve({ kind: "drain", frame: wakeup.frame });
        }
      };
    });

    if (next.kind === "close") {
      // Parent transport closed without a clean drain — exit.
      exitCode = 0;
      break;
    }

    if (next.kind === "drain" || next.kind === "timeout") {
      // Idle drain (parent requested OR auto-timeout) — graceful exit.
      // M5: transition idle → drained for a proper FSM record.
      if (next.kind === "drain") {
        transport.respond(next.frame.id, { acknowledged: true });
      }
      try {
        host.markDrained();
      } catch {
        // If we're not currently in idle (shouldn't happen given the loop
        // structure), swallow — the FSM is best-effort for long-lived
        // workers anyway.
      }
      await transport.notify("worker_drained", { agentId });
      break;
    }

    // run_more: validate params, ack, execute the next turn.
    const params = RunMoreParamsSchema.safeParse(next.frame.params);
    if (!params.success) {
      transport.respondError(
        next.frame.id,
        IPC_ERROR_CODES.INVALID_PARAMS,
        params.error.message,
      );
      // M5: re-emit worker_idle so the orchestrator knows we're still
      // available after rejecting a malformed run_more (otherwise it
      // could wait indefinitely for the next worker_idle notification
      // because we already sent one before the request arrived).
      await transport.notify("worker_idle", {
        agentId,
        readyForRunMoreAt: Date.now(),
      });
      continue;
    }
    transport.respond(next.frame.id, { accepted: true });

    // M5: transition idle → prompt_accepted → running for the new turn.
    host.markRunning(params.data.taskId);

    const turnTask: TaskPacket = {
      id: params.data.taskId ?? `${initialTask.id}-${Date.now()}`,
      prompt: params.data.prompt,
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    };
    const result = await executeTurn(ctx, turnTask);

    // M5: after each long-lived turn, transition running → idle (NOT
    // finished/failed). Failures stay in the FSM as `idle` — the failure
    // is encoded in the task_result payload; the orchestrator decides
    // whether to retry via run_more or drain.
    host.markIdle();
    await transport.notify("task_result", result);
    if (result.status !== "success") {
      process.stderr.write(
        `[openswarm] long-lived worker turn failed (agentId=${agentId}): ${
          result.status === "failure" ? result.error : result.status
        }\n`,
      );
    }
    // Loop back to top; will re-emit worker_idle and await next request.
  }

  // Clean up the persistent listener.
  transport.off("request", onRequest);
  transport.off("close", onClose);

  await finishMemorySession();
  transport.stopHeartbeat();
  transport.close();
  return exitCode;
}
