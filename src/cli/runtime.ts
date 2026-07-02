/**
 * runtime.ts — shared single-agent runtime assembly.
 *
 * Extracted from runPrompt (src/cli/main.ts) so the single-agent CLI and the
 * ACP adapter (docs/archive/30, docs/archive/32) build the same auth + hooks + dispatcher +
 * tools + permission engine + engine selection from one place. Behavior is
 * identical to the prior inline assembly; the only structural change is that
 * engine construction is deferred to `makeEngine(sessionId)` so ACP can build
 * one engine per `session/new` (NativeEngine keys its prompt cache off the
 * sessionId). Session *resolution* (--resume) stays in the CLI — ACP supplies
 * its own session ids.
 *
 * See docs/archive/32-acp-implementation-plan.md §3.
 */

import * as path from "node:path";
import * as os from "node:os";
import { filterToolsForFramework } from "../tools/framework-filter.js";
import { detectAuth } from "../auth/status.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { NativeEngine } from "../engine/native.js";
import { HardenedNativeEngine } from "../engine/hardened-native.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
import { CodexFrameworkEngine } from "../engine/codex-framework.js";
import { CodexResponsesTransportProvider } from "../providers/codex-responses/index.js";
import { OpenAICodexAuth } from "../auth/openai-codex-oauth.js";
import { readCodexTokens } from "../auth/openai-codex-token-store.js";
import { DEFAULT_COMPACTION, type CompactionConfig } from "../engine/compactor.js";
import type { RemoteCompactionConfig } from "../engine/compact-remote.js";
import type { Provider } from "../providers/index.js";
import { PluginRegistry } from "../plugins/registry.js";
import { ClaudeCodeSource } from "../plugins/claude-code-source.js";
import { PluginStateStore } from "../plugins/state.js";
import { SkillRegistry } from "../skills/registry.js";
import { ClaudeCodeSource as ClaudeCodeSkillSource } from "../skills/claude-code-source.js";
import { buildTier1Tools } from "../tools/tier1/index.js";
import { setToolRegistry } from "../tools/tier1/tool_search.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpStdioClient } from "../mcp/client.js";
import { buildMcpToolImpl } from "../mcp/bridge.js";
import { loadHooksConfig, countEvents, countMatchers } from "../hooks/config.js";
import { HookRuntime } from "../hooks/runtime.js";
import { loadAliases, resolveAlias } from "../providers/aliases.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import { planEngine } from "./select-engine.js";
import type { CommonOpts } from "./argv.js";
import type { AgentEngine } from "../engine/index.js";
import type { AuthSource } from "../auth/index.js";
import type { ToolImpl } from "../tools/types.js";
import type { HooksConfigFile } from "../hooks/config.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Build the default compaction config for a native/hardened engine.
 *
 * Remote (LLM-driven, structured) compaction is ON by default: it produces far
 * higher-fidelity summaries than the mechanical fallback, and the remote path
 * already fails safe to mechanical on any error/timeout/validation miss. It
 * reuses the session's own provider + model (a cheaper summarization model can
 * be pinned via OPENSWARM_COMPACTION_MODEL). Set OPENSWARM_REMOTE_COMPACTION to
 * 0/false/off/no to force the mechanical compactor.
 *
 * The trigger thresholds (preserveRecentMessages / maxEstimatedTokens) are
 * unchanged from DEFAULT_COMPACTION — only the summarization method differs.
 */
export function defaultCompactionConfig(
  provider: Provider,
  modelId: string,
): CompactionConfig {
  const flag = (process.env.OPENSWARM_REMOTE_COMPACTION ?? "").toLowerCase();
  const remoteDisabled = ["0", "false", "off", "no"].includes(flag);
  if (remoteDisabled) return DEFAULT_COMPACTION;

  const config: RemoteCompactionConfig = {
    preserveRecentMessages: DEFAULT_COMPACTION.preserveRecentMessages,
    maxEstimatedTokens: DEFAULT_COMPACTION.maxEstimatedTokens,
    provider,
    model: process.env.OPENSWARM_COMPACTION_MODEL ?? modelId,
  };
  return config;
}

/**
 * Build the auth source for a non-Anthropic provider model. Mirrors the prior
 * inline helper in main.ts. Anthropic models use the SDK engine's own auth.
 */
export async function buildAuthForProvider(modelId: string): Promise<AuthSource> {
  if (/^(gpt|o[134])/i.test(modelId)) return new OpenAIEnvAuth();
  throw new Error(`no auth source wired for model ${modelId}`);
}

/**
 * Lazily constructs an engine for a given session id. Returns the engine plus
 * the provider id (native path only — used by `--dump-engine`).
 */
export type MakeEngine = (
  sessionId: string,
) => Promise<{ engine: AgentEngine; providerId?: string }>;

export interface AgentRuntime {
  readonly dispatcher: ToolDispatcher;
  /** Tier0 + tier1 + plugin + MCP tools, filtered for the active framework. */
  readonly tools: readonly ToolImpl[];
  readonly permEngine: PermissionEngine;
  /** RunConfig.auth — the Anthropic SDK engine's auth source. */
  readonly auth: AuthSource;
  readonly hooksConfig: HooksConfigFile;
  /** Open MCP clients — callers own shutdown (the CLI also registers an exit hook). */
  readonly mcpClients: readonly McpStdioClient[];
  /** Shared plugin state store (also backs the `/plugin` slash command). */
  readonly pluginStateStore: PluginStateStore;
  readonly resolvedModelId: string;
  readonly makeEngine: MakeEngine;
}

export type BuildRuntimeResult =
  | { readonly kind: "runtime"; readonly runtime: AgentRuntime }
  | { readonly kind: "exit"; readonly code: number };

/**
 * Assemble the shared agent runtime. Returns `{ kind: "exit", code }` for the
 * paths that previously short-circuited runPrompt with a process exit code
 * (auth failure → 1, `--dump-tools` → 0, engine/framework mismatch → 2).
 */
export async function buildAgentRuntime(
  opts: CommonOpts,
): Promise<BuildRuntimeResult> {
  // 1. Validate auth. Scripted-test mode skips the check (the scripted engine
  // never calls the API).
  const scriptedMode = !!process.env.OPENSWARM_TEST_SCRIPT;
  if (!scriptedMode) {
    if (opts.framework === "codex-native") {
      // codex-native uses ChatGPT (codex) credentials, not Anthropic auth.
      if (readCodexTokens() === null) {
        process.stderr.write(
          "error: not logged in to ChatGPT.\n" +
            "  Run `openswarm login --provider openai-codex`.\n",
        );
        return { kind: "exit", code: 1 };
      }
    } else {
      const authStatus = await detectAuth();
      if (authStatus.state === "none") {
        process.stderr.write(
          "error: no auth found.\n" +
            "  Run `claude auth login` or set ANTHROPIC_API_KEY.\n",
        );
        return { kind: "exit", code: 1 };
      }
    }
  }

  // 2. Load hook config (before the dispatcher so we can thread the HookRuntime
  //    into its constructor — covers Tier 2 tools per rev-2 Major M6).
  let hooksConfig: Awaited<ReturnType<typeof loadHooksConfig>> = { config: {} };
  if (opts.hooks) {
    try {
      hooksConfig = await loadHooksConfig({ cwd: process.cwd() });
    } catch (err) {
      process.stderr.write(
        `[openswarm] hooks config error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const n = countMatchers(hooksConfig.config);
    if (n > 0 && hooksConfig.resolvedPath !== undefined) {
      process.stderr.write(
        `[openswarm] hooks loaded from ${hooksConfig.resolvedPath} (${n} matchers across ${countEvents(hooksConfig.config)} events)\n`,
      );
    }
  }
  const hookRuntime = new HookRuntime(hooksConfig.config);

  const dispatcher = new ToolDispatcher({ hooks: hookRuntime });
  for (const tool of buildTier0Tools()) {
    dispatcher.register(tool);
  }


  // 2a. Discover and register plugin tools (opt-in via --plugins, default on).
  const pluginTools: ToolImpl[] = [];
  const envPluginsDir = process.env.OPENSWARM_PLUGINS_DIR;
  const swarmPluginsDir =
    envPluginsDir && envPluginsDir.length > 0
      ? envPluginsDir
      : path.join(os.homedir(), ".openswarm", "plugins");
  // One shared store across plugin discovery and the `/plugin` slash command.
  const pluginStateStore = new PluginStateStore(swarmPluginsDir);
  if (opts.plugins) {
    const pluginRegistry = new PluginRegistry(pluginStateStore);
    pluginRegistry.registerSource(
      new ClaudeCodeSource({ id: "openswarm", pluginsDir: swarmPluginsDir }),
    );
    pluginRegistry.registerSource(new ClaudeCodeSource());
    process.stderr.write("[openswarm] discovering plugins...\n");
    try {
      const discovered = await pluginRegistry.buildPluginTools();
      for (const tool of discovered) {
        try {
          dispatcher.register(tool);
          pluginTools.push(tool);
        } catch {
          // Name collision with higher-priority tool — skip silently.
        }
      }
    } catch (err) {
      process.stderr.write(
        `[openswarm] plugin discovery error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // 2b. Build skill registry and Tier 1 tools (opt-in via --skills, default on).
  let skillRegistry: SkillRegistry | undefined;
  const tier1Tools: ToolImpl[] = [];
  if (opts.skills) {
    skillRegistry = new SkillRegistry();
    skillRegistry.registerSource(new ClaudeCodeSkillSource());
  }
  for (const tool of buildTier1Tools({ skillRegistry })) {
    try {
      dispatcher.register(tool);
      tier1Tools.push(tool);
    } catch {
      // Name collision — skip silently.
    }
  }

  // 2c. Discover and register MCP tools (opt-in via --mcp, default on).
  // Fail-soft: a server that hangs / errors within its connect budget is
  // logged to stderr and its tools are skipped.
  const mcpTools: ToolImpl[] = [];
  const mcpClients: McpStdioClient[] = [];
  if (opts.mcp) {
    let loaded: Awaited<ReturnType<typeof loadMcpConfig>>;
    try {
      loaded = await loadMcpConfig();
    } catch (err) {
      process.stderr.write(
        `[openswarm] mcp config load error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      loaded = { configs: [] };
    }
    if (loaded.resolvedPath !== undefined) {
      process.stderr.write(`[openswarm] mcp config: ${loaded.resolvedPath}\n`);
    }
    if (loaded.configs.length > 0) {
      const results = await Promise.allSettled(
        loaded.configs.map(async (cfg) => {
          const client = new McpStdioClient(cfg);
          await client.connect();
          return client;
        }),
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        const cfg = loaded.configs[i]!;
        if (r.status === "rejected") {
          process.stderr.write(
            `[openswarm] mcp server '${cfg.name}' failed to connect: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`,
          );
          continue;
        }
        const client = r.value;
        mcpClients.push(client);
        try {
          const descriptors = await client.listTools();
          for (const descriptor of descriptors) {
            const toolImpl = buildMcpToolImpl(client, descriptor);
            try {
              dispatcher.register(toolImpl);
              mcpTools.push(toolImpl);
            } catch {
              // Name collision — keep first-registered copy, skip silently.
            }
          }
        } catch (err) {
          process.stderr.write(
            `[openswarm] mcp server '${cfg.name}' listTools failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  // Cleanup hook: best-effort close on process exit (synchronous handler).
  if (mcpClients.length > 0) {
    process.on("exit", () => {
      for (const c of mcpClients) {
        void c.close().catch(() => {});
      }
    });
  }

  // 2d'. Populate the tool_search registry from the fully assembled surface
  // (tier0 + tier1 + plugins + MCP) so dynamic discovery reflects exactly
  // what the dispatcher will execute.
  setToolRegistry(dispatcher.list());

  // 2d. --dump-tools: print registered tools as JSON and exit 0.
  if (opts.dumpTools) {
    const dumped = dispatcher.list().map((spec) => ({
      name: spec.name,
      description: spec.description,
      requiredPermission: spec.requiredPermission,
    }));
    process.stdout.write(JSON.stringify(dumped) + "\n");
    for (const c of mcpClients) {
      try {
        await c.close();
      } catch {
        // swallow — best effort
      }
    }
    return { kind: "exit", code: 0 };
  }

  // 3. Build permission engine. Plan mode narrows the effective mode to
  //    read-only regardless of the user's requested ceiling (headless / ACP
  //    enforce this here; the REPL additionally tracks it as a mutable local).
  const effectivePermissionMode = opts.plan ? "read-only" : opts.permissionMode;
  const permEngine = new PermissionEngine(effectivePermissionMode);

  // 4. RunConfig auth source (the Anthropic SDK engine's auth).
  const auth = new AnthropicEnvAuth();

  // 5. Resolve model alias + plan the engine. Construction is deferred to
  //    makeEngine(sessionId); validation errors surface here as exit code 2.
  const aliases = await loadAliases();
  const rawModel = opts.model ?? DEFAULT_MODEL;
  let resolvedModelId = resolveAlias(rawModel, aliases);

  const planResult = planEngine({
    framework: opts.framework,
    resolvedModelId,
    scripted: scriptedMode,
  });
  if (!planResult.ok) {
    process.stderr.write(`${planResult.message}\n`);
    return { kind: "exit", code: 2 };
  }
  // Reflect the effective model everywhere downstream — budget/cost pricing,
  // --dump-engine, RunConfig.model, and the system-prompt "Model" block. Only
  // codex-native rewrites it (Claude id → gpt-5.x); every other path is a no-op.
  resolvedModelId = planResult.effectiveModelId;
  const plan = planResult.plan;

  let makeEngine: MakeEngine;
  switch (plan.kind) {
    case "scripted":
      makeEngine = async () => ({ engine: new ScriptedTestEngine() });
      break;
    case "codex-chatgpt":
      makeEngine = async () => ({
        engine: new CodexFrameworkEngine({ cwd: process.cwd() }),
      });
      break;
    case "codex-native": {
      // In-process ChatGPT-subscription path (docs/42).
      const codexModel = plan.codexModelId;
      makeEngine = async (sessionId: string) => {
        const codexAuth = new OpenAICodexAuth();
        const provider = new CodexResponsesTransportProvider({
          modelId: codexModel,
          credentials: codexAuth,
          sessionId,
          ...(opts.codexTransport !== undefined ? { transport: opts.codexTransport } : {}),
        });
        const engine = new HardenedNativeEngine({
          provider,
          sessionId,
          eagerToolDispatch: opts.eagerToolDispatch,
          midTurnCompaction: opts.midTurnCompaction,
          // Size compaction to the provider's real context window (~400k), not
          // the 10k DEFAULT_COMPACTION — otherwise we'd compact away the
          // byte-stable prefix that the ~96% prompt caching relies on
          // (docs/42 §6.2).
          compactionConfig: {
            preserveRecentMessages: DEFAULT_COMPACTION.preserveRecentMessages,
            maxEstimatedTokens: Math.floor(provider.capabilities.maxContextTokens * 0.8),
          },
        });
        return { engine, providerId: provider.id };
      };
      break;
    }
    case "claude-sdk": {
      const factory = plan.resolved.engineFactory!;
      makeEngine = async () => ({ engine: factory() });
      break;
    }
    case "native": {
      const providerFactory = plan.resolved.providerFactory!;
      const providerModelId = plan.resolved.modelId!;
      const authFactory = plan.resolved.authFactory;
      const useHardened = plan.hardened;
      makeEngine = async (sessionId: string) => {
        const providerAuth = authFactory
          ? await authFactory()
          : await buildAuthForProvider(providerModelId);
        const provider = await providerFactory(providerAuth, providerModelId);
        const compactionConfig = defaultCompactionConfig(provider, providerModelId);
        const engine = useHardened
          ? new HardenedNativeEngine({
              provider,
              sessionId,
              eagerToolDispatch: opts.eagerToolDispatch,
              midTurnCompaction: opts.midTurnCompaction,
              compactionConfig,
            })
          : new NativeEngine({ provider, sessionId, compactionConfig });
        return { engine, providerId: provider.id };
      };
      break;
    }
    default: {
      const _exhaustive: never = plan;
      throw new Error(`unreachable engine plan: ${String(_exhaustive)}`);
    }
  }

  // 6. Assemble the engine-visible tool set (filtered for the framework).
  const tools = filterToolsForFramework(
    [...Array.from(buildTier0Tools()), ...tier1Tools, ...pluginTools, ...mcpTools],
    opts.framework,
  );

  return {
    kind: "runtime",
    runtime: {
      dispatcher,
      tools,
      permEngine,
      auth,
      hooksConfig: hooksConfig.config,
      mcpClients,
      pluginStateStore,
      resolvedModelId,
      makeEngine,
    },
  };
}
