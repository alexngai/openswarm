/**
 * sampling — resolve sampling and tool-choice levers from flags + environment.
 *
 * These reach the provider through `RunConfig` (docs/63 F2/F3). Before this
 * they were unreachable: every transport read `temperature` / `topP` / `topK`
 * off `ProviderRequest`, but no engine ever wrote them, so the only way to tune
 * a self-hosted model was `LITELLM_EXTRA_BODY` — which the swarm worker path
 * could not set per-role at all.
 *
 * Environment variables are the propagation mechanism on purpose: the
 * subprocess spawner spreads `process.env`, so a value set once on the
 * orchestrator reaches every worker without new IPC fields. Explicit values
 * (CLI flags) win over the environment.
 */

export const TEMPERATURE_ENV = "OPENSWARM_TEMPERATURE";
export const TOP_P_ENV = "OPENSWARM_TOP_P";
export const TOP_K_ENV = "OPENSWARM_TOP_K";
export const TOOL_CHOICE_ENV = "OPENSWARM_TOOL_CHOICE";

export type ToolChoice =
  | "auto"
  | "required"
  | "none"
  | { readonly name: string };

export interface SamplingConfig {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly toolChoice?: ToolChoice;
}

/** Explicit overrides (CLI flags) layered over the environment. */
export interface SamplingOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly toolChoice?: ToolChoice;
}

function parseFloatEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : undefined;
}

function parseIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) || n < 1 ? undefined : n;
}

/**
 * Parse a tool-choice value. `auto` / `required` / `none` are the modes;
 * anything else is treated as a tool name to pin. Returns `undefined` for an
 * empty value so an unset variable is not mistaken for a pinned tool named "".
 */
export function parseToolChoice(raw: string | undefined): ToolChoice | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "auto" || lower === "required" || lower === "none") return lower;
  return { name: trimmed };
}

/**
 * Resolve the effective sampling config. Only defined fields are present, so
 * the result can be spread straight into a `RunConfig` without overwriting
 * provider defaults with `undefined`.
 */
export function resolveSamplingConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: SamplingOverrides = {},
): SamplingConfig {
  const temperature = overrides.temperature ?? parseFloatEnv(env[TEMPERATURE_ENV]);
  const topP = overrides.topP ?? parseFloatEnv(env[TOP_P_ENV]);
  const topK = overrides.topK ?? parseIntEnv(env[TOP_K_ENV]);
  const toolChoice =
    overrides.toolChoice ?? parseToolChoice(env[TOOL_CHOICE_ENV]);

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  };
}

/**
 * Publish resolved values back into the environment so spawned workers inherit
 * them. Only writes keys that are set and not already present, so a per-worker
 * override stays authoritative.
 */
export function exportSamplingEnv(
  config: SamplingConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (config.temperature !== undefined && env[TEMPERATURE_ENV] === undefined) {
    env[TEMPERATURE_ENV] = String(config.temperature);
  }
  if (config.topP !== undefined && env[TOP_P_ENV] === undefined) {
    env[TOP_P_ENV] = String(config.topP);
  }
  if (config.topK !== undefined && env[TOP_K_ENV] === undefined) {
    env[TOP_K_ENV] = String(config.topK);
  }
  if (config.toolChoice !== undefined && env[TOOL_CHOICE_ENV] === undefined) {
    env[TOOL_CHOICE_ENV] =
      typeof config.toolChoice === "string"
        ? config.toolChoice
        : config.toolChoice.name;
  }
}
