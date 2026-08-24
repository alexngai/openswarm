/**
 * `openswarm-llm-anthropic` — Anthropic Messages adapter for dsh (docs/01
 * Phase 3b), the "wrap an LLM library" adapter pattern: the official SDK
 * owns transport, auth, and (for Bedrock) the AWS event-stream framing;
 * this package owns the translation to dsh's StreamChunk contract.
 *
 * Backends: `bedrock` (bearer token via AWS_BEARER_TOKEN_BEDROCK, verified
 * live against us.anthropic haiku) and `anthropic` (api.anthropic.com with
 * ANTHROPIC_API_KEY).
 *
 * Contract obligations honored (adding-an-llm-adapter cookbook): usage
 * BEFORE finish, nothing after finish; tool arguments as raw JSON strings
 * streamed as argumentsDelta; block indexes in first-seen order; throw
 * LlmError for transport failures; honor options.signal.
 *
 * ponytail: no extended-thinking support v1 (reasoning blocks in history
 * are dropped; no reasoning advertisement), images rejected UNSUPPORTED.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

export interface ModelEntry {
  id: string
  contextWindow?: number
}

export interface AnthropicConfig {
  routes: string[]
  /** `bedrock` (AWS_BEARER_TOKEN_BEDROCK + region) or `anthropic` (ANTHROPIC_API_KEY). */
  backend: 'bedrock' | 'anthropic'
  models: ModelEntry[]
  /** Anthropic requires max_tokens on every request; the default cap. */
  maxTokens?: number
  defaultContextWindow?: number
  awsRegion?: string
}

export const name = 'openswarm-llm-anthropic'
export const inject = ['llm']

export const Config = z.object({
  routes: z.array(String).default(['bedrock']),
  backend: z.union(['bedrock', 'anthropic'] as const).default('bedrock'),
  models: z.array(z.object({ id: z.string().required(), contextWindow: z.number() })).default([]),
  maxTokens: z.number().default(32_768),
  defaultContextWindow: z.number().default(200_000),
  awsRegion: z.string(),
})

// ---------------------------------------------------------------------------
// Pure translation: dsh messages → Anthropic params.

type AnthropicContent = Record<string, unknown>
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicContent[] }

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** Map one dsh message's blocks into Anthropic content items. */
function mapBlocks(message: Message): AnthropicContent[] {
  const out: AnthropicContent[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) out.push({ type: 'text', text: block.text })
        break
      case 'tool-call':
        out.push({
          type: 'tool_use',
          id: String(block.id),
          name: block.name,
          input: block.arguments.trim() === '' ? {} : JSON.parse(block.arguments),
        })
        break
      case 'tool-result':
        out.push({
          type: 'tool_result',
          tool_use_id: String(block.toolCallId),
          content: textOf(block.content),
          ...(block.isError === true ? { is_error: true } : {}),
        })
        break
      case 'reasoning':
        // v1: no extended thinking; historical reasoning is dropped.
        break
      case 'image':
        throw new LlmError('openswarm-llm-anthropic does not accept image input yet', 'UNSUPPORTED_CONTENT')
      default:
        break
    }
  }
  return out
}

/** Anthropic wants user-first alternation; merge consecutive same-role turns. */
export function mapMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = mapBlocks(message)
    if (content.length === 0) continue
    const last = out[out.length - 1]
    if (last !== undefined && last.role === role) last.content.push(...content)
    else out.push({ role, content })
  }
  return out
}

export function mapTools(tools: ToolSchema[] | undefined): AnthropicContent[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

// ---------------------------------------------------------------------------
// Pure translation: Anthropic stream events → StreamChunk sequence.

/**
 * Translate the SDK's raw message-stream events. Generic over the event
 * iterable so tests script events without the SDK. Emits usage before
 * finish and nothing after finish, per the adapter contract.
 */
export async function* translateEvents(
  events: AsyncIterable<any> | Iterable<any>,
): AsyncGenerator<StreamChunk> {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const open = new Map<number, { kind: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; text: string; args: string }>()
  let stopReason: string | null | undefined
  for await (const event of events as AsyncIterable<any>) {
    switch (event.type) {
      case 'message_start': {
        const u = event.message?.usage ?? {}
        usage.inputTokens = u.input_tokens ?? 0
        usage.cacheReadTokens = u.cache_read_input_tokens ?? 0
        usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0
        break
      }
      case 'content_block_start': {
        const index = event.index
        const block = event.content_block
        if (block?.type === 'tool_use') {
          open.set(index, { kind: 'tool-call', id: block.id, name: block.name, text: '', args: '' })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: '' }
        } else if (block?.type === 'thinking') {
          open.set(index, { kind: 'reasoning', text: '', args: '' })
          yield { type: 'block-start', index, blockType: 'reasoning' }
        } else {
          open.set(index, { kind: 'text', text: block?.text ?? '', args: '' })
          yield { type: 'block-start', index, blockType: 'text' }
          if (block?.text) yield { type: 'text-delta', index, text: block.text }
        }
        break
      }
      case 'content_block_delta': {
        const index = event.index
        const entry = open.get(index)
        if (entry === undefined) break
        const delta = event.delta
        if (delta?.type === 'text_delta') {
          entry.text += delta.text
          yield { type: 'text-delta', index, text: delta.text }
        } else if (delta?.type === 'thinking_delta') {
          entry.text += delta.thinking
          yield { type: 'reasoning-delta', index, text: delta.thinking }
        } else if (delta?.type === 'input_json_delta') {
          entry.args += delta.partial_json
          yield {
            type: 'tool-call-delta',
            index,
            id: entry.id as never,
            argumentsDelta: delta.partial_json,
          }
        }
        break
      }
      case 'content_block_stop': {
        const index = event.index
        const entry = open.get(index)
        if (entry === undefined) break
        open.delete(index)
        const block: ContentBlock =
          entry.kind === 'tool-call'
            ? { type: 'tool-call', id: entry.id as never, name: entry.name ?? 'tool', arguments: entry.args === '' ? '{}' : entry.args }
            : entry.kind === 'reasoning'
              ? ({ type: 'reasoning', text: entry.text } as never)
              : { type: 'text', text: entry.text }
        yield { type: 'block-end', index, block }
        break
      }
      case 'message_delta': {
        usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens
        stopReason = event.delta?.stop_reason ?? stopReason
        break
      }
      case 'message_stop': {
        yield { type: 'usage', usage: { ...usage } }
        yield {
          type: 'finish',
          reason:
            stopReason === 'tool_use'
              ? { kind: 'tool-calls' }
              : stopReason === 'max_tokens'
                ? { kind: 'max-tokens' }
                : { kind: 'stop' },
        }
        return
      }
      default:
        break
    }
  }
  // Provider ended without message_stop: surface as a transport failure.
  throw new LlmError('Anthropic stream ended without message_stop', 'TRANSPORT')
}

// ---------------------------------------------------------------------------
// Adapter.

class AnthropicAdapter extends LlmAdapter {
  private client: any

  constructor(private readonly cfg: () => AnthropicConfig) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: this.cfg().backend === 'bedrock' ? 'Anthropic (Bedrock)' : 'Anthropic' }
  }

  override listModels(provider: string) {
    return Promise.resolve(
      this.cfg().models.map((m) => ({ provider, id: m.id, name: m.id, inputModalities: ['text' as const] })),
    )
  }

  override resolveModel(provider: string, model: string) {
    const cfg = this.cfg()
    const entry = cfg.models.find((m) => m.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text' as const],
      context: { contextWindow: entry?.contextWindow ?? cfg.defaultContextWindow ?? 200_000 },
      defaultMaxTokens: cfg.maxTokens ?? 32_768,
    } as never)
  }

  private async resolveClient(): Promise<any> {
    if (this.client !== undefined) return this.client
    const cfg = this.cfg()
    if (cfg.backend === 'bedrock') {
      const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
      this.client = new AnthropicBedrock({
        awsRegion: cfg.awsRegion ?? process.env['AWS_REGION'] ?? 'us-east-1',
      })
    } else {
      const sdk: any = await import('@anthropic-ai/sdk' as never)
      this.client = new (sdk.Anthropic ?? sdk.default)({})
    }
    return this.client
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const cfg = this.cfg()
    const client = await this.resolveClient()
    let events: AsyncIterable<any>
    try {
      events = await client.messages.create(
        {
          model: options.model,
          max_tokens: options.maxTokens ?? cfg.maxTokens ?? 32_768,
          ...(options.system === undefined ? {} : { system: options.system }),
          messages: mapMessages(options.messages),
          ...(mapTools(options.tools) === undefined ? {} : { tools: mapTools(options.tools) }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.stop === undefined || options.stop.length === 0
            ? {}
            : { stop_sequences: options.stop }),
          stream: true,
        },
        { ...(options.signal === undefined ? {} : { signal: options.signal }) },
      )
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Anthropic request aborted by caller', 'ABORTED', { cause: error })
      throw new LlmError('Anthropic Messages request failed', 'TRANSPORT', { cause: error })
    }
    try {
      yield* translateEvents(events)
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Anthropic request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('Anthropic stream failed', 'TRANSPORT', { cause: error })
    }
  }
}

export function apply(ctx: Context, config: AnthropicConfig): void {
  const adapter = new AnthropicAdapter(() => config)
  ctx.llm.registerAdapter(config.routes, adapter)
}
