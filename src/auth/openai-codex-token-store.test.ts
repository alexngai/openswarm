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
});
