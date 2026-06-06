/**
 * Network policy engine (S2): domain-level allow/deny filtering with
 * SSRF protection. Enforces network access rules for all outbound
 * connections from sandboxed processes.
 *
 * Domain matching follows Codex conventions:
 *   "api.github.com"   — exact match only
 *   "*.example.com"    — subdomains only (not apex)
 *   "**.example.com"   — apex + all subdomains
 *   "*"                — allow-only wildcard (matches everything)
 *
 * Policy evaluation: deny always wins over allow.
 * If no allow entries exist, all requests are blocked.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as dns from "node:dns/promises";
import * as net from "node:net";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NetworkMode = "full" | "proxy-only" | "none";

export interface NetworkPolicyConfig {
  readonly mode: NetworkMode;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly blockPrivateAddresses: boolean;
}

export interface NetworkPolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// RFC 1918 / private address ranges
// ---------------------------------------------------------------------------

const PRIVATE_RANGES: readonly { prefix: number; mask: number; bits: number; label: string }[] = [
  { prefix: 0x0a000000, mask: 0xff000000, bits: 8, label: "10.0.0.0/8" },
  { prefix: 0xac100000, mask: 0xfff00000, bits: 12, label: "172.16.0.0/12" },
  { prefix: 0xc0a80000, mask: 0xffff0000, bits: 16, label: "192.168.0.0/16" },
  { prefix: 0x7f000000, mask: 0xff000000, bits: 8, label: "127.0.0.0/8" },
  { prefix: 0xa9fe0000, mask: 0xffff0000, bits: 16, label: "169.254.0.0/16" },
  { prefix: 0x00000000, mask: 0xff000000, bits: 8, label: "0.0.0.0/8" },
];

const PRIVATE_IPV6_PREFIXES: readonly string[] = [
  "::1",
  "fc",
  "fd",
  "fe80:",
  "::ffff:127.",
  "::ffff:10.",
  "::ffff:172.16.",
  "::ffff:172.17.",
  "::ffff:172.18.",
  "::ffff:172.19.",
  "::ffff:172.20.",
  "::ffff:172.21.",
  "::ffff:172.22.",
  "::ffff:172.23.",
  "::ffff:172.24.",
  "::ffff:172.25.",
  "::ffff:172.26.",
  "::ffff:172.27.",
  "::ffff:172.28.",
  "::ffff:172.29.",
  "::ffff:172.30.",
  "::ffff:172.31.",
  "::ffff:192.168.",
];

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

export function isPrivateIPv4(ip: string): boolean {
  const num = ipv4ToUint32(ip);
  if (num === null) return false;
  for (const range of PRIVATE_RANGES) {
    if (((num & range.mask) >>> 0) === range.prefix) return true;
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

export function domainMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();

  if (p === "*") return true;

  if (p.startsWith("**.")) {
    const base = p.slice(3);
    return h === base || h.endsWith("." + base);
  }

  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h !== base && h.endsWith("." + base);
  }

  return p === h;
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

export class NetworkPolicy {
  readonly mode: NetworkMode;
  private readonly allowPatterns: readonly string[];
  private readonly denyPatterns: readonly string[];
  private readonly blockPrivate: boolean;

  constructor(config: NetworkPolicyConfig) {
    this.mode = config.mode;
    this.allowPatterns = config.allow;
    this.denyPatterns = config.deny;
    this.blockPrivate = config.blockPrivateAddresses;
  }

  checkDomain(hostname: string): NetworkPolicyDecision {
    if (this.mode === "none") {
      return { allowed: false, reason: "network access disabled" };
    }

    for (const pattern of this.denyPatterns) {
      if (domainMatches(pattern, hostname)) {
        return { allowed: false, reason: `denied by pattern: ${pattern}` };
      }
    }

    if (this.allowPatterns.length === 0) {
      return { allowed: false, reason: "no allow rules configured" };
    }

    for (const pattern of this.allowPatterns) {
      if (domainMatches(pattern, hostname)) {
        return { allowed: true, reason: `allowed by pattern: ${pattern}` };
      }
    }

    return { allowed: false, reason: "not matched by any allow rule" };
  }

  checkIP(ip: string): NetworkPolicyDecision {
    if (this.mode === "none") {
      return { allowed: false, reason: "network access disabled" };
    }

    if (this.blockPrivate && isPrivateAddress(ip)) {
      return { allowed: false, reason: `blocked private/local address: ${ip}` };
    }

    return { allowed: true, reason: "IP address allowed" };
  }

  async checkHostname(hostname: string): Promise<NetworkPolicyDecision> {
    const domainDecision = this.checkDomain(hostname);
    if (!domainDecision.allowed) return domainDecision;

    if (!this.blockPrivate) return domainDecision;

    if (net.isIP(hostname)) {
      return this.checkIP(hostname);
    }

    let addresses: string[];
    try {
      const result = await dns.resolve4(hostname);
      addresses = result;
    } catch {
      try {
        const result = await dns.resolve6(hostname);
        addresses = result;
      } catch {
        return { allowed: false, reason: `DNS resolution failed for ${hostname}` };
      }
    }

    for (const addr of addresses) {
      if (isPrivateAddress(addr)) {
        return {
          allowed: false,
          reason: `SSRF blocked: ${hostname} resolves to private address ${addr}`,
        };
      }
    }

    return domainDecision;
  }

  summarize(): string | null {
    if (this.mode === "full" && this.allowPatterns.length === 1 && this.allowPatterns[0] === "*" && this.denyPatterns.length === 0) {
      return null;
    }
    const lines: string[] = [`Mode: ${this.mode}`];
    if (this.allowPatterns.length > 0) {
      lines.push(`Allow: ${this.allowPatterns.join(", ")}`);
    }
    if (this.denyPatterns.length > 0) {
      lines.push(`Deny: ${this.denyPatterns.join(", ")}`);
    }
    if (this.blockPrivate) {
      lines.push("Private/local addresses are blocked (SSRF protection).");
    }
    return lines.join("\n");
  }

  static fullAccess(): NetworkPolicy {
    return new NetworkPolicy({
      mode: "full",
      allow: ["*"],
      deny: [],
      blockPrivateAddresses: true,
    });
  }

  static noAccess(): NetworkPolicy {
    return new NetworkPolicy({
      mode: "none",
      allow: [],
      deny: [],
      blockPrivateAddresses: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Default policy (used when no config file exists)
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_CONFIG: NetworkPolicyConfig = {
  mode: "full",
  allow: ["*"],
  deny: [],
  blockPrivateAddresses: true,
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export interface LoadNetworkPolicyOptions {
  readonly cwd?: string;
  readonly homedir?: string;
  readonly envOverrides?: Record<string, string | undefined>;
}

export function loadNetworkPolicyConfig(
  opts: LoadNetworkPolicyOptions = {},
): NetworkPolicyConfig {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homedir ?? os.homedir();
  const env = opts.envOverrides ?? process.env;

  const candidates: string[] = [];
  const envDir = env.SWARM_HARNESS_CONFIG_DIR;
  if (envDir !== undefined && envDir.length > 0) {
    candidates.push(path.join(envDir, "network.json"));
  }
  candidates.push(path.join(cwd, ".swarm-harness", "network.json"));
  candidates.push(path.join(home, ".swarm-harness", "network.json"));

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return validateConfig(parsed);
    } catch {
      continue;
    }
  }

  return DEFAULT_POLICY_CONFIG;
}

function validateConfig(raw: unknown): NetworkPolicyConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_POLICY_CONFIG;
  }

  const obj = raw as Record<string, unknown>;

  const mode = (["full", "proxy-only", "none"] as const).includes(
    obj.mode as NetworkMode,
  )
    ? (obj.mode as NetworkMode)
    : "full";

  const allow = Array.isArray(obj.allow)
    ? obj.allow.filter((x): x is string => typeof x === "string")
    : ["*"];

  const deny = Array.isArray(obj.deny)
    ? obj.deny.filter((x): x is string => typeof x === "string")
    : [];

  const blockPrivateAddresses =
    typeof obj.blockPrivateAddresses === "boolean"
      ? obj.blockPrivateAddresses
      : true;

  return { mode, allow, deny, blockPrivateAddresses };
}

// ---------------------------------------------------------------------------
// Singleton (lazy-initialized)
// ---------------------------------------------------------------------------

let _policy: NetworkPolicy | undefined;

export function getNetworkPolicy(opts?: LoadNetworkPolicyOptions): NetworkPolicy {
  if (!_policy) {
    _policy = new NetworkPolicy(loadNetworkPolicyConfig(opts));
  }
  return _policy;
}

export function setNetworkPolicy(policy: NetworkPolicy): void {
  _policy = policy;
}

export function resetNetworkPolicy(): void {
  _policy = undefined;
}
