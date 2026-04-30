/**
 * login.ts — `swarm-harness login --provider <name>` subcommand.
 *
 * Dispatches to the appropriate auth provider's login() method.
 * Exit codes:
 *   0 — success
 *   1 — user error (unknown provider)
 *   2 — infra error (unexpected throws)
 */

import { OpenAIOAuthAuth } from "../auth/openai-oauth.js";

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function loginMain(argv: string[]): Promise<number> {
  // --provider is extracted from argv by the caller (main.ts reads it from
  // the parsed result). loginMain accepts the raw argv slice for testability.
  const providerIdx = argv.indexOf("--provider");
  const provider =
    providerIdx !== -1 ? argv[providerIdx + 1] : "claude-agent-sdk";

  switch (provider) {
    case "codex-chatgpt": {
      const auth = new OpenAIOAuthAuth();
      try {
        await auth.login();
        process.stdout.write(
          "logged in to codex-chatgpt. Credentials stored in ~/.swarm-harness/auth.json.\n",
        );
        return 0;
      } catch (err) {
        process.stderr.write(
          `error: login failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 2;
      }
    }

    case "claude-agent-sdk":
    case undefined: {
      process.stdout.write(
        "claude-agent-sdk uses Anthropic credentials managed by the Claude SDK.\n" +
          "Run `claude login` to authenticate with Anthropic.\n",
      );
      return 0;
    }

    default:
      process.stderr.write(
        `error: unknown provider: ${provider}. Known: codex-chatgpt, claude-agent-sdk.\n`,
      );
      return 1;
  }
}
