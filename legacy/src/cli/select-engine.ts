/**
 * planEngine — the single source of truth for CLI ↔ worker engine selection.
 *
 * The single-agent runtime (`runtime.ts`) and swarm workers (`worker-entry.ts`)
 * previously carried near-identical framework→engine ladders that had drifted:
 * workers lacked a `codex-native` branch and, for an explicit
 * `native`/`hardened-native` framework with a non-native model, silently fell
 * back to the Claude SDK instead of erroring like the CLI.
 *
 * This module owns the *decision* only — which engine kind to build, which
 * resolved provider backs it, and whether to harden — as pure, side-effect-free
 * data. Each caller still constructs the engine itself (the CLI defers to
 * `makeEngine(sessionId)`; workers build eagerly keyed on `agentId`) because the
 * surrounding wiring genuinely differs (auth fallbacks, codex peer tools,
 * compaction sizing). Keeping selection here guarantees both callers agree on
 * the same model+framework → engine mapping.
 */

import { resolveProvider } from "../providers/routing.js";
import type { ResolvedProvider } from "../providers/index.js";
import type { FrameworkChoice } from "./argv.js";

/** codex backend is gpt-5.x only; used when no explicit gpt* model is given. */
export const CODEX_NATIVE_DEFAULT_MODEL = "gpt-5.5";

export interface PlanEngineInput {
  readonly framework: FrameworkChoice;
  /** Model id AFTER alias resolution. */
  readonly resolvedModelId: string;
  /** Scripted-test mode (OPENSWARM_TEST_SCRIPT). */
  readonly scripted?: boolean;
}

/**
 * What to build — not how. `resolved` is carried through so callers don't
 * re-run `resolveProvider`.
 */
export type EnginePlan =
  | { readonly kind: "scripted" }
  | { readonly kind: "claude-sdk"; readonly resolved: ResolvedProvider }
  | { readonly kind: "codex-chatgpt" }
  | { readonly kind: "codex-native"; readonly codexModelId: string }
  | { readonly kind: "native"; readonly resolved: ResolvedProvider; readonly hardened: boolean };

export type PlanEngineResult =
  | { readonly ok: true; readonly plan: EnginePlan; readonly effectiveModelId: string }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve `(framework, model)` into an {@link EnginePlan}.
 *
 * Precedence mirrors the CLI's historical ladder: the codex frameworks are
 * selected before scripted mode (so codex-native unit tests still build the
 * codex engine under OPENSWARM_TEST_SCRIPT), then scripted, then provider
 * resolution for the SDK/native/auto frameworks.
 *
 * `auto` + any non-Claude resolvable model now plans a **hardened** native
 * engine (Phase 2.1); `--framework native` remains the explicit non-hardened
 * escape hatch.
 */
export function planEngine(input: PlanEngineInput): PlanEngineResult {
  const { framework, resolvedModelId } = input;

  if (framework === "codex-chatgpt") {
    return { ok: true, plan: { kind: "codex-chatgpt" }, effectiveModelId: resolvedModelId };
  }

  if (framework === "codex-native") {
    const codexModelId = /^gpt/i.test(resolvedModelId)
      ? resolvedModelId
      : CODEX_NATIVE_DEFAULT_MODEL;
    return {
      ok: true,
      plan: { kind: "codex-native", codexModelId },
      effectiveModelId: codexModelId,
    };
  }

  if (input.scripted === true) {
    return { ok: true, plan: { kind: "scripted" }, effectiveModelId: resolvedModelId };
  }

  const resolved = resolveProvider(resolvedModelId);
  if (resolved.kind === "error") {
    return { ok: false, message: resolved.message ?? `unknown model "${resolvedModelId}"` };
  }

  if (framework === "claude-agent-sdk") {
    if (resolved.kind !== "sdk") {
      return {
        ok: false,
        message: `--framework claude-agent-sdk requires an Anthropic model; received ${resolvedModelId}.`,
      };
    }
    return { ok: true, plan: { kind: "claude-sdk", resolved }, effectiveModelId: resolvedModelId };
  }

  if (framework === "native" || framework === "hardened-native") {
    if (resolved.kind !== "native") {
      return {
        ok: false,
        message:
          `--framework ${framework} does not support Claude models.\n` +
          "Use `--framework auto` (default) or `--framework claude-agent-sdk`.",
      };
    }
    return {
      ok: true,
      plan: { kind: "native", resolved, hardened: framework === "hardened-native" },
      effectiveModelId: resolvedModelId,
    };
  }

  // auto — Claude routes through the SDK; every other resolvable model builds a
  // hardened native engine (2.1: the retry/compaction wrapper is the safer
  // default for third-party transports).
  if (resolved.kind === "sdk") {
    return { ok: true, plan: { kind: "claude-sdk", resolved }, effectiveModelId: resolvedModelId };
  }
  return {
    ok: true,
    plan: { kind: "native", resolved, hardened: true },
    effectiveModelId: resolvedModelId,
  };
}
