/**
 * Live peer-interaction E2E (docs/01 F1): TWO continuable peers on a real
 * model, where one AGENT DECIDES to message the other via swarm_send_message
 * and the recipient reads and acts on it. Everything before this ran keyless
 * with the mock scripting the tool call; here a live gpt-5.5 must choose to
 * call the tool, address the right teammate, and the woken peer must use the
 * delivered content.
 *
 *   source ~/.zshrc && OPENSWARM_LIVE=1 npx vitest run \
 *     packages/swarm/tests/peer-messaging-live.test.ts
 */
import { afterEach, expect, it } from 'vitest'
import {
  askPeer,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
  type PeerHandle,
} from '../src/index'
import * as OpenAiChat from '../../llm-openai/src/index'
import { bootHarness, type TestHarness } from './boot'

const MODEL = process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5'
const live =
  process.env['OPENSWARM_LIVE'] === '1' &&
  process.env['AZURE_API_BASE'] !== undefined &&
  process.env['AZURE_API_KEY'] !== undefined
const azureBase = () => `${(process.env['AZURE_API_BASE'] ?? '').replace(/\/+$/, '')}/openai/v1`

function azurePlugin() {
  return {
    module: OpenAiChat,
    config: {
      routes: ['openai'],
      baseURL: azureBase(),
      apiKeyEnv: 'AZURE_API_KEY',
      models: [{ id: MODEL, contextWindow: 200_000 }],
    },
    provider: 'openai',
    model: MODEL,
  }
}

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it.skipIf(!live)(
  'a live agent decides to message a teammate, who reads and acts on it',
  async () => {
    h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' }, undefined, azurePlugin())
    const ctx = (h as any).ctx
    suppressSettlementTurns(h.lead.agent)
    const roster = new Map<string, PeerHandle>()
    const mailbox = h.swarm.mailbox(h.lead.agent, roster)
    registerSwarmMessaging(ctx, roster, mailbox)

    const alice = await spawnPeer(ctx, { name: 'alice' }, {
      parent: h.lead.agent,
      provider: 'spawn',
      briefing:
        'You are alice, a member of a two-person agent team. Your teammate is named bob. ' +
        'You can talk to bob with the swarm_send_message tool (to: "bob"). Acknowledge briefly.',
    })
    const bob = await spawnPeer(ctx, { name: 'bob' }, {
      parent: h.lead.agent,
      provider: 'spawn',
      briefing:
        'You are bob, a member of a two-person agent team. Your teammate is named alice. ' +
        'Messages from alice will arrive as user turns. Acknowledge briefly.',
    })
    roster.set('alice', alice)
    roster.set('bob', bob)

    // Alice DECIDES to use the tool — nothing scripts the call.
    const aliceResult = await askPeer(
      ctx,
      h.lead.agent,
      alice,
      'Send bob a message telling him the mission codeword is FALCON. Use the swarm_send_message tool to do it, then confirm you sent it.',
      { mailbox },
    )
    expect(aliceResult.stopReason).toBe('completed')

    // The mailbox recorded a real delivery from alice → bob.
    const queued = h.lead.agent.session.events.filter((e: any) => e.type === 'swarm/message/queued')
    expect(queued.length, 'alice never sent a message').toBeGreaterThanOrEqual(1)
    const msg = (queued.at(-1) as any).data.message
    expect(msg.from).toBe('alice')
    expect(msg.to).toBe('bob')
    expect(msg.text.toUpperCase()).toContain('FALCON')

    // Give bob's wakeup turn a moment to settle, then ask what he received.
    await new Promise((r) => setTimeout(r, 500))
    const bobResult = await askPeer(
      ctx,
      h.lead.agent,
      bob,
      'What is the mission codeword your teammate alice sent you? Reply with just the single word.',
      { mailbox },
    )
    expect(bobResult.stopReason).toBe('completed')
    // Bob genuinely received and used the peer message.
    expect(bobResult.text.toUpperCase()).toContain('FALCON')
  },
  180_000,
)
