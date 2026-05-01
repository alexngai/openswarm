/**
 * logout.ts — `swarm-harness logout --provider <name>` subcommand.
 *
 * Dispatches to the appropriate auth provider's logout() method.
 * Exit codes:
 *   0 — success (or no credentials to clear)
 *   1 — user error (missing/unknown provider)
 */

// ---------------------------------------------------------------------------
// parseProvider
// ---------------------------------------------------------------------------

function parseProvider(argv: string[]): string | undefined {
  const idx = argv.indexOf("--provider");
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function logoutMain(argv: string[]): Promise<number> {
  const provider = parseProvider(argv);

  if (!provider) {
    process.stderr.write("error: logout requires --provider <name>\n");
    return 1;
  }

  switch (provider) {
    case "codex-chatgpt": {
      process.stdout.write("Run: codex logout\n");
      return 0;
    }

    case "claude-agent-sdk": {
      process.stdout.write(
        "claude-agent-sdk manages auth via `claude login` (Anthropic SDK). " +
          "swarm-harness has no per-provider token to clear for this provider.\n",
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
