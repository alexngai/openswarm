/**
 * footer.tsx — two-line status footer replacing status.tsx.
 *
 * Line 1: [state-badge] model · permission-mode · session {id}   [tip]
 * Line 2: context: XX% (tokens/max) · cache: YY% · cost: $X.XX
 *
 * Inspired by Kimi Code's footer.ts with rotating tips.
 */

import { createMemo, createSignal, onMount, onCleanup } from "solid-js";
import type { ReplState, UsageStats } from "../repl/state.js";
import { ApiCostModel } from "../../core/cost-model.js";
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
  { text: "ctrl+r dump to scrollback", weight: 1 },
  { text: "ctrl+g edit in $EDITOR", weight: 1 },
  { text: "!cmd runs a shell command", weight: 1 },
];

function shortSession(id: string | undefined): string {
  if (id === undefined || id.length === 0) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Prices via MODEL_PRICING (the canonical table — docs/55 TE-19), including
// cache read/write traffic. Honest by design: an unpriced model shows "n/a"
// rather than a made-up rate. Exported for tests.
const COST_MODEL = new ApiCostModel();

export function formatCost(usage: UsageStats | undefined, model: string): string {
  if (usage === undefined) return "$0.00";
  const { usd } = COST_MODEL.cost({
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
  });
  if (usd === undefined) return "n/a";
  if (usd < 0.01) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

/**
 * Running cache-read share of the input side: read / (read + fresh input),
 * annotated with the last turn's cache_hit/cache_miss lane signal when the
 * engine path emits one (docs/55 TE-20). An attributed miss names the prefix
 * components that changed, e.g. "(miss: tools)" (TE-21). Empty until usage
 * flows.
 */
export function formatCache(usage: UsageStats | undefined): string {
  if (usage === undefined) return "";
  const denom = usage.cacheReadInputTokens + usage.inputTokens;
  if (denom === 0) return "";
  const pct = Math.round((usage.cacheReadInputTokens / denom) * 100);
  let marker = "";
  if (usage.lastTurnCache !== undefined) {
    const reasons =
      usage.lastTurnCache === "miss" &&
      usage.lastMissReasons !== undefined &&
      usage.lastMissReasons.length > 0
        ? `: ${usage.lastMissReasons.join("+")}`
        : "";
    marker = ` (${usage.lastTurnCache}${reasons})`;
  }
  return ` · cache: ${pct}%${marker}`;
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
    const planTag = props.state.planMode ? " [plan]" : "";
    const base = `[${props.state.name}] ${props.model} · ${props.state.permissionMode}${planTag} · session ${shortSession(props.state.sessionId)}`;
    const tip = weightedTips[tipIndex()] ?? "";
    return `${base}  ${tip}`;
  });

  const line2 = createMemo(
    // Reading state.usageStats makes this memo recompute at every turn
    // boundary (usage-update), which also refreshes the polled token count.
    () => `context: ${contextPct()}% (${formatTokens(tokens())}/${formatTokens(contextWindow())})${formatCache(props.state.usageStats)} · cost: ${formatCost(props.state.usageStats, props.model)}`,
  );

  const combined = createMemo(() => `${line1()}\n${line2()}`);

  return <text fg={color()}>{combined()}</text>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
