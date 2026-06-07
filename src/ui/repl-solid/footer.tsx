/**
 * footer.tsx — two-line status footer replacing status.tsx.
 *
 * Line 1: [state-badge] model · permission-mode · session {id}   [tip]
 * Line 2: context: XX% (tokens/max) · cost: $X.XX
 *
 * Inspired by Kimi Code's footer.ts with rotating tips.
 */

import { createMemo, createSignal, onMount, onCleanup } from "solid-js";
import type { ReplState } from "../repl/state.js";
import { stateColor, theme } from "./theme.js";

export type TokenGetter = () => number;

export interface FooterProps {
  readonly state: ReplState;
  readonly model: string;
  readonly getTokens: TokenGetter;
  /** Model context window size (for context % calculation). Default: 200000. */
  readonly contextWindow?: number;
}

const TIPS = [
  { text: "ctrl+o expand tools", weight: 2 },
  { text: "ctrl+s steer mid-turn", weight: 1 },
  { text: "/help for commands", weight: 1 },
  { text: "shift+enter for newline", weight: 1 },
  { text: "/cost for token usage", weight: 1 },
  { text: "/compact to save context", weight: 1 },
];

function shortSession(id: string | undefined): string {
  if (id === undefined || id.length === 0) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatCost(tokens: number, model: string): string {
  const m = model.toLowerCase();
  let inputRate = 3; // default sonnet-ish
  if (m.includes("opus")) inputRate = 15;
  else if (m.includes("haiku")) inputRate = 0.8;
  const cost = (tokens / 1_000_000) * inputRate;
  if (cost < 0.01) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

export function Footer(props: FooterProps) {
  const contextWindow = () => props.contextWindow ?? 200_000;
  const color = createMemo(() => stateColor[props.state.name]);

  // Tip rotation — cycle every 10 seconds.
  const weightedTips: string[] = [];
  for (const tip of TIPS) {
    for (let i = 0; i < tip.weight; i++) {
      weightedTips.push(tip.text);
    }
  }
  const [tipIndex, setTipIndex] = createSignal(0);
  onMount(() => {
    const interval = setInterval(() => {
      setTipIndex((i) => (i + 1) % weightedTips.length);
    }, 10_000);
    onCleanup(() => clearInterval(interval));
  });

  const tokens = () => props.getTokens();
  const contextPct = () => {
    const t = tokens();
    const w = contextWindow();
    if (w === 0) return 0;
    return Math.round((t / w) * 100);
  };

  const line1 = createMemo(() => {
    const base = `[${props.state.name}] ${props.model} · ${props.state.permissionMode} · session ${shortSession(props.state.sessionId)}`;
    const tip = weightedTips[tipIndex()] ?? "";
    return `${base}  ${tip}`;
  });

  const line2 = createMemo(
    () => `context: ${contextPct()}% (${formatTokens(tokens())}/${formatTokens(contextWindow())}) · cost: ${formatCost(tokens(), props.model)}`,
  );

  const combined = createMemo(() => `${line1()}\n${line2()}`);

  return <text fg={color()}>{combined()}</text>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
