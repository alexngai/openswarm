/**
 * doctor.ts — health-check subcommand.
 *
 * Four checks:
 *   auth      — detectAuth() presence check
 *   config    — .swarm-coder/ directory exists
 *   install   — @anthropic-ai/claude-agent-sdk importable + version
 *   workspace — cwd is writable (probe file)
 *
 * Text format: ✓ auth: ... / ✗ workspace: ...
 * JSON format: { checks: [...], overall: "pass" | "fail" }
 *
 * Exit code: 0 if no checks failed, 1 if any failed. warn is not a failure.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import { detectAuth } from "../auth/status.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkAuth(): Promise<CheckResult> {
  const status = await detectAuth();
  switch (status.state) {
    case "env-api-key":
      return { name: "auth", status: "pass", message: "ANTHROPIC_API_KEY set" };
    case "env-oauth-token":
      return { name: "auth", status: "pass", message: "CLAUDE_CODE_OAUTH_TOKEN set" };
    case "env-auth-token":
      return { name: "auth", status: "pass", message: "ANTHROPIC_AUTH_TOKEN set" };
    case "keychain":
      return { name: "auth", status: "pass", message: "keychain credential found (Claude Code-credentials)" };
    case "file":
      return { name: "auth", status: "pass", message: `credential file found at ${status.path}` };
    case "none":
      return {
        name: "auth",
        status: "fail",
        message:
          "no auth found — run `claude auth login` or `export ANTHROPIC_API_KEY=<your-key>`",
      };
  }
}

async function checkConfig(cwd: string): Promise<CheckResult> {
  const configDir = path.join(cwd, ".swarm-coder");
  try {
    await fs.access(configDir);
    return { name: "config", status: "pass", message: ".swarm-coder/ directory found" };
  } catch {
    return {
      name: "config",
      status: "warn",
      message: "no config found — run `swarm-coder init`",
    };
  }
}

async function checkInstall(): Promise<CheckResult> {
  try {
    // Verify the SDK is importable via a dynamic import of its main export.
    await import("@anthropic-ai/claude-agent-sdk");

    // Read version from package.json. The SDK's exports map does not expose
    // "./package.json", so resolve the main entry and climb up to find its
    // package.json on disk.
    let version = "unknown";
    try {
      const require = createRequire(import.meta.url);
      const mainPath = require.resolve("@anthropic-ai/claude-agent-sdk");
      // mainPath looks like .../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
      // Walk up until we find a package.json that declares the right name.
      let dir = path.dirname(mainPath);
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, "package.json");
        try {
          const raw = await fs.readFile(candidate, "utf8");
          const pkg = JSON.parse(raw) as { name?: string; version?: string };
          if (pkg.name === "@anthropic-ai/claude-agent-sdk") {
            version = pkg.version ?? "unknown";
            break;
          }
        } catch {
          // keep climbing
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // version read failed — still pass, just report unknown
    }

    return {
      name: "install",
      status: "pass",
      message: `@anthropic-ai/claude-agent-sdk v${version} found`,
    };
  } catch {
    return {
      name: "install",
      status: "fail",
      message:
        "@anthropic-ai/claude-agent-sdk not importable — run `npm install @anthropic-ai/claude-agent-sdk`",
    };
  }
}

async function checkWorkspace(cwd: string): Promise<CheckResult> {
  const probeFile = path.join(cwd, `.swarm-coder-doctor-probe-${process.pid}`);
  try {
    await fs.writeFile(probeFile, "");
    await fs.unlink(probeFile);
    return { name: "workspace", status: "pass", message: `${cwd} is writable` };
  } catch {
    return {
      name: "workspace",
      status: "fail",
      message: `${cwd} is not writable`,
    };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runDoctor(
  outputFormat: "text" | "json",
  cwd: string = process.cwd(),
): Promise<number> {
  const checks = await Promise.all([
    checkAuth(),
    checkConfig(cwd),
    checkInstall(),
    checkWorkspace(cwd),
  ]);

  const overall: "pass" | "fail" = checks.some((c) => c.status === "fail")
    ? "fail"
    : "pass";

  if (outputFormat === "json") {
    process.stdout.write(JSON.stringify({ checks, overall }) + "\n");
  } else {
    for (const check of checks) {
      const icon = check.status === "pass" ? "✓" : check.status === "warn" ? "⚠" : "✗";
      process.stdout.write(`${icon} ${check.name}: ${check.message}\n`);
    }
  }

  return overall === "fail" ? 1 : 0;
}
