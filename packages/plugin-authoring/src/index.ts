/**
 * F3 — agent-authored, hot-loaded plugins with a containment hierarchy
 * (docs/01).
 *
 * `swarm_author_plugin` lets an agent write a Cordis plugin module and mount
 * it live. Cordis makes this safe by construction: a plugin is mounted with
 * `ctx.plugin()` and its registrations (tools, listeners, effects) unwind on
 * `fiber.dispose()`, so a mounted plugin is fully reversible.
 *
 * Blast-radius policy (the novel part):
 *  - `self` scope mounts into the AGENT'S OWN scoped context (`agent.ctx`) —
 *    freely allowed. Worst case is a broken child; disposing the agent
 *    unwinds it.
 *  - `lead` scope mounts into the shared root context, changing the harness
 *    for everyone — allowed only when an approval gate authorizes it. The
 *    default gate puts the question to the human through dsh's own approval
 *    seam (`ctx.approval`), which every UI surface renders and which fails
 *    closed: no answerer, a `never` session policy, or a withdrawn question
 *    all deny. Without that service composed the mount is refused outright,
 *    so a headless run never silently grants shared scope.
 *
 * The module source is evaluated as an ES module data: URL, exposing exactly
 * one capability to the plugin — `defineTool` — so an authored plugin's
 * natural move is to register a new model-facing tool. No filesystem, no
 * network, no process access is handed in (the sandbox/permission layer still
 * governs anything the plugin reaches for on its own).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only, for the `ctx.approval` Context augmentation. The service itself
// is a dsh-base row, so it is present in every profile we ship.
import type {} from '@deepseek-ai/dsh-user-approval'

export type PluginScope = 'self' | 'lead'

/** One pending `lead`-scope mount put to a gate. */
export interface LeadMountRequest {
  /** The authoring agent, for routing the question to the surface that owns it. */
  agent: Agent | undefined
  agentId: string
  name: string
  source: string
  /** The tool call being decided, so a UI can attach the prompt to it. */
  callId?: string
  /** Withdraws the question when the tool call is aborted. */
  signal?: AbortSignal
}

/** Decides whether a `lead`-scope mount is allowed. `self` is always allowed. */
export type ApprovalGate = (request: LeadMountRequest) => boolean | Promise<boolean>

export interface PluginAuthoringConfig {
  /** Root context that `lead`-scope plugins mount into (defaults to the mount ctx). */
  leadContext?: Context
  /** Gate for `lead`-scope mounts. Default: ask the human via `ctx.approval`. */
  approveLeadMount?: ApprovalGate
  /** Cap on live agent-authored plugins per scope owner. Default 16. */
  maxPlugins?: number
}

/**
 * The default gate: one fail-closed question on dsh's approval seam. Absent
 * the service (a bare hand-built context) there is nobody to ask, so the
 * mount is denied — `allowed-once` is the seam's only grant.
 */
export function userApprovalGate(ctx: Context): ApprovalGate {
  return async (request) => {
    const approval = ctx.get('approval')
    if (approval === undefined || request.agent === undefined) return false
    try {
      const outcome = await approval.request({
        agent: request.agent,
        toolName: 'swarm_author_plugin',
        ...(request.callId === undefined ? {} : { callId: request.callId as never }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        reason: `mount the agent-authored plugin "${request.name}" into the SHARED harness, changing tools for the whole team until it is disposed`,
      })
      return outcome === 'allowed-once'
    } catch {
      // The seam rejects an ask with no open turn, and an audit append can
      // fail. Either way nobody granted anything: deny.
      return false
    }
  }
}

export const name = 'openswarm-plugin-authoring'
export const inject = ['tools']

/** Compile one authored module, injecting the allowed capability surface. */
async function loadPluginModule(source: string): Promise<any> {
  // The module receives its capabilities from a globalThis handoff keyed by a
  // nonce, avoiding bare-specifier imports that a data: URL cannot resolve.
  const key = `__swarm_authoring_${Math.abs(hashString(source))}`
  ;(globalThis as any)[key] = { defineTool }
  try {
    const preamble = `const { defineTool } = globalThis[${JSON.stringify(key)}];\n`
    const url = `data:text/javascript,${encodeURIComponent(preamble + source)}`
    return await import(/* @vite-ignore */ url)
  } finally {
    delete (globalThis as any)[key]
  }
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

interface MountedPlugin {
  name: string
  scope: PluginScope
  dispose: () => void
}

export function apply(ctx: Context, config: PluginAuthoringConfig = {}): void {
  const mounted: MountedPlugin[] = []
  const maxPlugins = config.maxPlugins ?? 16
  const approve = config.approveLeadMount ?? userApprovalGate(ctx)

  const disposeAll = () => {
    for (const p of mounted.splice(0)) p.dispose()
  }
  ctx.effect(() => disposeAll)

  ctx.tools.register(
    defineTool({
      name: 'swarm_author_plugin',
      description:
        'Author a Cordis plugin module and hot-load it. scope "self" mounts it into your own harness (freely allowed); scope "lead" mounts it into the shared harness for the whole team and requires approval. The module gets a defineTool() capability and typically registers a new tool. Registrations unwind cleanly when your session ends.',
      parameters: {
        name: { type: 'string', required: true, description: 'A short name for the plugin.' },
        source: {
          type: 'string',
          required: true,
          description:
            'ES module source. It receives `defineTool` in scope and exports `apply(ctx)`; call ctx.tools.register(defineTool({...})) to add a tool.',
        },
        scope: {
          type: 'string',
          enum: ['self', 'lead'],
          description: 'self (your harness, default) or lead (shared harness, needs approval).',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            mounted: { type: 'boolean', required: true },
            scope: { type: 'string', required: true },
            reason: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [
          { type: 'text', text: value.mounted ? `mounted "${value.scope}"` : `refused: ${value.reason}` },
        ],
      },
      async execute(args: any, exec: any) {
        const scope: PluginScope = args.scope === 'lead' ? 'lead' : 'self'
        const agentId = String(exec.agent?.id ?? 'unknown')

        if (mounted.filter((p) => p.scope === scope).length >= maxPlugins) {
          return { mounted: false, scope, reason: `plugin limit (${maxPlugins}) reached for ${scope} scope` }
        }

        if (scope === 'lead') {
          const ok = await approve({
            agent: exec.agent,
            agentId,
            name: String(args.name),
            source: String(args.source),
            ...(exec.callId === undefined ? {} : { callId: String(exec.callId) }),
            ...(exec.signal === undefined ? {} : { signal: exec.signal as AbortSignal }),
          })
          if (!ok) return { mounted: false, scope, reason: 'lead-scope mount not approved' }
        }

        let plugin: any
        try {
          plugin = await loadPluginModule(String(args.source))
        } catch (error) {
          return { mounted: false, scope, reason: `module failed to load: ${errText(error)}` }
        }
        const applyFn = plugin.apply ?? plugin.default
        if (typeof applyFn !== 'function') {
          return { mounted: false, scope, reason: 'module exports no apply(ctx) function' }
        }

        // self → the authoring agent's own scoped context; lead → the shared root.
        const target: Context =
          scope === 'lead' ? (config.leadContext ?? ctx) : (exec.agent?.ctx ?? ctx)
        let fiber: any
        try {
          fiber = target.plugin({ name: String(args.name), apply: applyFn })
          await fiber.await?.()
        } catch (error) {
          await fiber?.dispose?.().catch(() => undefined)
          return { mounted: false, scope, reason: `plugin apply failed: ${errText(error)}` }
        }
        mounted.push({ name: String(args.name), scope, dispose: () => void fiber.dispose?.() })
        return { mounted: true, scope }
      },
    } as never),
  )
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
