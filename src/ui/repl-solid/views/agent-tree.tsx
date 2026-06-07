/**
 * agent-tree.tsx — Hierarchical agent display for multi-agent runs.
 *
 * Phase 5: shows spawned agents in a parent→children tree with phase-color
 * badges. Supports j/k navigation with a selected index.
 */

import { createMemo, For } from "solid-js";
import type { AgentState } from "../../repl/state.js";
import { theme } from "../theme.js";

export interface AgentTreeProps {
  readonly agents: Readonly<Record<string, AgentState>>;
  readonly selectedIndex?: number;
}

const phaseColor: Record<string, string> = {
  spawning: theme.muted,
  running: theme.accent,
  idle: theme.text,
  done: theme.bulletSuccess,
  failed: theme.bulletError,
};

const phaseBadge: Record<string, string> = {
  spawning: "○",
  running: "●",
  idle: "◌",
  done: "✓",
  failed: "✗",
};

interface TreeNode {
  readonly agent: AgentState;
  readonly depth: number;
  readonly isLast: boolean;
}

function buildTree(agents: Readonly<Record<string, AgentState>>): TreeNode[] {
  const all = Object.values(agents);
  const childrenOf = new Map<string | undefined, AgentState[]>();

  for (const agent of all) {
    const parentKey = agent.parentId ?? "__root__";
    const list = childrenOf.get(parentKey) ?? [];
    list.push(agent);
    childrenOf.set(parentKey, list);
  }

  const roots = childrenOf.get("__root__") ?? all.filter((a) => !a.parentId);
  const result: TreeNode[] = [];

  function walk(nodes: AgentState[], depth: number): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      result.push({ agent: node, depth, isLast: i === nodes.length - 1 });
      const children = childrenOf.get(node.id) ?? [];
      if (children.length > 0) walk(children, depth + 1);
    }
  }

  walk(roots, 0);
  return result;
}

export function AgentTree(props: AgentTreeProps) {
  const tree = createMemo(() => buildTree(props.agents));

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.accent} bold>Agents</text>
      <For each={tree()}>
        {(node, idx) => {
          const prefix = node.depth === 0
            ? ""
            : "  ".repeat(node.depth - 1) + (node.isLast ? "└─ " : "├─ ");
          const badge = phaseBadge[node.agent.phase] ?? "?";
          const color = phaseColor[node.agent.phase] ?? theme.text;
          const selected = () => idx() === (props.selectedIndex ?? -1);
          const metrics = node.agent.toolCount > 0
            ? ` · ${node.agent.toolCount} tools · ${formatTokens(node.agent.tokenUsage)} tokens`
            : "";

          return (
            <text
              fg={selected() ? theme.accent : color}
              bold={selected()}
            >
              {prefix}{badge} {node.agent.name} [{node.agent.role}]{metrics}
            </text>
          );
        }}
      </For>
    </box>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
