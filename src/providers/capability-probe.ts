/**
 * capability-probe — discover a self-hosted model's real limits instead of
 * guessing them.
 *
 * `LiteLLMTransportProvider` serves arbitrary gateway/self-hosted models, so it
 * cannot use the static capability catalog the first-party transports use. It
 * previously fell back to a hardcoded 200k context / 8k output for every model
 * (docs/63 §9 F1). That number drives compaction: a model actually served at
 * 32k never trips the L1 trigger, so instead of compacting, the run walks into
 * a provider-side context-overflow error.
 *
 * OpenAI-compatible servers advertise the truth, just not in one place:
 *
 *   - **vLLM / SGLang** put `max_model_len` on each entry of `GET /v1/models`.
 *   - **LiteLLM proxy** exposes `GET /model/info` with a `model_info` block
 *     carrying `max_input_tokens` / `max_output_tokens` / `max_tokens`.
 *
 * This module tries both, best-effort. It never throws and never blocks
 * startup for long: any failure, timeout, or unrecognised shape falls back to
 * the caller's defaults. An explicit env override always wins, because an
 * operator who knows the number should not have to argue with a probe.
 */

/** Env override consulted before any network call. */
export const MAX_CONTEXT_ENV = "OPENSWARM_MAX_CONTEXT_TOKENS";
/** Env override consulted before any network call. */
export const MAX_OUTPUT_ENV = "OPENSWARM_MAX_OUTPUT_TOKENS";
/** Set to "0" to skip the network probe entirely. */
export const PROBE_ENABLED_ENV = "OPENSWARM_CAPABILITY_PROBE";

const DEFAULT_TIMEOUT_MS = 2_000;

/** Where a discovered value came from — surfaced for diagnostics. */
export type CapabilitySource =
  | "env"
  | "models-endpoint"
  | "model-info-endpoint"
  | "none";

export interface ProbedCapabilities {
  readonly maxContextTokens?: number;
  readonly maxOutputTokens?: number;
  readonly source: CapabilitySource;
}

export interface ProbeOptions {
  /** Gateway base URL, typically ending in `/v1`. */
  readonly baseURL: string;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests. */
  readonly env?: NodeJS.ProcessEnv;
}

function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const n = Number.parseInt(raw.trim(), 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return undefined;
}

/** Read the env overrides. Returns `undefined` when neither is set. */
export function capabilitiesFromEnv(
  env: NodeJS.ProcessEnv,
): ProbedCapabilities | undefined {
  const context = parsePositiveInt(env[MAX_CONTEXT_ENV]);
  const output = parsePositiveInt(env[MAX_OUTPUT_ENV]);
  if (context === undefined && output === undefined) return undefined;
  return {
    ...(context !== undefined ? { maxContextTokens: context } : {}),
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
    source: "env",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pick the entry describing `modelId`. Servers vary on whether the id is the
 * full path (`/models/Qwen3-30B`), the HF repo id, or an alias, so an exact
 * match is preferred and a single-entry list is accepted as the answer.
 */
function selectModelEntry(
  entries: readonly unknown[],
  modelId: string,
): Record<string, unknown> | undefined {
  const records = entries.filter(isRecord);
  if (records.length === 0) return undefined;
  const exact = records.find((e) => e["id"] === modelId);
  if (exact !== undefined) return exact;
  const suffix = records.find(
    (e) =>
      typeof e["id"] === "string" &&
      (String(e["id"]).endsWith(modelId) || modelId.endsWith(String(e["id"]))),
  );
  if (suffix !== undefined) return suffix;
  // A single-model server is unambiguous even when the id was aliased.
  return records.length === 1 ? records[0] : undefined;
}

/** Strip a trailing `/v1` (and any trailing slash) to reach the server root. */
function serverRoot(baseURL: string): string {
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function getJson(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(apiKey !== undefined && apiKey.length > 0
        ? { authorization: `Bearer ${apiKey}` }
        : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

/** vLLM / SGLang: `GET /v1/models` → `data[].max_model_len`. */
async function probeModelsEndpoint(
  opts: ProbeOptions,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProbedCapabilities | undefined> {
  const url = `${opts.baseURL.replace(/\/+$/, "")}/models`;
  const body = await getJson(url, opts.apiKey, timeoutMs, fetchImpl);
  if (!isRecord(body) || !Array.isArray(body["data"])) return undefined;

  const entry = selectModelEntry(body["data"], opts.modelId);
  if (entry === undefined) return undefined;

  const context =
    parsePositiveInt(entry["max_model_len"]) ??
    parsePositiveInt(entry["context_window"]) ??
    parsePositiveInt(entry["context_length"]);
  const output =
    parsePositiveInt(entry["max_output_tokens"]) ??
    parsePositiveInt(entry["max_completion_tokens"]);
  if (context === undefined && output === undefined) return undefined;

  return {
    ...(context !== undefined ? { maxContextTokens: context } : {}),
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
    source: "models-endpoint",
  };
}

/** LiteLLM proxy: `GET /model/info` → `data[].model_info.max_input_tokens`. */
async function probeModelInfoEndpoint(
  opts: ProbeOptions,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProbedCapabilities | undefined> {
  const url = `${serverRoot(opts.baseURL)}/model/info`;
  const body = await getJson(url, opts.apiKey, timeoutMs, fetchImpl);
  if (!isRecord(body) || !Array.isArray(body["data"])) return undefined;

  // LiteLLM nests the interesting numbers one level down and names the model
  // under `model_name`, not `id`.
  const normalized = body["data"].filter(isRecord).map((entry) => ({
    id: entry["model_name"] ?? entry["id"],
    ...(isRecord(entry["model_info"]) ? entry["model_info"] : {}),
  }));
  const entry = selectModelEntry(normalized, opts.modelId);
  if (entry === undefined) return undefined;

  const context =
    parsePositiveInt(entry["max_input_tokens"]) ??
    parsePositiveInt(entry["max_tokens"]);
  const output = parsePositiveInt(entry["max_output_tokens"]);
  if (context === undefined && output === undefined) return undefined;

  return {
    ...(context !== undefined ? { maxContextTokens: context } : {}),
    ...(output !== undefined ? { maxOutputTokens: output } : {}),
    source: "model-info-endpoint",
  };
}

/**
 * Discover context/output limits for an OpenAI-compatible endpoint.
 *
 * Never throws. Returns `{ source: "none" }` when nothing could be learned,
 * leaving the caller on its defaults.
 */
export async function probeOpenAICompatCapabilities(
  opts: ProbeOptions,
): Promise<ProbedCapabilities> {
  const env = opts.env ?? process.env;

  // An operator who set the number explicitly always wins.
  const fromEnv = capabilitiesFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;

  if (env[PROBE_ENABLED_ENV] === "0") return { source: "none" };
  if (opts.baseURL.length === 0) return { source: "none" };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return { source: "none" };

  for (const probe of [probeModelsEndpoint, probeModelInfoEndpoint]) {
    try {
      const result = await probe(opts, timeoutMs, fetchImpl);
      if (result !== undefined) return result;
    } catch {
      // Unreachable, unauthorised, timed out, or an unexpected shape — a probe
      // must never be the reason a run cannot start.
    }
  }

  return { source: "none" };
}

/**
 * Fold a probe result over a capability baseline.
 *
 * The output cap is clamped to the context window: a server reporting a 32k
 * window alongside a default 8k output cap is fine, but a 4k window with an 8k
 * cap would let the engine request more than the model can hold.
 */
export function applyProbedCapabilities<
  T extends { maxContextTokens: number; maxOutputTokens: number },
>(baseline: T, probed: ProbedCapabilities): T {
  const maxContextTokens = probed.maxContextTokens ?? baseline.maxContextTokens;
  const requestedOutput = probed.maxOutputTokens ?? baseline.maxOutputTokens;
  return {
    ...baseline,
    maxContextTokens,
    maxOutputTokens: Math.max(1, Math.min(requestedOutput, maxContextTokens)),
  };
}
