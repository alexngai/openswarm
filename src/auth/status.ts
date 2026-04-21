/**
 * detectAuth — presence-only check for Anthropic credentials.
 *
 * Reports which credential source is available without reading or
 * decrypting anything. Used by `doctor` to tell the user whether they
 * need to run `claude auth login` or set ANTHROPIC_API_KEY.
 *
 * Per docs/06-open-questions.md Q16, swarm-coder does NOT manage auth.
 * Users authenticate via Anthropic's own CLI; we only detect presence.
 */

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export type AuthStatus =
  | { state: "env-api-key"; source: "ANTHROPIC_API_KEY" }
  | { state: "env-oauth-token"; source: "CLAUDE_CODE_OAUTH_TOKEN" }
  | { state: "env-auth-token"; source: "ANTHROPIC_AUTH_TOKEN" }
  | { state: "keychain"; service: "Claude Code-credentials" }
  | { state: "file"; path: string }
  | { state: "none" };

/** Returns the user's home directory, with fallbacks for unusual environments. */
export function homeDir(): string {
  return os.homedir() || process.env.HOME || process.env.USERPROFILE || ".";
}

export async function detectAuth(): Promise<AuthStatus> {
  // 1. Env var priority order — treat empty strings as unset.
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey) {
    return { state: "env-api-key", source: "ANTHROPIC_API_KEY" };
  }

  const oauthToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (oauthToken) {
    return { state: "env-oauth-token", source: "CLAUDE_CODE_OAUTH_TOKEN" };
  }

  const authToken = process.env["ANTHROPIC_AUTH_TOKEN"];
  if (authToken) {
    return { state: "env-auth-token", source: "ANTHROPIC_AUTH_TOKEN" };
  }

  // 2. Platform-specific credential store check (presence only — no decryption).
  if (process.platform === "darwin") {
    // macOS keychain: use exit-code semantics only. Do NOT pass -w (would print secret).
    try {
      await execFile(
        "security",
        [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          process.env["USER"] ?? os.userInfo().username,
        ],
        { timeout: 3000 },
      );
      // Exit code 0 means the entry exists.
      return { state: "keychain", service: "Claude Code-credentials" };
    } catch {
      // Not found, sandboxed, not installed, or timed out — fall through.
    }
  }

  // Linux / Windows / other (also macOS fallback if keychain lookup failed).
  const credPath = `${homeDir()}/.claude/.credentials.json`;
  try {
    await fs.access(credPath);
    return { state: "file", path: credPath };
  } catch {
    // File not present — fall through.
  }

  return { state: "none" };
}
