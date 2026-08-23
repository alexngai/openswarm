import type { SlashCommand } from "../index.js";
import { ApiCostModel } from "../../../core/cost-model.js";

// Prices via MODEL_PRICING through ApiCostModel — the canonical table shared
// with budget enforcement and the eval cost axis (docs/55 TE-19), including
// cache read/write traffic (docs/53 TE-17). Honest by design: an unpriced
// model reports "n/a" instead of a guessed rate, except when nothing was
// spent (zero usage is $0 on any model).
const COST_MODEL = new ApiCostModel();

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show cumulative token usage and estimated cost",
  execute(ctx) {
    const u = ctx.getUsage();
    const model = ctx.getModel();
    const cacheRead = u.cacheReadInputTokens ?? 0;
    const cacheWrite = u.cacheWriteInputTokens ?? 0;
    const totalTokens = u.inputTokens + u.outputTokens + cacheRead + cacheWrite;
    const { usd } = COST_MODEL.cost({
      model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWrite,
    });
    const costLine =
      usd !== undefined
        ? `estimated cost: ${fmtUsd(usd)}`
        : totalTokens === 0
          ? `estimated cost: ${fmtUsd(0)}`
          : `estimated cost: n/a — "${model}" not in MODEL_PRICING (src/core/budget.ts)`;
    const hitRatioLine =
      cacheRead + u.inputTokens > 0
        ? `\n  cache hit ratio: ${Math.round((cacheRead / (cacheRead + u.inputTokens)) * 100)}%  (cacheRead / (cacheRead + input))`
        : "";
    const turns = ctx.state.usageStats?.turns ?? 0;
    const ctxPerTurnLine =
      turns > 0
        ? `\n  ctx/turn: ${Math.round((u.inputTokens + cacheRead + cacheWrite) / turns)} tokens (${turns} turns)`
        : "";

    return {
      kind: "message",
      text:
        `cumulative usage (model: ${model}):\n` +
        `  input: ${u.inputTokens}\n` +
        `  output: ${u.outputTokens}\n` +
        `  cache_read: ${cacheRead}\n` +
        `  cache_write: ${cacheWrite}\n` +
        `  ${costLine}` +
        hitRatioLine +
        ctxPerTurnLine,
    };
  },
};
