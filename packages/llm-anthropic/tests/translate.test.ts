/**
 * Pure translation tests: scripted Anthropic stream events → StreamChunk
 * contract, and dsh message history → Anthropic params. No SDK, no network.
 */
import { expect, it } from 'vitest'
import { mapMessages, mapTools, translateEvents } from '../src/index'

async function collect(events: unknown[]): Promise<any[]> {
  const out: any[] = []
  for await (const chunk of translateEvents(events)) out.push(chunk)
  return out
}

it('translates a text turn: usage before finish, nothing after', async () => {
  const chunks = await collect([
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    { type: 'message_stop' },
  ])
  expect(chunks.map((c) => c.type)).toEqual([
    'block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish',
  ])
  expect(chunks.at(-2).usage).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 2 })
  expect(chunks.at(-1).reason).toEqual({ kind: 'stop' })
  const end = chunks.find((c) => c.type === 'block-end')
  expect(end.block).toEqual({ type: 'text', text: 'Hello' })
})

it('translates a tool-use turn: raw JSON argument deltas, tool-calls finish', async () => {
  const chunks = await collect([
    { type: 'message_start', message: { usage: { input_tokens: 4 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ])
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  expect(deltas[0]).toMatchObject({ id: 'toolu_1', name: 'bash', argumentsDelta: '' })
  expect(deltas.slice(1).map((d) => d.argumentsDelta).join('')).toBe('{"command":"ls"}')
  const end = chunks.find((c) => c.type === 'block-end')
  expect(end.block).toEqual({ type: 'tool-call', id: 'toolu_1', name: 'bash', arguments: '{"command":"ls"}' })
  expect(chunks.at(-1).reason).toEqual({ kind: 'tool-calls' })
})

it('a stream ending without message_stop throws TRANSPORT', async () => {
  await expect(collect([{ type: 'message_start', message: {} }])).rejects.toMatchObject({ code: 'TRANSPORT' })
})

it('maps dsh history: system stays out, tool round-trips, same roles merge', () => {
  const messages: any[] = [
    { role: 'user', content: [{ type: 'text', text: 'fix it' }], id: 'm1', source: { kind: 'user' } },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'running' },
        { type: 'tool-call', id: 'toolu_9', name: 'bash', arguments: '{"command":"pytest"}' },
      ],
      id: 'm2', source: { kind: 'user' },
    },
    {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'toolu_9', content: [{ type: 'text', text: '1 passed' }] }],
      id: 'm3', source: { kind: 'user' },
    },
    { role: 'user', content: [{ type: 'text', text: 'now finish' }], id: 'm4', source: { kind: 'user' } },
  ]
  const mapped = mapMessages(messages)
  expect(mapped).toHaveLength(3) // the two trailing user messages merged
  expect(mapped[1]!.content[1]).toEqual({
    type: 'tool_use', id: 'toolu_9', name: 'bash', input: { command: 'pytest' },
  })
  expect(mapped[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9', content: '1 passed' })
  expect(mapped[2]!.content[1]).toEqual({ type: 'text', text: 'now finish' })

  expect(mapTools([{ name: 't', description: 'd', parameters: { type: 'object' } }])).toEqual([
    { name: 't', description: 'd', input_schema: { type: 'object' } },
  ])
})
