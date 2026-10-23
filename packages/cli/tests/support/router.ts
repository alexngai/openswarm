/**
 * A mock LLM that answers by conversation state, not a FIFO script: a
 * member's first turn gets a bash call running `command`, the turn after the
 * tool result gets `closing` as its text. Concurrent subprocess members then
 * each take exactly two requests, whatever the interleaving. Points
 * `OPENSWARM_LLM_BASE_URL` at itself.
 */
import { createServer, request } from 'node:http'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

export async function startMockRouter(
  command: string,
  closing = '1. implement the assignment',
): Promise<{ baseURL: string; requests: () => number; close: () => Promise<void> }> {
  const common = { apiKey: 'mock-key', repeatLast: true, chunkDelayMs: 0 }
  const tool = await startMockLlmServer({
    ...common,
    sequence: ['tool_call_success'],
    toolName: 'bash',
    toolArguments: JSON.stringify({ command }),
  })
  const done = await startMockLlmServer({ ...common, sequence: ['success'], successText: closing })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const last = JSON.parse(body.toString()).messages?.at(-1)
      const target = new URL(last?.role === 'tool' ? done.baseURL : tool.baseURL)
      const upstream = request(
        { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        },
      )
      upstream.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  process.env['OPENSWARM_LLM_BASE_URL'] = `http://127.0.0.1:${port}/v1`
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => tool.requests.length + done.requests.length,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await tool.close()
      await done.close()
    },
  }
}
