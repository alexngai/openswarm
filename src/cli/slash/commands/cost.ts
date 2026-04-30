import type { SlashCommand } from "../index.js";

// Placeholder per-million-token pricing. Phase 5 wires the real getter on
// the engine and may promote these to a central constant file.
// Values in USD / 1M tokens. Tuned to approximate public list prices.
interface Pricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const PRICING: Record<string, Pricing> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

function pickPricing(model: string): Pricing {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return PRICING.opus!;
  if (lower.includes("haiku")) return PRICING.haiku!;
  return PRICING.sonnet!;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export const costCommand: SlashCommand = {
  name: "cost",
  description: "Show cumulative token usage and estimated cost",
  execute(ctx) {
    const u = ctx.getUsage();
    const model = ctx.getModel();
    const p = pickPricing(model);
    const cacheRead = u.cacheReadInputTokens ?? 0;
    const cacheWrite = u.cacheWriteInputTokens ?? 0;
    const cost =
      (u.inputTokens / 1_000_000) * p.input +
      (u.outputTokens / 1_000_000) * p.output +
      (cacheRead / 1_000_000) * p.cacheRead +
      (cacheWrite / 1_000_000) * p.cacheWrite;
    const hitRatioLine =
      cacheRead + u.inputTokens > 0
        ? `\n  cache hit ratio: ${Math.round((cacheRead / (cacheRead + u.inputTokens)) * 100)}%  (cacheRead / (cacheRead + input))`
        : "";

    return {
      kind: "message",
      text:
        `cumulative usage (model: ${model}):\n` +
        `  input: ${u.inputTokens}\n` +
        `  output: ${u.outputTokens}\n` +
        `  cache_read: ${cacheRead}\n` +
        `  cache_write: ${cacheWrite}\n` +
        `  estimated cost: ${fmtUsd(cost)}` +
        hitRatioLine,
    };
  },
};
