// Probe 3 — SDK drive + method-extension seam.
// Drives the stock child runtime over stdio JSON-RPC, then calls an
// unknown swarm/* method to verify the wire rejects it as a typed JSON-RPC
// error (the fallback path our wrapping app-server composes on).
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { HarnessClient, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-client'

const here = dirname(fileURLToPath(import.meta.url))
const mock = await startMockLlmServer({ apiKey: 'mock-key', sequence: ['success'], successText: 'hi' })
const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`

const client = new HarnessClient({
  command: process.execPath,
  args: [join(here, 'node_modules', '.bin', 'dsh-jsonrpc-agent'), join(here, 'child.cordis.yml')],
  cwd: here,
  env: { ...process.env, DEEPSEEK_BASE_URL: base, DEEPSEEK_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' },
})
try {
  await client.start()
  await client.initialize({ cwd: here, provider: 'deepseek-official', model: 'mock-model' })
  console.log('initialize: ok')
  try {
    await client.request('swarm/ping', {})
    console.log('PROBE 3 UNEXPECTED: unknown method was accepted')
    process.exit(1)
  } catch (e) {
    if (e instanceof JsonRpcResponseError) {
      console.log(`unknown method rejected cleanly: code=${e.code} message=${e.message}`)
      console.log('PROBE 3 PASS: wire-typed rejection; extension = wrap exported HarnessSdkJsonRpcServer')
    } else throw e
  }
} finally {
  await client.close()
  await mock.close()
}
