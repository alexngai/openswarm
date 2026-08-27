import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  domainMatches,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateAddress,
  NetworkPolicy,
  loadNetworkPolicyConfig,
  resetNetworkPolicy,
  getNetworkPolicy,
  setNetworkPolicy,
  type NetworkPolicyConfig,
} from "./network-policy.js";

afterEach(() => {
  resetNetworkPolicy();
});

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

describe("domainMatches", () => {
  it("matches exact domain", () => {
    expect(domainMatches("api.github.com", "api.github.com")).toBe(true);
    expect(domainMatches("api.github.com", "github.com")).toBe(false);
    expect(domainMatches("api.github.com", "other.github.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(domainMatches("API.GitHub.COM", "api.github.com")).toBe(true);
    expect(domainMatches("api.github.com", "API.GITHUB.COM")).toBe(true);
  });

  it("matches wildcard * (everything)", () => {
    expect(domainMatches("*", "anything.example.com")).toBe(true);
    expect(domainMatches("*", "localhost")).toBe(true);
  });

  it("*.example.com matches subdomains only, not apex", () => {
    expect(domainMatches("*.example.com", "sub.example.com")).toBe(true);
    expect(domainMatches("*.example.com", "deep.sub.example.com")).toBe(true);
    expect(domainMatches("*.example.com", "example.com")).toBe(false);
  });

  it("**.example.com matches apex + subdomains", () => {
    expect(domainMatches("**.example.com", "example.com")).toBe(true);
    expect(domainMatches("**.example.com", "sub.example.com")).toBe(true);
    expect(domainMatches("**.example.com", "deep.sub.example.com")).toBe(true);
  });

  it("does not match unrelated domains", () => {
    expect(domainMatches("*.github.com", "evil.com")).toBe(false);
    expect(domainMatches("**.github.com", "notgithub.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Private IP detection
// ---------------------------------------------------------------------------

describe("isPrivateIPv4", () => {
  it("detects RFC 1918 ranges", () => {
    expect(isPrivateIPv4("10.0.0.1")).toBe(true);
    expect(isPrivateIPv4("10.255.255.255")).toBe(true);
    expect(isPrivateIPv4("172.16.0.1")).toBe(true);
    expect(isPrivateIPv4("172.31.255.255")).toBe(true);
    expect(isPrivateIPv4("192.168.0.1")).toBe(true);
    expect(isPrivateIPv4("192.168.255.255")).toBe(true);
  });

  it("detects loopback", () => {
    expect(isPrivateIPv4("127.0.0.1")).toBe(true);
    expect(isPrivateIPv4("127.255.255.255")).toBe(true);
  });

  it("detects link-local", () => {
    expect(isPrivateIPv4("169.254.1.1")).toBe(true);
  });

  it("detects 0.0.0.0/8", () => {
    expect(isPrivateIPv4("0.0.0.0")).toBe(true);
  });

  it("passes public IPs", () => {
    expect(isPrivateIPv4("8.8.8.8")).toBe(false);
    expect(isPrivateIPv4("1.1.1.1")).toBe(false);
    expect(isPrivateIPv4("142.250.80.46")).toBe(false);
  });

  it("rejects invalid IPs", () => {
    expect(isPrivateIPv4("not-an-ip")).toBe(false);
    expect(isPrivateIPv4("")).toBe(false);
    expect(isPrivateIPv4("999.999.999.999")).toBe(false);
  });

  it("172.15.x.x is NOT private (just below /12 range)", () => {
    expect(isPrivateIPv4("172.15.255.255")).toBe(false);
  });

  it("172.32.x.x is NOT private (just above /12 range)", () => {
    expect(isPrivateIPv4("172.32.0.0")).toBe(false);
  });
});

describe("isPrivateIPv6", () => {
  it("detects loopback", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
  });

  it("detects ULA addresses", () => {
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("fd12:3456::1")).toBe(true);
  });

  it("detects link-local", () => {
    expect(isPrivateIPv6("fe80::1")).toBe(true);
  });

  it("detects IPv4-mapped private addresses", () => {
    expect(isPrivateIPv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIPv6("::ffff:192.168.1.1")).toBe(true);
  });

  it("passes public IPv6", () => {
    expect(isPrivateIPv6("2001:db8::1")).toBe(false);
    expect(isPrivateIPv6("2607:f8b0:4004:800::200e")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  it("handles both IPv4 and IPv6", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("returns false for non-IP strings", () => {
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NetworkPolicy
// ---------------------------------------------------------------------------

describe("NetworkPolicy", () => {
  describe("checkDomain", () => {
    it("allows matching allow pattern", () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["*.github.com"],
        deny: [],
        blockPrivateAddresses: false,
      });
      const result = policy.checkDomain("api.github.com");
      expect(result.allowed).toBe(true);
    });

    it("deny wins over allow", () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["*.example.com"],
        deny: ["evil.example.com"],
        blockPrivateAddresses: false,
      });
      expect(policy.checkDomain("good.example.com").allowed).toBe(true);
      expect(policy.checkDomain("evil.example.com").allowed).toBe(false);
    });

    it("blocks when no allow rules configured", () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: [],
        deny: [],
        blockPrivateAddresses: false,
      });
      const result = policy.checkDomain("anything.com");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no allow rules");
    });

    it("blocks everything when mode is none", () => {
      const policy = NetworkPolicy.noAccess();
      expect(policy.checkDomain("example.com").allowed).toBe(false);
    });

    it("blocks non-matching domains", () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["api.github.com"],
        deny: [],
        blockPrivateAddresses: false,
      });
      expect(policy.checkDomain("evil.com").allowed).toBe(false);
      expect(policy.checkDomain("evil.com").reason).toContain("not matched");
    });

    it("wildcard allow permits everything", () => {
      const policy = NetworkPolicy.fullAccess();
      expect(policy.checkDomain("anything.com").allowed).toBe(true);
    });
  });

  describe("checkIP", () => {
    it("blocks private IPs when blockPrivate is true", () => {
      const policy = NetworkPolicy.fullAccess();
      expect(policy.checkIP("10.0.0.1").allowed).toBe(false);
      expect(policy.checkIP("127.0.0.1").allowed).toBe(false);
      expect(policy.checkIP("192.168.1.1").allowed).toBe(false);
    });

    it("allows private IPs when blockPrivate is false", () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["*"],
        deny: [],
        blockPrivateAddresses: false,
      });
      expect(policy.checkIP("10.0.0.1").allowed).toBe(true);
    });

    it("allows public IPs", () => {
      const policy = NetworkPolicy.fullAccess();
      expect(policy.checkIP("8.8.8.8").allowed).toBe(true);
    });
  });

  describe("checkHostname", () => {
    it("blocks denied domains", async () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["*"],
        deny: ["evil.com"],
        blockPrivateAddresses: false,
      });
      const result = await policy.checkHostname("evil.com");
      expect(result.allowed).toBe(false);
    });

    it("allows permitted domains", async () => {
      const policy = new NetworkPolicy({
        mode: "full",
        allow: ["api.github.com"],
        deny: [],
        blockPrivateAddresses: false,
      });
      const result = await policy.checkHostname("api.github.com");
      expect(result.allowed).toBe(true);
    });

    it("blocks IP addresses that are private", async () => {
      const policy = NetworkPolicy.fullAccess();
      const result = await policy.checkHostname("127.0.0.1");
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("private");
    });
  });

  describe("static constructors", () => {
    it("fullAccess allows everything public", () => {
      const policy = NetworkPolicy.fullAccess();
      expect(policy.mode).toBe("full");
      expect(policy.checkDomain("anything.com").allowed).toBe(true);
    });

    it("noAccess blocks everything", () => {
      const policy = NetworkPolicy.noAccess();
      expect(policy.mode).toBe("none");
      expect(policy.checkDomain("anything.com").allowed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe("loadNetworkPolicyConfig", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns default config when no file exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netpol-"));
    const config = loadNetworkPolicyConfig({
      cwd: tmpDir,
      homedir: tmpDir,
      envOverrides: {},
    });
    expect(config.mode).toBe("full");
    expect(config.allow).toEqual(["*"]);
    expect(config.deny).toEqual([]);
    expect(config.blockPrivateAddresses).toBe(true);
  });

  it("loads from .openswarm/network.json", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netpol-"));
    const configDir = path.join(tmpDir, ".openswarm");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "network.json"),
      JSON.stringify({
        mode: "proxy-only",
        allow: ["*.github.com"],
        deny: ["evil.com"],
        blockPrivateAddresses: true,
      }),
    );

    const config = loadNetworkPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.mode).toBe("proxy-only");
    expect(config.allow).toEqual(["*.github.com"]);
    expect(config.deny).toEqual(["evil.com"]);
  });

  it("loads from env config dir first", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netpol-"));
    fs.writeFileSync(
      path.join(tmpDir, "network.json"),
      JSON.stringify({ mode: "none", allow: [], deny: [] }),
    );

    const config = loadNetworkPolicyConfig({
      cwd: "/nonexistent",
      homedir: "/nonexistent",
      envOverrides: { OPENSWARM_CONFIG_DIR: tmpDir },
    });
    expect(config.mode).toBe("none");
  });

  it("handles invalid JSON gracefully", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netpol-"));
    const configDir = path.join(tmpDir, ".openswarm");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "network.json"), "not json{{{");

    const config = loadNetworkPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.mode).toBe("full");
  });

  it("validates and defaults invalid fields", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netpol-"));
    const configDir = path.join(tmpDir, ".openswarm");
    fs.mkdirSync(configDir);
    fs.writeFileSync(
      path.join(configDir, "network.json"),
      JSON.stringify({ mode: "invalid", allow: 42, deny: "not-array" }),
    );

    const config = loadNetworkPolicyConfig({
      cwd: tmpDir,
      homedir: "/nonexistent",
      envOverrides: {},
    });
    expect(config.mode).toBe("full");
    expect(config.allow).toEqual(["*"]);
    expect(config.deny).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

describe("singleton management", () => {
  it("getNetworkPolicy returns consistent instance", () => {
    const p1 = getNetworkPolicy();
    const p2 = getNetworkPolicy();
    expect(p1).toBe(p2);
  });

  it("setNetworkPolicy overrides singleton", () => {
    const custom = NetworkPolicy.noAccess();
    setNetworkPolicy(custom);
    expect(getNetworkPolicy()).toBe(custom);
  });

  it("resetNetworkPolicy clears singleton", () => {
    const p1 = getNetworkPolicy();
    resetNetworkPolicy();
    const p2 = getNetworkPolicy();
    expect(p1).not.toBe(p2);
  });
});
