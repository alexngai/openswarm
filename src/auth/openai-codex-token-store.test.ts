import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readCodexTokens,
  writeCodexTokens,
  clearCodexTokens,
  type CodexTokens,
} from "./openai-codex-token-store.js";

let dir: string;
const sample: CodexTokens = {
  access: "at",
  refresh: "rt",
  accountId: "acc_1",
  expiresAt: 1_900_000_000_000,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-store-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("codex token store", () => {
  it("round-trips tokens", () => {
    writeCodexTokens(sample, dir);
    expect(readCodexTokens(dir)).toEqual(sample);
  });

  it("returns null when nothing is stored", () => {
    expect(readCodexTokens(dir)).toBeNull();
  });

  it("writes the file 0600", () => {
    writeCodexTokens(sample, dir);
    const mode = fs.statSync(path.join(dir, "auth.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("namespaces under openai-codex, preserving other providers' entries", () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { key: "x" } }));
    writeCodexTokens(sample, dir);
    const all = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(all.anthropic).toEqual({ key: "x" });
    expect(all["openai-codex"]).toEqual(sample);
  });

  it("clear removes only the codex entry", () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { key: "x" } }));
    writeCodexTokens(sample, dir);
    clearCodexTokens(dir);
    expect(readCodexTokens(dir)).toBeNull();
    const all = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(all.anthropic).toEqual({ key: "x" });
  });

  it("treats a malformed entry as absent", () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "only" } }));
    expect(readCodexTokens(dir)).toBeNull();
  });

  it("re-reads under the lock so an externally-added entry survives a later write", () => {
    writeCodexTokens(sample, dir);
    // Simulate another writer adding its own provider entry between our writes.
    const all = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    all.other = { key: "z" };
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(all));
    writeCodexTokens({ ...sample, access: "rotated" }, dir);
    const after = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
    expect(after.other).toEqual({ key: "z" });
    expect(after["openai-codex"].access).toBe("rotated");
  });

  it("clear on a store with no file is a no-op", () => {
    expect(() => clearCodexTokens(dir)).not.toThrow();
    expect(readCodexTokens(dir)).toBeNull();
  });

  it("re-asserts 0600 even when auth.json pre-existed with loose perms", () => {
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, JSON.stringify({ other: 1 }), { mode: 0o644 });
    writeCodexTokens(sample, dir);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps the secrets dir private (0700)", () => {
    writeCodexTokens(sample, dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("honors SWARM_HARNESS_AUTH_DIR when no baseDir is passed", () => {
    const prev = process.env.SWARM_HARNESS_AUTH_DIR;
    process.env.SWARM_HARNESS_AUTH_DIR = dir;
    try {
      writeCodexTokens(sample); // no baseDir → uses the env override
      expect(readCodexTokens()).toEqual(sample);
      expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SWARM_HARNESS_AUTH_DIR;
      else process.env.SWARM_HARNESS_AUTH_DIR = prev;
    }
  });
});
