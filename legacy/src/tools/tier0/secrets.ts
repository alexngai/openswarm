/**
 * Secrets detection (S6): scan strings for potential secrets before they
 * are exposed in tool output or written to files.
 *
 * Detects: API keys (AWS, GCP, GitHub, Slack, Stripe, etc.), private keys,
 * JWTs, generic high-entropy tokens, passwords in URIs.
 *
 * Returns a list of findings with type, redacted preview, and byte offset.
 * The caller decides whether to warn, redact, or block.
 */

export interface SecretFinding {
  readonly type: string;
  readonly match: string;
  readonly offset: number;
  readonly redacted: string;
}

interface PatternDef {
  readonly type: string;
  readonly pattern: RegExp;
}

const PATTERNS: readonly PatternDef[] = [
  {
    type: "aws-access-key",
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
  },
  {
    type: "aws-secret-key",
    pattern: /\b([A-Za-z0-9/+=]{40})\b/g,
  },
  {
    type: "github-token",
    pattern: /\b(gh[ps]_[A-Za-z0-9_]{36,255})\b/g,
  },
  {
    type: "github-fine-grained-token",
    pattern: /\b(github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    type: "slack-token",
    pattern: /\b(xox[bpas]-[0-9A-Za-z-]{10,250})\b/g,
  },
  {
    type: "stripe-key",
    pattern: /\b(sk_live_[0-9a-zA-Z]{24,99})\b/g,
  },
  {
    type: "stripe-restricted-key",
    pattern: /\b(rk_live_[0-9a-zA-Z]{24,99})\b/g,
  },
  {
    type: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    type: "gcp-service-account",
    pattern: /"type"\s*:\s*"service_account"/g,
  },
  {
    type: "generic-api-key",
    pattern: /\b(?:api[_-]?key|apikey|api[_-]?secret|api[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-/.+=]{20,})/gi,
  },
  {
    type: "password-in-url",
    pattern: /:\/\/[^:@\s]+:([^@\s]{8,})@/g,
  },
  {
    type: "openai-key",
    pattern: /\b(sk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,})\b/g,
  },
  {
    type: "anthropic-key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    type: "npm-token",
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
  },
  {
    type: "pypi-token",
    pattern: /\b(pypi-[A-Za-z0-9_-]{50,})\b/g,
  },
  {
    type: "heroku-api-key",
    pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
  },
];

const HIGH_ENTROPY_MIN_LEN = 30;
const HIGH_ENTROPY_THRESHOLD = 4.5;

function redact(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "***" + s.slice(-4);
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Scan `text` for potential secrets. Returns all findings.
 * Does NOT modify `text` — caller decides how to handle.
 */
export function detectSecrets(text: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const { type, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const matched = m[1] ?? m[0];
      const key = `${type}:${m.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Skip the generic aws-secret-key pattern unless it has high entropy
      if (type === "aws-secret-key" && shannonEntropy(matched) < HIGH_ENTROPY_THRESHOLD) {
        continue;
      }

      // Skip UUID matches for heroku-api-key if they look like common UUIDs in non-secret context
      if (type === "heroku-api-key") {
        const surrounding = text.slice(Math.max(0, m.index - 20), m.index + matched.length + 20);
        if (!/(?:api|key|token|secret|heroku|password|auth)/i.test(surrounding)) {
          continue;
        }
      }

      findings.push({
        type,
        match: matched,
        offset: m.index,
        redacted: redact(matched),
      });
    }
  }

  return findings;
}

/**
 * Quick check: does `text` contain any likely secrets?
 * Cheaper than `detectSecrets()` when you only need a boolean.
 */
export function containsSecrets(text: string): boolean {
  for (const { type, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(text);
    if (m !== null) {
      const matched = m[1] ?? m[0];
      if (type === "aws-secret-key" && shannonEntropy(matched) < HIGH_ENTROPY_THRESHOLD) {
        continue;
      }
      if (type === "heroku-api-key") {
        const surrounding = text.slice(Math.max(0, m.index - 20), m.index + matched.length + 20);
        if (!/(?:api|key|token|secret|heroku|password|auth)/i.test(surrounding)) {
          continue;
        }
      }
      return true;
    }
  }
  return false;
}

/**
 * Redact all detected secrets in `text`, replacing each match with its
 * redacted form. Returns the redacted string + list of what was redacted.
 */
export function redactSecrets(text: string): {
  redacted: string;
  findings: readonly SecretFinding[];
} {
  const findings = detectSecrets(text);
  if (findings.length === 0) return { redacted: text, findings };

  // Sort by offset descending so replacements don't shift later offsets.
  const sorted = [...findings].sort((a, b) => b.offset - a.offset);
  let result = text;
  for (const f of sorted) {
    result =
      result.slice(0, f.offset) +
      `[REDACTED:${f.type}]` +
      result.slice(f.offset + f.match.length);
  }
  return { redacted: result, findings };
}

/**
 * Check if a string has high Shannon entropy (potential base64/hex secret).
 * Exported for testing.
 */
export { shannonEntropy, HIGH_ENTROPY_THRESHOLD, HIGH_ENTROPY_MIN_LEN };
