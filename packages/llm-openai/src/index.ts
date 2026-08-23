/**
 * `openswarm-llm-openai` — generic OpenAI-compatible chat-completions routes
 * for dsh, targeting endpoints that reject DeepSeek's reasoning extensions:
 * Azure OpenAI's `/openai/v1` surface (verified live against gpt-5.5),
 * LiteLLM proxies, and any Bearer-authenticated chat endpoint.
 *
 * The rung-5 implementation (docs/01 Phase 3): the published
 * `DeepSeekAdapter` already speaks Bearer + `/chat/completions` SSE with the
 * full StreamChunk contract (usage-before-finish, raw-JSON tool arguments,
 * abort/error paths). What breaks strict OpenAI endpoints is its intrinsic
 * reasoning advertisement — `resolveModel` always declares a default effort,
 * which makes every request carry a `thinking` field, and caps serialize as
 * `max_tokens`, which reasoning-era models reject in favor of
 * `max_completion_tokens`. This subclass removes the reasoning ad and strips
 * effort/cap from requests, so the wire stays plain chat-completions.
 *
 * ponytail: no output-token cap and no reasoning_effort control on these
 * routes (both stripped rather than translated); upgrade path is our own
 * request serializer or an upstream PR making the thinking-field emission
 * provider-configurable. Ledgered in docs/01.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'

export interface ModelEntry {
  id: string
  contextWindow?: number
}

export interface OpenAiChatConfig {
  /** Provider route names this adapter serves (e.g. ['azure', 'litellm']). */
  routes: string[]
  /** Endpoint namespace; the adapter appends `/chat/completions`. */
  baseURL?: string
  /** Environment variable consulted per request when `baseURL` is unset. */
  baseURLEnv?: string
  /** Environment variable holding the Bearer credential. */
  apiKeyEnv: string
  models: ModelEntry[]
  defaultContextWindow?: number
  streamIdleTimeoutMs?: number
}

export const name = 'openswarm-llm-openai'
export const inject = ['llm']

export const Config = z.object({
  routes: z.array(String).default(['openai']),
  baseURL: z.string(),
  baseURLEnv: z.string().default('OPENSWARM_LLM_BASE_URL'),
  apiKeyEnv: z.string().default('OPENSWARM_LLM_API_KEY'),
  models: z.array(z.object({ id: z.string().required(), contextWindow: z.number() })).default([]),
  defaultContextWindow: z.number().default(128_000),
  streamIdleTimeoutMs: z.number().default(300_000),
})

/** DeepSeekAdapter minus the DeepSeek reasoning dialect. */
class OpenAiChatAdapter extends DeepSeekAdapter {
  private readonly label: string

  constructor(config: ConstructorParameters<typeof DeepSeekAdapter>[0], label: string) {
    super(config)
    this.label = label
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.label }
  }

  /** Advertise plain chat models: no reasoning efforts, no default cap. */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const info: any = await super.resolveModel(provider, model, signal as never)
    const { reasoning: _dropped, defaultMaxTokens: _cap, ...plain } = info
    return plain
  }

  /**
   * Strip request fields these endpoints reject: `reasoningEffort` would
   * serialize a `thinking` object, and `maxTokens` serializes as
   * `max_tokens`. The agent loop streams through the prepared call, so the
   * strip lives there; `stream()` gets the same treatment for direct callers.
   */
  private strip(options: any) {
    const { reasoningEffort: _effort, maxTokens: _cap, ...plain } = options
    return plain
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const prepared: any = await super.prepareCall(provider, model, signal as never)
    const inner = prepared.stream
    return {
      ...prepared,
      // The prepared model info must match resolveModel's plain-chat ad.
      model: await this.resolveModel(provider, model, signal),
      stream: (options: any) => inner(this.strip(options)),
    }
  }

  override stream(options: any) {
    return super.stream(this.strip(options))
  }
}

export function apply(ctx: Context, config: OpenAiChatConfig): void {
  // Resolved per request (options() is consulted per call), so env-driven
  // deployments — the worktree member composition — need no static URL.
  const resolveBaseURL = (): string => {
    const url = config.baseURL ?? process.env[config.baseURLEnv ?? 'OPENSWARM_LLM_BASE_URL']
    if (url === undefined || url.length === 0) {
      throw new LlmError(
        `openswarm-llm-openai: no baseURL configured and ${config.baseURLEnv ?? 'OPENSWARM_LLM_BASE_URL'} is unset`,
        'MISSING_CREDENTIAL',
      )
    }
    return url.replace(/\/+$/u, '')
  }
  const connection = () => ({
    baseURL: resolveBaseURL(),
    models: config.models,
    defaults: {},
    defaultContextWindow: config.defaultContextWindow ?? 128_000,
    maxTokens: undefined,
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
    retryPolicy: undefined,
    // Fields below are file/image machinery bounds the chat path checks lazily.
    maxRequestFilesBytes: 0,
    maxInlineRequestImageBytes: 0,
    maxImagesPerRequest: 0,
  })
  const adapter = new OpenAiChatAdapter(
    {
      options: connection,
      resolveApiKey: async () => {
        const key = process.env[config.apiKeyEnv]
        if (key === undefined || key.length === 0) {
          throw new LlmError(
            `openswarm-llm-openai: export ${config.apiKeyEnv} for routes [${config.routes.join(', ')}]`,
            'MISSING_CREDENTIAL',
          )
        }
        return key
      },
      resolveUserId: () => 'openswarm',
    } as never,
    'OpenAI-compatible',
  )
  ctx.llm.registerAdapter(config.routes, adapter)
}
