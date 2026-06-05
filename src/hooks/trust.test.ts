import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  computeHookHash,
  verifyHookTrust,
  verifyAllHooks,
  type HooksConfigFile,
} from "./config.js";
import type { HookConfig } from "./index.js";

describe("computeHookHash", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns SHA-256 of file content", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hookhash-"));
    const script = path.join(tmpDir, "hook.sh");
    fs.writeFileSync(script, "#!/bin/bash\necho hello\n");

    const hash = computeHookHash(script);
    expect(hash).not.toBeNull();

    const expected = crypto
      .createHash("sha256")
      .update("#!/bin/bash\necho hello\n")
      .digest("hex");
    expect(hash).toBe(expected);
  });

  it("returns null for non-existent file", () => {
    expect(computeHookHash("/nonexistent/hook.sh")).toBeNull();
  });
});

describe("verifyHookTrust", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("trusts hooks without contentHash", () => {
    const hook: HookConfig = { matcher: "*", command: "echo hello" };
    const result = verifyHookTrust(hook);
    expect(result.trusted).toBe(true);
    expect(result.reason).toContain("no hash configured");
  });

  it("trusts hooks with matching hash", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooktrust-"));
    const script = path.join(tmpDir, "hook.sh");
    const content = "#!/bin/bash\necho trusted\n";
    fs.writeFileSync(script, content);

    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const hook: HookConfig = {
      matcher: "*",
      command: script,
      contentHash: hash,
    };

    const result = verifyHookTrust(hook);
    expect(result.trusted).toBe(true);
    expect(result.reason).toBe("hash matches");
  });

  it("rejects hooks with mismatched hash", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hooktrust-"));
    const script = path.join(tmpDir, "hook.sh");
    fs.writeFileSync(script, "#!/bin/bash\necho tampered\n");

    const hook: HookConfig = {
      matcher: "*",
      command: script,
      contentHash: "deadbeef0000000000000000000000000000000000000000000000000000000",
    };

    const result = verifyHookTrust(hook);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("hash mismatch");
  });

  it("rejects hooks when script doesn't exist", () => {
    const hook: HookConfig = {
      matcher: "*",
      command: "/nonexistent/hook.sh",
      contentHash: "abc123",
    };

    const result = verifyHookTrust(hook);
    expect(result.trusted).toBe(false);
    expect(result.reason).toContain("cannot read");
  });
});

describe("verifyAllHooks", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies all events", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hookall-"));
    const script = path.join(tmpDir, "hook.sh");
    const content = "#!/bin/bash\necho ok\n";
    fs.writeFileSync(script, content);
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    const config: HooksConfigFile = {
      PreToolUse: [{ matcher: "bash", command: script, contentHash: hash }],
      PostToolUse: [{ matcher: "*", command: "echo no-hash" }],
    };

    const results = verifyAllHooks(config);
    expect(results.size).toBe(2);
    expect(results.get("PreToolUse")![0]!.trusted).toBe(true);
    expect(results.get("PostToolUse")![0]!.trusted).toBe(true);
  });

  it("skips empty events", () => {
    const config: HooksConfigFile = {
      PreToolUse: [],
      PostToolUse: undefined,
    };

    const results = verifyAllHooks(config);
    expect(results.size).toBe(0);
  });
});
