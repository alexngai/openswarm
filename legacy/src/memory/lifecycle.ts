/**
 * Memory lifecycle integration — connects the MemoryCoordinator to the engine's
 * turn loop via clean lifecycle hooks.
 *
 * These functions are called at specific points in the engine lifecycle:
 * - onSessionStart: initialize coordinator with default providers
 * - onBeforeTurn: enrich the system prompt with memory context
 * - onAfterTurn: notify providers that a turn completed
 * - onCompaction: notify providers of context compression
 * - onSessionEnd: archive session and shut down providers
 */

import * as crypto from "node:crypto";
import type { AgentId } from "../core/types.js";
import type {
  MemoryFragment,
  SurfacedSkill,
  TurnContext,
  CompressionSummary,
} from "./types.js";
import { getMemoryCoordinator } from "./coordinator.js";
import { FileMemoryProvider } from "./providers/file-provider.js";
import { MinimemProvider } from "./providers/minimem-provider.js";
import { SkillProvider } from "./providers/skill-provider.js";
import { CogcorePlaybookProvider } from "./providers/cogcore-playbook-provider.js";
import { archiveSession } from "./archive.js";
import { maybeAutoConsolidate } from "./auto-consolidate.js";

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface SessionStartOptions {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly projectRoot?: string;
  readonly userId?: string;
}

export async function onSessionStart(opts?: SessionStartOptions): Promise<void> {
  const coordinator = getMemoryCoordinator();

  // Register the built-in FileMemoryProvider if not already present
  if (!coordinator.providerNames.includes("file")) {
    await coordinator.register(new FileMemoryProvider());
  }

  // Register MinimemProvider if not already present and not disabled
  if (
    !coordinator.providerNames.includes("minimem") &&
    process.env.OPENSWARM_MEMORY_PROVIDERS !== "file"
  ) {
    const minimemProvider = new MinimemProvider();
    try {
      await coordinator.register(minimemProvider);
      if (!(await minimemProvider.isAvailable())) {
        await coordinator.unregister("minimem");
      }
    } catch {
      // minimem not available — no-op, file provider handles basics
    }
  }

  // Register the read-only SkillProvider (skill-tree filesystem skills) if not
  // present and not disabled. Only activates when its skills directory exists.
  if (
    !coordinator.providerNames.includes("skills") &&
    process.env.OPENSWARM_MEMORY_PROVIDERS !== "file"
  ) {
    const skillProvider = new SkillProvider();
    try {
      await coordinator.register(skillProvider);
      if (!(await skillProvider.isAvailable())) {
        await coordinator.unregister("skills");
      }
    } catch {
      // skills unavailable — no-op
    }
  }

  // Register the read-only CogcorePlaybookProvider (cognitive-core's canonical
  // `<storage>/playbooks/<slug>/SKILL.md` store) if not present and not
  // disabled. Closes the local learning loop: sessions recorded here are
  // distilled by `cogcore run` (auto-consolidate) into playbooks this provider
  // surfaces on later turns. Only activates when a playbooks store exists.
  if (
    !coordinator.providerNames.includes("cogcore-playbooks") &&
    process.env.OPENSWARM_MEMORY_PROVIDERS !== "file"
  ) {
    const cogcoreProvider = new CogcorePlaybookProvider();
    try {
      await coordinator.register(cogcoreProvider);
      if (!(await cogcoreProvider.isAvailable())) {
        await coordinator.unregister("cogcore-playbooks");
      }
    } catch {
      // cogcore playbooks unavailable — no-op
    }
  }
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export async function onBeforeTurn(
  context: TurnContext,
): Promise<MemoryFragment[]> {
  const coordinator = getMemoryCoordinator();
  return coordinator.enrichTurn(context);
}

export function formatMemoryFragments(fragments: MemoryFragment[]): string | null {
  if (fragments.length === 0) return null;

  const sections: string[] = [];
  for (const fragment of fragments) {
    sections.push(fragment.content);
  }
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Injection budget + change tracking (docs/53 TE-1 / TE-2)
// ---------------------------------------------------------------------------

/**
 * Aggregate byte budget for the injected memory block. The coordinator caps
 * fragment COUNT (50) but not bytes — a single curated-memory file rides in
 * whole, so without this the block is unbounded. Override:
 * OPENSWARM_MEMORY_MAX_BYTES.
 */
const MEMORY_MAX_BYTES = (() => {
  const env = Number(process.env.OPENSWARM_MEMORY_MAX_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 16 * 1024;
})();

const FRAGMENT_TRUNCATION_MARKER = "\n[memory fragment truncated to fit budget]";

export interface BudgetedFragments {
  readonly kept: MemoryFragment[];
  readonly droppedCount: number;
  readonly droppedBytes: number;
}

/**
 * Keep fragments in relevance order (stable — providers' own order breaks
 * ties) until the byte budget is exhausted; drop the rest. If the single most
 * relevant fragment alone exceeds the budget it is truncated rather than
 * dropped, so memory never silently disappears entirely.
 */
export function budgetFragments(
  fragments: MemoryFragment[],
  maxBytes: number = MEMORY_MAX_BYTES,
): BudgetedFragments {
  const ranked = fragments
    .map((fragment, i) => ({ fragment, i }))
    .sort(
      (a, b) =>
        (b.fragment.relevance ?? 0) - (a.fragment.relevance ?? 0) || a.i - b.i,
    )
    .map((r) => r.fragment);

  const kept: MemoryFragment[] = [];
  let used = 0;
  let droppedCount = 0;
  let droppedBytes = 0;
  for (const fragment of ranked) {
    const bytes = Buffer.byteLength(fragment.content, "utf8");
    if (used + bytes <= maxBytes) {
      kept.push(fragment);
      used += bytes;
    } else if (kept.length === 0) {
      // Top fragment alone exceeds the budget — truncate, don't drop.
      const sliced =
        fragment.content.slice(0, Math.max(0, maxBytes - FRAGMENT_TRUNCATION_MARKER.length)) +
        FRAGMENT_TRUNCATION_MARKER;
      kept.push({ ...fragment, content: sliced });
      used = maxBytes;
    } else {
      droppedCount++;
      droppedBytes += bytes;
    }
  }
  return { kept, droppedCount, droppedBytes };
}

/**
 * Last-injected memory-block hash per (session, agent) — the change-dedup
 * that stops re-injecting an unchanged block every turn (docs/53 TE-2; the
 * Codex world-state pattern, minus history surgery). Bounded LRU-ish: oldest
 * entry evicted past 256 keys.
 */
const lastInjectedHash = new Map<string, string>();
const LAST_INJECTED_MAX_KEYS = 256;

function injectionKey(context: TurnContext): string {
  return `${context.sessionId ?? ""}|${String(context.agentId ?? "")}`;
}

function blockHash(block: string): string {
  return crypto.createHash("sha1").update(block).digest("hex");
}

/** Test seam: forget change-dedup state (e.g. between simulated sessions). */
export function resetMemoryInjectionState(): void {
  lastInjectedHash.clear();
}

/**
 * Surface memory into a turn's inputs — the single seam used by every
 * engine-run site (worker + orchestrator). Registers providers (idempotent),
 * runs enrichTurn, budgets the fragments (docs/53 TE-1), then prepends the
 * block to the USER prompt — never the system prompt (docs/53 TE-2): a
 * memory block that varies turn-to-turn in the system prompt invalidates the
 * provider prompt cache for the whole static prefix (system prompt + tool
 * definitions) on every call of every worker.
 *
 * Change-dedup: an unchanged block is injected once per (session, agent) and
 * skipped on subsequent turns — it is already in the conversation history.
 * When the block CHANGES, the new one carries a replacement notice (the Codex
 * world-state pattern).
 *
 * Best-effort: returns the inputs unchanged on any failure, so memory never
 * blocks a turn. Set OPENSWARM_MEMORY_DEBUG=1 to log what was injected.
 *
 * `surfacedSkills` reports the skills present in this turn's context so
 * callers that record sessions can declare the exposure to sessionlog
 * (`SkillsSurfaced`) — cognitive-core's exposure attribution depends on it.
 * Skills in a previously-injected (deduped) block are still reported: they
 * remain in context even when no new block is injected this turn.
 */
export interface EnrichedTurnInputs {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly surfacedSkills: readonly SurfacedSkill[];
}

export async function enrichTurnInputs(
  systemPrompt: string,
  prompt: string,
  context: TurnContext,
): Promise<EnrichedTurnInputs> {
  let fragments: MemoryFragment[];
  try {
    await onSessionStart(
      context.agentId ? { agentId: String(context.agentId) } : undefined,
    );
    fragments = await onBeforeTurn(context);
  } catch {
    return { systemPrompt, prompt, surfacedSkills: [] };
  }

  const { kept, droppedCount, droppedBytes } = budgetFragments(fragments);

  // Exposure attribution reflects what actually enters context — kept only.
  const surfacedSkills = kept
    .map((f) => f.skill)
    .filter((s): s is SurfacedSkill => s !== undefined);

  const block = formatMemoryFragments(kept);
  if (!block) return { systemPrompt, prompt, surfacedSkills };

  // Unchanged since the last injection for this (session, agent) → the block
  // is already in history; skip re-injection (docs/53 TE-2).
  const key = injectionKey(context);
  const hash = blockHash(block);
  const previous = lastInjectedHash.get(key);
  if (previous === hash) {
    return { systemPrompt, prompt, surfacedSkills };
  }
  if (lastInjectedHash.size >= LAST_INJECTED_MAX_KEYS && !lastInjectedHash.has(key)) {
    const oldest = lastInjectedHash.keys().next().value;
    if (oldest !== undefined) lastInjectedHash.delete(oldest);
  }
  lastInjectedHash.set(key, hash);

  if (process.env.OPENSWARM_MEMORY_DEBUG === "1") {
    process.stderr.write(
      `[memory] injected ${kept.length} fragment(s)` +
        (droppedCount > 0 ? ` (dropped ${droppedCount}, ${droppedBytes} bytes over budget)` : "") +
        `: ${kept.map((f) => f.source).join(", ")}\n`,
    );
  }

  const replaceNotice =
    previous !== undefined
      ? "This memory context replaces all previously provided memory context.\n\n"
      : "";
  const wrapped =
    `<memory-context>\n# Relevant memory\n${replaceNotice}${block}\n</memory-context>`;
  return {
    systemPrompt,
    prompt: `${wrapped}\n\n# Task\n${prompt}`,
    surfacedSkills,
  };
}

export interface TurnCompleteInfo {
  readonly sessionId: string;
  readonly agentId?: AgentId;
  readonly turnIndex: number;
  readonly toolsUsed: readonly string[];
  readonly summary?: string;
}

export async function onAfterTurn(info: TurnCompleteInfo): Promise<void> {
  const coordinator = getMemoryCoordinator();
  await coordinator.onTurnComplete({
    sessionId: info.sessionId,
    agentId: info.agentId,
    turnIndex: info.turnIndex,
    toolsUsed: info.toolsUsed,
    summary: info.summary,
  });
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

export async function onCompaction(summary: CompressionSummary): Promise<void> {
  const coordinator = getMemoryCoordinator();
  await coordinator.onCompress(summary);
}

// ---------------------------------------------------------------------------
// Session end
// ---------------------------------------------------------------------------

export interface SessionEndInfo {
  readonly sessionId: string;
  readonly summary: string;
  readonly tags?: string[];
  readonly toolsUsed?: string[];
}

export async function onSessionEnd(info: SessionEndInfo): Promise<void> {
  // Archive the session in the durable archive store (FileArchiveStore when
  // the file provider installed it; in-memory otherwise).
  archiveSession({
    sessionId: info.sessionId,
    summary: info.summary,
    tags: info.tags,
    toolsUsed: info.toolsUsed,
  });

  const coordinator = getMemoryCoordinator();

  // Phase 3 B2 — fan the session summary out to persistence-capable
  // providers (minimem persists it via appendToday). Best-effort: a failed
  // provider write must not block shutdown.
  try {
    await coordinator.onMemoryWrite({
      scope: "project",
      content: [
        `Session ${info.sessionId} ended.`,
        info.summary,
        info.toolsUsed !== undefined && info.toolsUsed.length > 0
          ? `Tools used: ${info.toolsUsed.join(", ")}`
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }

  // Cadence-gated, best-effort kick of the cognitive-core consolidation loop.
  // Fire-and-forget: never blocks or fails session shutdown, and no-ops when
  // cognitive-core (`cogcore`) is not installed.
  void maybeAutoConsolidate().catch(() => {});

  // Shut down all providers
  await coordinator.shutdown();
}
