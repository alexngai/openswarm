/**
 * OpenSwarm — TypeScript coding agent built on Anthropic's Claude Agent SDK.
 *
 * This file is the library entry point. Most users interact via the CLI
 * (`node dist/cli.js`); library consumers can import the types and classes
 * below to build custom harnesses.
 *
 * See docs/03-interfaces.md for abstraction boundaries and docs/08-m0-plan.md
 * for M0 scope.
 */

import { createRequire } from "node:module";

// Version source of truth is package.json. The bun-compiled binary can't read
// package.json from its embedded fs, so build-binary.ts injects the version as
// the `__OPENSWARM_VERSION__` compile-time constant; under node we read it from
// package.json. (`typeof` on an undeclared name is safe — never throws.)
declare const __OPENSWARM_VERSION__: string | undefined;

function resolveVersion(): string {
  if (typeof __OPENSWARM_VERSION__ !== "undefined") return __OPENSWARM_VERSION__;
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = resolveVersion();

// Core types
export type {
  PermissionMode,
  RequiredPermission,
  Usage,
  StopReason,
  AgentId,
  SessionId,
  ToolSpec,
  JsonSchema,
  ProviderError,
  NormalizedEvent,
} from "./core/types.js";

// Engine
export type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
  PermissionGate,
  PermissionDecision,
  SessionSnapshot,
} from "./engine/index.js";
export { ClaudeAgentSdkEngine } from "./engine/claude-agent-sdk.js";

// Tools
export type {
  ToolImpl,
  ToolExecutionContext,
  ToolResult,
} from "./tools/types.js";
export { ToolDispatcher } from "./tools/dispatcher.js";
export { buildTier0Tools } from "./tools/tier0/index.js";

// Permissions
export { PermissionEngine } from "./permissions/index.js";

// Session
export { SessionStore } from "./session/store.js";

// Auth (minimal M0 surface)
export type { AuthSource, AuthKind } from "./auth/index.js";
export type { AuthStatus } from "./auth/status.js";
export { detectAuth } from "./auth/status.js";
export { AnthropicEnvAuth } from "./auth/anthropic-env-auth.js";
