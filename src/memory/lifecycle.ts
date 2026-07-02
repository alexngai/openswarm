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

/**
 * Surface memory into a turn's inputs — the single seam used by every
 * engine-run site (worker + orchestrator). Registers providers (idempotent),
 * runs enrichTurn, then folds the memory block into the system prompt when it
 * is non-empty, else prepends it to the user prompt (the SDK-preset path uses
 * an empty system prompt, so writing there would clobber the preset).
 *
 * Best-effort: returns the inputs unchanged on any failure, so memory never
 * blocks a turn. Set OPENSWARM_MEMORY_DEBUG=1 to log what was injected.
 *
 * `surfacedSkills` reports the skills injected into this turn so callers that
 * record sessions can declare the exposure to sessionlog (`SkillsSurfaced`) —
 * cognitive-core's exposure attribution depends on that declaration.
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

  const surfacedSkills = fragments
    .map((f) => f.skill)
    .filter((s): s is SurfacedSkill => s !== undefined);

  const block = formatMemoryFragments(fragments);
  if (!block) return { systemPrompt, prompt, surfacedSkills };

  if (process.env.OPENSWARM_MEMORY_DEBUG === "1") {
    process.stderr.write(
      `[memory] injected ${fragments.length} fragment(s): ${fragments
        .map((f) => f.source)
        .join(", ")}\n`,
    );
  }

  if (systemPrompt.trim().length > 0) {
    return { systemPrompt: `${systemPrompt}\n\n${block}`, prompt, surfacedSkills };
  }
  return {
    systemPrompt,
    prompt: `# Relevant memory\n${block}\n\n# Task\n${prompt}`,
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
