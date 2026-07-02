/**
 * Fetch ChatGPT (codex) plan usage / rate-limit windows.
 *
 * Hits `backend-api/wham/usage` and parses the primary + secondary rate-limit
 * windows and plan. Ported from openclaw `src/infra/provider-usage.fetch.codex.ts`.
 * Injectable fetch → unit-testable.
 */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEKLY_RESET_GAP_SECONDS = 3 * 24 * 60 * 60;

export interface CodexUsageWindow {
  readonly label: string;
  readonly usedPercent: number;
  readonly resetAt?: number; // epoch ms
}

export interface CodexUsageSnapshot {
  readonly plan?: string;
  readonly windows: readonly CodexUsageWindow[];
}

interface RawWindow {
  limit_window_seconds?: number;
  used_percent?: number;
  reset_at?: number;
}
interface RawUsage {
  rate_limit?: { primary_window?: RawWindow; secondary_window?: RawWindow };
  plan_type?: string;
  credits?: { balance?: number | string | null };
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function secondaryLabel(windowHours: number, secondaryResetAt?: number, primaryResetAt?: number): string {
  if (windowHours >= 168) return "Week";
  if (windowHours < 24) return `${windowHours}h`;
  // Codex sometimes reports a 24h secondary window while exposing a weekly reset
  // cadence — prefer cadence in that case.
  if (
    typeof secondaryResetAt === "number" &&
    typeof primaryResetAt === "number" &&
    secondaryResetAt - primaryResetAt >= WEEKLY_RESET_GAP_SECONDS
  ) {
    return "Week";
  }
  return "Day";
}

export async function fetchCodexUsage(
  token: string,
  accountId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CodexUsageSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      originator: "openswarm",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
  });
  if (!res.ok) throw new Error(`usage request failed: ${res.status}`);
  const data = (await res.json()) as RawUsage;

  const windows: CodexUsageWindow[] = [];
  const pw = data.rate_limit?.primary_window;
  if (pw) {
    const h = Math.round((pw.limit_window_seconds ?? 10800) / 3600);
    windows.push({
      label: `${h}h`,
      usedPercent: clampPercent(pw.used_percent ?? 0),
      ...(pw.reset_at ? { resetAt: pw.reset_at * 1000 } : {}),
    });
  }
  const sw = data.rate_limit?.secondary_window;
  if (sw) {
    const h = Math.round((sw.limit_window_seconds ?? 86400) / 3600);
    windows.push({
      label: secondaryLabel(h, sw.reset_at, pw?.reset_at),
      usedPercent: clampPercent(sw.used_percent ?? 0),
      ...(sw.reset_at ? { resetAt: sw.reset_at * 1000 } : {}),
    });
  }

  let plan = data.plan_type;
  const balance = data.credits?.balance;
  if (balance !== undefined && balance !== null) {
    const n = typeof balance === "number" ? balance : Number.parseFloat(String(balance));
    if (Number.isFinite(n)) plan = plan ? `${plan} ($${n.toFixed(2)})` : `$${n.toFixed(2)}`;
  }
  return { ...(plan ? { plan } : {}), windows };
}

/** One-line summary for the doctor output. */
export function formatCodexUsage(s: CodexUsageSnapshot): string {
  const parts = s.windows.map((w) => `${w.label} ${w.usedPercent}%`);
  const windows = parts.length > 0 ? parts.join(", ") : "no rate-limit windows reported";
  return s.plan ? `${s.plan} — ${windows}` : windows;
}
