/**
 * login.ts — `swarm-harness login --provider <name>` subcommand.
 *
 * Dispatches to the appropriate auth provider's login() method.
 * Exit codes:
 *   0 — success
 *   1 — user error (unknown provider)
 *   2 — infra error (unexpected throws)
 */

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
      process.stdout.write(
        "swarm-harness now delegates ChatGPT auth to the official codex CLI.\n" +
          "Run: codex login\n" +
          "This is a one-time setup; swarm-harness will then use your subscription\n" +
          "automatically when you pass --framework codex-chatgpt.\n" +
          "If you don't have codex installed yet: npm install -g @openai/codex\n",
      );
      return 0;
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
