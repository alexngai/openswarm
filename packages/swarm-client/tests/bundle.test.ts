/**
 * The built Swarm tab bundle, loaded the way dsh's web shell loads it (docs/05
 * A9): executing the script only registers a factory with
 * `window.__ModuleLoader__`; the factory gets a `require` that serves the
 * host's shared modules and nothing else; `apply` gets the client context.
 * Requires `npm run build`; skips without the bundle.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

const bundle = fileURLToPath(new URL('../dist/client.js', import.meta.url))
const SHARED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

it.skipIf(!existsSync(bundle))('registers the Swarm tab, requiring only shared modules', async () => {
  const loaded: { id: string; factory: (require: (spec: string) => unknown) => any }[] = []
  new Function('window', readFileSync(bundle, 'utf8'))({ __ModuleLoader__: { load: (r: any) => loaded.push(r) } })
  expect(loaded.map((r) => r.id)).toEqual(['openswarm-swarm-client'])

  const required: string[] = []
  const exports = loaded[0]!.factory((spec) => {
    if (!SHARED.includes(spec)) throw new Error(`not a shared module: ${spec}`)
    required.push(spec)
    return {}
  })
  // React is the host's, not bundled.
  expect(required).toEqual(expect.arrayContaining(['react', 'react/jsx-runtime']))
  expect(exports.inject).toEqual(['slots', 'connection'])

  const registered: [any, unknown][] = []
  const call = vi.fn(async (..._args: unknown[]): Promise<any> => ({ ok: true, value: { runs: [] } }))
  exports.apply({
    slots: {
      inject: (name: string, register: () => unknown) => (expect(name).toBe('conversation.view'), register()),
      register: (options: any, component: unknown) => registered.push([options, component]),
    },
    connection: { rpc: { call } },
  })
  expect(registered).toHaveLength(1)
  const [options, component] = registered[0]!
  expect(options).toMatchObject({ name: 'conversation.view', id: 'swarm', label: 'Swarm' })
  expect(typeof component).toBe('function')

  // The injected helper calls the web carrier on dsh's /api gateway...
  const rpc = options.inject('session-1').call
  expect(await rpc('runs')).toEqual({ runs: [] })
  expect(call).toHaveBeenCalledWith('/api', 'swarm/runs', { args: {} }, undefined)
  // ...and turns a refusal into a thrown error carrying the protocol message.
  call.mockResolvedValueOnce({ ok: false, error: { code: 'NOT_FOUND', message: 'NOT_FOUND: unknown run "run-x"' } })
  await expect(rpc('view', { runId: 'run-x' })).rejects.toThrow('NOT_FOUND: unknown run "run-x"')
  expect(call).toHaveBeenLastCalledWith('/api', 'swarm/view', { args: { runId: 'run-x' } }, undefined)
})
