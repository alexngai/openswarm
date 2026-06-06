/**
 * Context fragment system — modeled on Codex core/src/context/ (29 types).
 *
 * Provides composable, typed context fragments that are injected into the
 * system prompt dynamically. Each fragment is independently generated based
 * on session state, then composed by ContextBuilder into a single extensions
 * string for buildSystemPrompt().
 */

import { getExecPolicy } from "../tools/tier0/exec-policy.js";
import { getNetworkPolicy } from "../tools/tier0/network-policy.js";
import type { PermissionMode } from "../core/types.js";

// ---------------------------------------------------------------------------
// Fragment interface
// ---------------------------------------------------------------------------

export interface ContextFragment {
  /** Unique identifier for this fragment type. */
  readonly id: string;
  /** Display priority — lower numbers appear earlier in the prompt. */
  readonly priority: number;
  /** Generate the fragment text. Return null/empty to skip. */
  generate(state: ContextState): string | null;
}

export interface ContextState {
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  readonly model: string;
  readonly sessionId?: string;
  readonly turnCount?: number;
  readonly approvedCommands?: readonly string[];
  readonly customInstructions?: string;
  readonly agentRole?: string;
  readonly enabledTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Built-in fragments
// ---------------------------------------------------------------------------

export const environmentFragment: ContextFragment = {
  id: "environment",
  priority: 10,
  generate(state) {
    const lines: string[] = [
      "## Environment",
      `- Working directory: ${state.cwd}`,
      `- Platform: ${process.platform}`,
      `- Node.js: ${process.version}`,
    ];
    if (state.sessionId) {
      lines.push(`- Session: ${state.sessionId}`);
    }
    if (state.turnCount !== undefined) {
      lines.push(`- Turn: ${state.turnCount}`);
    }
    return lines.join("\n");
  },
};

export const permissionsFragment: ContextFragment = {
  id: "permissions",
  priority: 20,
  generate(state) {
    const mode = state.permissionMode;
    const lines = ["## Permissions"];

    switch (mode) {
      case "read-only":
        lines.push(
          "You are in **read-only** mode. You may read files and run non-destructive commands.",
          "You MUST NOT write files, modify the filesystem, or run commands with side effects.",
        );
        break;
      case "workspace-write":
        lines.push(
          "You are in **workspace-write** mode. You may read and write files within the project.",
          "You MUST NOT run destructive system commands or modify files outside the workspace.",
        );
        break;
      case "danger-full-access":
        lines.push(
          "You are in **full-access** mode. You have unrestricted permissions.",
          "Exercise extreme caution with destructive operations.",
        );
        break;
      default:
        lines.push(`Permission mode: ${mode}`);
    }

    return lines.join("\n");
  },
};

export const approvedCommandsFragment: ContextFragment = {
  id: "approved-commands",
  priority: 30,
  generate(state) {
    if (!state.approvedCommands || state.approvedCommands.length === 0) {
      return null;
    }
    const lines = [
      "## Pre-Approved Commands",
      "The following command prefixes have been approved and will not require confirmation:",
    ];
    for (const cmd of state.approvedCommands) {
      lines.push(`- \`${cmd}\``);
    }
    return lines.join("\n");
  },
};

export const networkRulesFragment: ContextFragment = {
  id: "network-rules",
  priority: 40,
  generate() {
    try {
      const policy = getNetworkPolicy();
      const summary = policy.summarize();
      if (!summary) return null;
      return `## Network Policy\n${summary}`;
    } catch {
      return null;
    }
  },
};

export const execPolicyFragment: ContextFragment = {
  id: "exec-policy",
  priority: 50,
  generate() {
    try {
      const policy = getExecPolicy();
      if (policy.ruleCount === 0) return null;
      return `## Execution Policy\n${policy.ruleCount} command rules are active. Commands matching "forbidden" rules will be blocked. Commands matching "allow" rules will auto-approve. Other commands will prompt for confirmation.`;
    } catch {
      return null;
    }
  },
};

export const userInstructionsFragment: ContextFragment = {
  id: "user-instructions",
  priority: 60,
  generate(state) {
    if (!state.customInstructions) return null;
    return `## User Instructions\n${state.customInstructions}`;
  },
};

export const modelContextFragment: ContextFragment = {
  id: "model-context",
  priority: 70,
  generate(state) {
    return `## Model\nYou are running as \`${state.model}\`.`;
  },
};

export const toolInventoryFragment: ContextFragment = {
  id: "tool-inventory",
  priority: 80,
  generate(state) {
    if (!state.enabledTools || state.enabledTools.length === 0) return null;
    return `## Available Tools\n${state.enabledTools.length} tools are available: ${state.enabledTools.join(", ")}.`;
  },
};

export const agentRoleFragment: ContextFragment = {
  id: "agent-role",
  priority: 90,
  generate(state) {
    if (!state.agentRole) return null;
    return `## Agent Role\nYou are operating as a **${state.agentRole}** agent.`;
  },
};

// ---------------------------------------------------------------------------
// Fragment registry
// ---------------------------------------------------------------------------

const DEFAULT_FRAGMENTS: ContextFragment[] = [
  environmentFragment,
  permissionsFragment,
  approvedCommandsFragment,
  networkRulesFragment,
  execPolicyFragment,
  userInstructionsFragment,
  modelContextFragment,
  toolInventoryFragment,
  agentRoleFragment,
];

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

export class ContextBuilder {
  private fragments: ContextFragment[];

  constructor(fragments?: ContextFragment[]) {
    this.fragments = fragments ? [...fragments] : [...DEFAULT_FRAGMENTS];
  }

  static withDefaults(): ContextBuilder {
    return new ContextBuilder();
  }

  static empty(): ContextBuilder {
    return new ContextBuilder([]);
  }

  register(fragment: ContextFragment): this {
    const idx = this.fragments.findIndex((f) => f.id === fragment.id);
    if (idx !== -1) {
      this.fragments[idx] = fragment;
    } else {
      this.fragments.push(fragment);
    }
    return this;
  }

  unregister(id: string): this {
    this.fragments = this.fragments.filter((f) => f.id !== id);
    return this;
  }

  has(id: string): boolean {
    return this.fragments.some((f) => f.id === id);
  }

  get fragmentCount(): number {
    return this.fragments.length;
  }

  build(state: ContextState): string {
    const sorted = [...this.fragments].sort((a, b) => a.priority - b.priority);
    const parts: string[] = [];

    for (const fragment of sorted) {
      const text = fragment.generate(state);
      if (text !== null && text.length > 0) {
        parts.push(text);
      }
    }

    return parts.join("\n\n");
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let contextBuilder: ContextBuilder | null = null;

export function getContextBuilder(): ContextBuilder {
  if (contextBuilder === null) {
    contextBuilder = ContextBuilder.withDefaults();
  }
  return contextBuilder;
}

export function setContextBuilder(builder: ContextBuilder): void {
  contextBuilder = builder;
}

export function resetContextBuilder(): void {
  contextBuilder = null;
}
