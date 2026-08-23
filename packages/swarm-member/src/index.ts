/**
 * `openswarm-swarm-member` — member-side swarm capabilities, mounted inside
 * a subprocess member harness (docs/01 Phase 4).
 *
 * Registers the model-facing `swarm_send_message` tool, which reaches the
 * lead's durable mailbox over the loopback JSON-RPC socket the lead exposes
 * (`OPENSWARM_SWARM_URL`), authenticated by the per-member spawn token
 * (`OPENSWARM_SWARM_TOKEN`). Without those env variables the plugin is a
 * silent no-op, so one member composition serves both messaging and
 * non-messaging teams.
 */
import { connect } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'openswarm-swarm-member'
export const inject = ['tools']

async function sendToLead(
  url: string,
  params: Record<string, unknown>,
): Promise<{ messageId: string }> {
  const [host, portText] = url.split(':')
  const socket = connect({ host, port: Number(portText) })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    return (await transport.request('swarm/send', params)) as { messageId: string }
  } finally {
    transport.close()
    socket.destroy()
  }
}

export function apply(ctx: Context): void {
  const url = process.env['OPENSWARM_SWARM_URL']
  const token = process.env['OPENSWARM_SWARM_TOKEN']
  if (url === undefined || url.length === 0 || token === undefined) return
  ctx.tools.register(
    defineTool({
      name: 'swarm_send_message',
      description:
        'Send a message to a teammate by name. wakeup delivery starts a turn for them; quiet delivery lands as context the next time they run.',
      parameters: {
        to: { type: 'string', required: true, description: 'Teammate name from your briefing.' },
        message: { type: 'string', required: true, description: 'The message text.' },
        delivery: {
          type: 'string',
          enum: ['wakeup', 'quiet'],
          description: 'Delivery mode; defaults to wakeup.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: { messageId: { type: 'string', required: true } },
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [
          { type: 'text', text: `sent (id ${value.messageId})` },
        ],
      },
      async execute(args: any) {
        return sendToLead(url, {
          token,
          to: args.to,
          message: args.message,
          ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
        })
      },
    } as never),
  )
}
