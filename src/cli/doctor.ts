/**
 * doctor.ts — health-check subcommand.
 *
 * Four checks:
 *   auth      — detectAuth() presence check
 *   config    — .swarm-coder/ directory exists
 *   install   — @anthropic-ai/claude-agent-sdk importable + version + CLI binary
 *   workspace — cwd is writable (probe file)
 *
 * Text format: ✓ auth: ... / ✗ workspace: ...
 * JSON format: { checks: [...], overall: "pass" | "fail" }
 *
 * Exit code: 0 if no checks failed, 1 if any failed. warn is not a failure.
 */

import * as fs from "node:fs/promises";
import * as fsc from "node:fs";
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

// ---------------------------------------------------------------------------
// Binary-location helper
// ---------------------------------------------------------------------------

const PLATFORM_DEP_MAP: Record<string, string> = {
  "darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "linux-x64": "@anthropic-ai/claude-agent-sdk-linux-x64",
  "linux-arm64": "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "linux-x64-musl": "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  "linux-arm64-musl": "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "win32-x64": "@anthropic-ai/claude-agent-sdk-win32-x64",
  "win32-arm64": "@anthropic-ai/claude-agent-sdk-win32-arm64",
};

/**
 * Returns { binaryPath } on success, or { warn: reason } for unsupported
 * platform, or { error: reason } when the dep is missing/inaccessible.
 */
async function findCliBinary(): Promise<
  | { kind: "found"; binaryPath: string }
  | { kind: "warn"; reason: string }
  | { kind: "missing"; expectedPath: string }
> {
  const key = `${process.platform}-${process.arch}`;
  const depName = PLATFORM_DEP_MAP[key];
  if (!depName) {
    return { kind: "warn", reason: `platform ${key} not in the known bundled-binary list` };
  }

  let depDir: string;
  try {
    const req = createRequire(import.meta.url);
    const depPkgPath = req.resolve(`${depName}/package.json`);
    depDir = path.dirname(depPkgPath);
  } catch {
    // Optional dep not installed at all — construct a best-effort path for
    // the error message using node_modules relative to this file.
    const guessedDir = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../../node_modules",
      depName,
    );
    const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
    return { kind: "missing", expectedPath: path.join(guessedDir, binaryName) };
  }

  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  const binaryPath = path.join(depDir, binaryName);

  try {
    await fs.access(binaryPath, fsc.constants.X_OK);
    return { kind: "found", binaryPath };
  } catch {
    return { kind: "missing", expectedPath: binaryPath };
  }
}

// ---------------------------------------------------------------------------
// Install check
// ---------------------------------------------------------------------------

// Build-time-injected fallback (see scripts/build-binary.ts). In dev (tsc
// output, or `bun src/cli.ts`) this identifier is undefined and the runtime
// resolve path below is used. In the compiled binary the identifier is
// replaced with a string literal.
declare const __SWARM_CODER_AGENT_SDK_VERSION__: string | undefined;

async function checkInstall(): Promise<CheckResult> {
  try {
    // Verify the SDK is importable via a dynamic import of its main export.
    await import("@anthropic-ai/claude-agent-sdk");

    // Read version from package.json. The SDK's exports map does not expose
    // "./package.json", so resolve the main entry and climb up to find its
    // package.json on disk.
    let version =
      typeof __SWARM_CODER_AGENT_SDK_VERSION__ === "string"
        ? __SWARM_CODER_AGENT_SDK_VERSION__
        : "unknown";
    try {
      const require = createRequire(import.meta.url);
      const mainPath = require.resolve("@anthropic-ai/claude-agent-sdk");
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

    // Check for the bundled CLI binary.
    const binResult = await findCliBinary();
    if (binResult.kind === "found") {
      return {
        name: "install",
        status: "pass",
        message: `SDK v${version} + CLI binary at ${binResult.binaryPath} found`,
      };
    } else if (binResult.kind === "warn") {
      return {
        name: "install",
        status: "warn",
        message: `SDK v${version} found; ${binResult.reason} — SDK may fall back to a system binary`,
      };
    } else {
      return {
        name: "install",
        status: "fail",
        message:
          `SDK importable but bundled CLI binary missing (expected ${binResult.expectedPath}); ` +
          `try \`npm rebuild ${PLATFORM_DEP_MAP[`${process.platform}-${process.arch}`] ?? "@anthropic-ai/claude-agent-sdk"}\` or reinstall`,
      };
    }
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
