export const DEFAULT_MAX_DEPTH = 3;

export function resolveMaxDepth(): number {
  const raw = process.env.SWARM_CODER_MAX_DEPTH;
  if (!raw) return DEFAULT_MAX_DEPTH;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return DEFAULT_MAX_DEPTH;
  return n;
}
