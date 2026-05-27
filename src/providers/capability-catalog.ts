/**
 * Per-model capability catalog.
 *
 * Replaces the four inline `computeCapabilities` conditionals scattered
 * across the transports with a single discoverable table. Each entry
 * declares modality support, behavior flags, and token limits for a model
 * (or family of models, via regex prefix matching).
 *
 * The transports continue to expose `ProviderCapabilities` (the engine
 * surface, see `./index.ts`) — they just populate it from a `ModelCapability`
 * lookup instead of bespoke conditionals. Callers that want the richer
 * surface (videoIn / audioIn / thinking) can call `getXxxModelCapability()`
 * directly.
 *
 * Modeled on kimi-code's `kosong/src/providers/capability-registry.ts`.
 */

export interface ModelCapability {
  // Modality support
  readonly imageIn: boolean;
  readonly videoIn: boolean;
  readonly audioIn: boolean;
  // Behavior flags
  readonly thinking: boolean;
  readonly parallelToolUse: boolean;
  readonly promptCache: boolean;
  // Token limits
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Sentinel returned when a model id matches no catalog entry. Conservative
 * defaults: assume nothing works until proven otherwise. Frozen so callers
 * can safely share the reference.
 */
export const UNKNOWN_MODEL_CAPABILITY: ModelCapability = Object.freeze({
  imageIn: false,
  videoIn: false,
  audioIn: false,
  thinking: false,
  parallelToolUse: false,
  promptCache: false,
  maxContextTokens: 0,
  maxOutputTokens: 0,
});

interface CatalogRow {
  readonly match: RegExp;
  readonly capability: ModelCapability;
}

function resolveCatalog(catalog: readonly CatalogRow[], modelId: string): ModelCapability {
  const id = modelId.toLowerCase();
  for (const row of catalog) {
    if (row.match.test(id)) return row.capability;
  }
  return UNKNOWN_MODEL_CAPABILITY;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

// Order matters: more-specific patterns first. o-series must come before
// any gpt-* matcher that could collide.
const OPENAI_CATALOG: readonly CatalogRow[] = [
  // Reasoning (o1, o3, o4, ...). The model ids look like "o1", "o1-mini",
  // "o3-mini", "o4-mini". The lookahead requires an end-of-string OR a
  // hyphen so "ollama-..." (hypothetical) doesn't collide.
  {
    match: /^o[1-9](?:-|$)/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: true,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 100_000,
    },
  },
  // gpt-5 family
  {
    match: /^gpt-5/,
    capability: {
      imageIn: true,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 400_000,
      maxOutputTokens: 16_384,
    },
  },
  // gpt-4o family (multimodal: vision + audio)
  {
    match: /^gpt-4o/,
    capability: {
      imageIn: true,
      videoIn: false,
      audioIn: true,
      thinking: false,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_384,
    },
  },
  // gpt-4 with vision (legacy variants)
  {
    match: /^gpt-4-vision|^gpt-4v/,
    capability: {
      imageIn: true,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    },
  },
  // gpt-4 default
  {
    match: /^gpt-4/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 4_096,
    },
  },
];

export function getOpenAIModelCapability(modelId: string): ModelCapability {
  return resolveCatalog(OPENAI_CATALOG, modelId);
}

// ---------------------------------------------------------------------------
// Google (Gemini)
// ---------------------------------------------------------------------------

const GOOGLE_CATALOG: readonly CatalogRow[] = [
  // gemini-2.5-pro
  {
    match: /^gemini-2\.5-pro/,
    capability: {
      imageIn: true,
      videoIn: true,
      audioIn: true,
      thinking: true,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 2_097_152,
      maxOutputTokens: 8_192,
    },
  },
  // gemini-2.5 (flash etc.)
  {
    match: /^gemini-2\.5/,
    capability: {
      imageIn: true,
      videoIn: true,
      audioIn: true,
      thinking: true,
      parallelToolUse: true,
      promptCache: true,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 8_192,
    },
  },
  // gemini-1.5-*
  {
    match: /^gemini-1\.5/,
    capability: {
      imageIn: true,
      videoIn: true,
      audioIn: true,
      thinking: false,
      // Held conservatively false until we live-verify parallel tool use
      // on Gemini 1.5 (the legacy comment in google-transport.ts noted this).
      parallelToolUse: false,
      promptCache: true,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 8_192,
    },
  },
  // generic gemini
  {
    match: /^gemini/,
    capability: {
      imageIn: true,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: false,
      promptCache: false,
      maxContextTokens: 1_048_576,
      maxOutputTokens: 8_192,
    },
  },
];

export function getGoogleModelCapability(modelId: string): ModelCapability {
  return resolveCatalog(GOOGLE_CATALOG, modelId);
}

// ---------------------------------------------------------------------------
// xAI (Grok)
// ---------------------------------------------------------------------------

const XAI_CATALOG: readonly CatalogRow[] = [
  // Reasoning grok variants. grok-3-mini is xAI's "reasoning" variant of grok-3.
  {
    match: /^grok-3-mini|^grok.*reasoning/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: true,
      parallelToolUse: false,
      promptCache: false,
      maxContextTokens: 131_072,
      maxOutputTokens: 64_000,
    },
  },
  // grok-4
  {
    match: /^grok-4/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: false,
      maxContextTokens: 256_000,
      maxOutputTokens: 64_000,
    },
  },
  // grok-2 / grok-3 / other
  {
    match: /^grok-/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: false,
      maxContextTokens: 131_072,
      maxOutputTokens: 64_000,
    },
  },
];

export function getXaiModelCapability(modelId: string): ModelCapability {
  return resolveCatalog(XAI_CATALOG, modelId);
}

// ---------------------------------------------------------------------------
// DashScope (Kimi, Qwen)
// ---------------------------------------------------------------------------

const DASHSCOPE_CATALOG: readonly CatalogRow[] = [
  // Kimi family
  {
    match: /^kimi/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: false,
      promptCache: false,
      maxContextTokens: 131_072,
      maxOutputTokens: 8_192,
    },
  },
  // Qwen family (qwen-plus, qwen-max, qwen-turbo, qwen2.5-*, qwen3-*)
  {
    match: /^qwen/,
    capability: {
      imageIn: false,
      videoIn: false,
      audioIn: false,
      thinking: false,
      parallelToolUse: true,
      promptCache: false,
      maxContextTokens: 131_072,
      maxOutputTokens: 8_192,
    },
  },
];

export function getDashScopeModelCapability(modelId: string): ModelCapability {
  return resolveCatalog(DASHSCOPE_CATALOG, modelId);
}
