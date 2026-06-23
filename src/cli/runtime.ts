/**
 * runtime.ts — shared single-agent runtime assembly.
 *
 * Extracted from runPrompt (src/cli/main.ts) so the single-agent CLI and the
 * ACP adapter (docs/30, docs/32) build the same auth + hooks + dispatcher +
 * tools + permission engine + engine selection from one place. Behavior is
 * identical to the prior inline assembly; the only structural change is that
 * engine construction is deferred to `makeEngine(sessionId)` so ACP can build
 * one engine per `session/new` (NativeEngine keys its prompt cache off the
 * sessionId). Session *resolution* (--resume) stays in the CLI — ACP supplies
 * its own session ids.
 *
 * See docs/32-acp-implementation-plan.md §3.
 */

import * as path from "node:path";
import * as os from "node:os";
import { filterToolsForFramework } from "../tools/framework-filter.js";
import { detectAuth } from "../auth/status.js";
import { AnthropicEnvAuth } from "../auth/anthropic-env-auth.js";
import { ToolDispatcher } from "../tools/dispatcher.js";
import { buildTier0Tools } from "../tools/tier0/index.js";
import { setSkillStore, createSkillBankStore } from "../memory/index.js";
import { PermissionEngine } from "../permissions/index.js";
import { NativeEngine } from "../engine/native.js";
import { HardenedNativeEngine } from "../engine/hardened-native.js";
import { ScriptedTestEngine } from "../engine/test-engine.js";
import { CodexFrameworkEngine } from "../engine/codex-framework.js";
import { CodexResponsesTransportProvider } from "../providers/codex-responses/index.js";
import { OpenAICodexAuth } from "../auth/openai-codex-oauth.js";
import { readCodexTokens } from "../auth/openai-codex-token-store.js";
import { DEFAULT_COMPACTION } from "../engine/compactor.js";
import { PluginRegistry } from "../plugins/registry.js";
import { ClaudeCodeSource } from "../plugins/claude-code-source.js";
import { PluginStateStore } from "../plugins/state.js";
import { SkillRegistry } from "../skills/registry.js";
import { ClaudeCodeSource as ClaudeCodeSkillSource } from "../skills/claude-code-source.js";
import { buildTier1Tools } from "../tools/tier1/index.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpStdioClient } from "../mcp/client.js";
import { buildMcpToolImpl } from "../mcp/bridge.js";
import { loadHooksConfig, countEvents, countMatchers } from "../hooks/config.js";
import { HookRuntime } from "../hooks/runtime.js";
import { loadAliases, resolveAlias } from "../providers/aliases.js";
import { resolveProvider } from "../providers/routing.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import type { CommonOpts } from "./argv.js";
import type { AgentEngine } from "../engine/index.js";
import type { AuthSource } from "../auth/index.js";
import type { ToolImpl } from "../tools/types.js";
import type { HooksConfigFile } from "../hooks/config.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";

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
  const scriptedMode = !!process.env.SWARM_HARNESS_TEST_SCRIPT;
  if (!scriptedMode) {
    if (opts.framework === "codex-native") {
      // codex-native uses ChatGPT (codex) credentials, not Anthropic auth.
      if (readCodexTokens() === null) {
        process.stderr.write(
          "error: not logged in to ChatGPT.\n" +
            "  Run `swarm-harness login --provider openai-codex`.\n",
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
        `[swarm-harness] hooks config error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const n = countMatchers(hooksConfig.config);
    if (n > 0 && hooksConfig.resolvedPath !== undefined) {
      process.stderr.write(
        `[swarm-harness] hooks loaded from ${hooksConfig.resolvedPath} (${n} matchers across ${countEvents(hooksConfig.config)} events)\n`,
      );
    }
  }
  const hookRuntime = new HookRuntime(hooksConfig.config);

  const dispatcher = new ToolDispatcher({ hooks: hookRuntime });
  for (const tool of buildTier0Tools()) {
    dispatcher.register(tool);
  }

  // Point the `skill_save` tool's store at a durable, skill-tree-backed store
  // (SQLite via node:sqlite — works under Node, Bun, and compiled binaries).
  // Gated by --skills (default on); falls back silently to the in-memory
  // default if unavailable (e.g. Node < 22.5 or skill-tree missing).
  if (opts.skills) {
    try {
      const skillsDbPath = path.join(
        os.homedir(),
        ".swarm-harness",
        "skills",
        "skills.db",
      );
      setSkillStore(await createSkillBankStore({ dbPath: skillsDbPath }));
    } catch (err) {
      process.stderr.write(
        `[swarm-harness] durable skill store unavailable, using in-memory: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  // 2a. Discover and register plugin tools (opt-in via --plugins, default on).
  const pluginTools: ToolImpl[] = [];
  const envPluginsDir = process.env.SWARM_HARNESS_PLUGINS_DIR;
  const swarmPluginsDir =
    envPluginsDir && envPluginsDir.length > 0
      ? envPluginsDir
      : path.join(os.homedir(), ".swarm-harness", "plugins");
  // One shared store across plugin discovery and the `/plugin` slash command.
  const pluginStateStore = new PluginStateStore(swarmPluginsDir);
  if (opts.plugins) {
    const pluginRegistry = new PluginRegistry(pluginStateStore);
    pluginRegistry.registerSource(
      new ClaudeCodeSource({ id: "swarm-harness", pluginsDir: swarmPluginsDir }),
    );
    pluginRegistry.registerSource(new ClaudeCodeSource());
    process.stderr.write("[swarm-harness] discovering plugins...\n");
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
        `[swarm-harness] plugin discovery error: ${err instanceof Error ? err.message : String(err)}\n`,
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
        `[swarm-harness] mcp config load error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      loaded = { configs: [] };
    }
    if (loaded.resolvedPath !== undefined) {
      process.stderr.write(`[swarm-harness] mcp config: ${loaded.resolvedPath}\n`);
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
            `[swarm-harness] mcp server '${cfg.name}' failed to connect: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`,
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
            `[swarm-harness] mcp server '${cfg.name}' listTools failed: ${err instanceof Error ? err.message : String(err)}\n`,
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

  // 3. Build permission engine.
  const permEngine = new PermissionEngine(opts.permissionMode);

  // 4. RunConfig auth source (the Anthropic SDK engine's auth).
  const auth = new AnthropicEnvAuth();

  // 5. Resolve model alias + plan the engine. Construction is deferred to
  //    makeEngine(sessionId); validation errors surface here as exit code 2.
  const aliases = await loadAliases();
  const rawModel = opts.model ?? DEFAULT_MODEL;
  let resolvedModelId = resolveAlias(rawModel, aliases);

  let makeEngine: MakeEngine;
  if (opts.framework === "codex-chatgpt") {
    makeEngine = async () => ({
      engine: new CodexFrameworkEngine({ cwd: process.cwd() }),
    });
  } else if (opts.framework === "codex-native") {
    // In-process ChatGPT-subscription path (docs/42). The backend's accepted
    // model set is plan-dependent and gpt-5.x only; default to gpt-5.5 unless
    // the user passed an explicit gpt* model (the CLI default is a Claude id).
    const codexModel = /^gpt/i.test(resolvedModelId) ? resolvedModelId : "gpt-5.5";
    // Reflect the effective model everywhere downstream — budget/cost pricing,
    // --dump-engine, RunConfig.model, and the system-prompt "Model" block — not
    // just the API call (the provider also overrides req.model internally).
    resolvedModelId = codexModel;
    makeEngine = async (sessionId: string) => {
      const auth = new OpenAICodexAuth();
      const provider = new CodexResponsesTransportProvider({
        modelId: codexModel,
        credentials: auth,
        sessionId,
        ...(opts.codexTransport !== undefined ? { transport: opts.codexTransport } : {}),
      });
      const engine = new HardenedNativeEngine({
        provider,
        sessionId,
        eagerToolDispatch: opts.eagerToolDispatch,
        midTurnCompaction: opts.midTurnCompaction,
        // Size compaction to the provider's real context window (~400k), not the
        // 10k DEFAULT_COMPACTION — otherwise we'd compact away the byte-stable
        // prefix that the ~96% prompt caching relies on (docs/42 §6.2).
        compactionConfig: {
          preserveRecentMessages: DEFAULT_COMPACTION.preserveRecentMessages,
          maxEstimatedTokens: Math.floor(provider.capabilities.maxContextTokens * 0.8),
        },
      });
      return { engine, providerId: provider.id };
    };
  } else if (scriptedMode) {
    makeEngine = async () => ({ engine: new ScriptedTestEngine() });
  } else {
    const resolved = resolveProvider(resolvedModelId);
    if (resolved.kind === "error") {
      process.stderr.write(`${resolved.message}\n`);
      return { kind: "exit", code: 2 };
    }
    if (opts.framework === "claude-agent-sdk") {
      if (resolved.kind !== "sdk") {
        process.stderr.write(
          `error: --framework claude-agent-sdk requires an Anthropic model; received ${resolvedModelId}.\n`,
        );
        return { kind: "exit", code: 2 };
      }
      const factory = resolved.engineFactory!;
      makeEngine = async () => ({ engine: factory() });
    } else if (opts.framework === "native" || opts.framework === "hardened-native") {
      if (resolved.kind !== "native") {
        process.stderr.write(
          `error: --framework ${opts.framework} does not support Claude models in M4a.\n` +
            "Use `--framework auto` (default) or `--framework claude-agent-sdk`.\n" +
            "Native-via-@ai-sdk/anthropic is scheduled for M4b.\n",
        );
        return { kind: "exit", code: 2 };
      }
      const providerFactory = resolved.providerFactory!;
      const providerModelId = resolved.modelId!;
      const useHardened = opts.framework === "hardened-native";
      makeEngine = async (sessionId: string) => {
        const providerAuth = resolved.authFactory
          ? await resolved.authFactory()
          : await buildAuthForProvider(providerModelId);
        const provider = await providerFactory(providerAuth, providerModelId);
        const engine = useHardened
          ? new HardenedNativeEngine({
              provider,
              sessionId,
              eagerToolDispatch: opts.eagerToolDispatch,
              midTurnCompaction: opts.midTurnCompaction,
            })
          : new NativeEngine({ provider, sessionId });
        return { engine, providerId: provider.id };
      };
    } else {
      // auto
      if (resolved.kind === "sdk") {
        const factory = resolved.engineFactory!;
        makeEngine = async () => ({ engine: factory() });
      } else {
        const providerFactory = resolved.providerFactory!;
        const providerModelId = resolved.modelId!;
        makeEngine = async (sessionId: string) => {
          const providerAuth = resolved.authFactory
          ? await resolved.authFactory()
          : await buildAuthForProvider(providerModelId);
          const provider = await providerFactory(providerAuth, providerModelId);
          return {
            engine: new NativeEngine({ provider, sessionId }),
            providerId: provider.id,
          };
        };
      }
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
