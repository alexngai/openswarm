/**
 * Banned prefix suggestions (E3): prevent overly broad "always allow"
 * rules for interpreter commands and dangerous binaries.
 *
 * When a user or auto-amendment system tries to create a policy rule
 * that would always allow a banned command prefix, this module detects
 * it and blocks the rule.
 *
 * Reference: Codex `execpolicy/src/lib.rs` — ~40 banned prefixes.
 */

/**
 * Commands that must never be added as unconditional "always allow" rules.
 * These are interpreters, shells, or privileged commands that can execute
 * arbitrary code — an "always allow" rule for them bypasses all safety.
 */
const BANNED_PREFIXES: readonly string[] = [
  // Shells
  "bash",
  "sh",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",

  // Interpreters
  "python",
  "python3",
  "python2",
  "node",
  "ruby",
  "perl",
  "lua",
  "php",
  "Rscript",
  "julia",
  "elixir",
  "swift",

  // Package managers with exec
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "pip",
  "gem",
  "cargo",
  "go",

  // Privilege escalation
  "sudo",
  "su",
  "doas",
  "pkexec",

  // Remote execution
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",

  // Containers (can escape sandbox)
  "docker",
  "podman",
  "kubectl",

  // Git (can execute hooks)
  "git",

  // System-level
  "chmod",
  "chown",
  "mount",
  "umount",
  "systemctl",
  "service",

  // Eval/exec wrappers
  "env",
  "xargs",
  "exec",
  "eval",
  "nohup",
  "screen",
  "tmux",
  "script",

  // Compilers (can run arbitrary code via -e flags)
  "gcc",
  "g++",
  "clang",
  "clang++",
  "make",
  "cmake",
];

const BANNED_SET = new Set(BANNED_PREFIXES.map((p) => p.toLowerCase()));

/**
 * Check if a proposed "always allow" rule prefix would be too broad.
 *
 * @param rulePrefix - The command prefix the rule would allow (e.g., "python", "bash -c")
 * @returns The banned command if this rule is too broad, or `null` if it's safe.
 *
 * A rule is banned if:
 * 1. Its first token (the binary name) is in the banned list, AND
 * 2. The rule is just the bare command name (no further narrowing arguments).
 *
 * For example:
 * - "python" → banned (too broad)
 * - "python -m pytest" → allowed (narrowed to a specific action)
 * - "bash" → banned
 * - "bash -c 'npm test'" → still banned (bash -c can run anything)
 */
export function checkBannedPrefix(rulePrefix: string): string | null {
  const trimmed = rulePrefix.trim();
  if (trimmed.length === 0) return null;

  const tokens = trimmed.split(/\s+/);
  const command = tokens[0]!.toLowerCase();

  // Extract just the binary name (strip path)
  const basename = command.includes("/")
    ? command.slice(command.lastIndexOf("/") + 1)
    : command;

  if (!BANNED_SET.has(basename)) return null;

  // Bare command: always banned
  if (tokens.length === 1) return basename;

  // Shell -c or -e: still banned (can run anything)
  if (isShellExec(basename, tokens)) return basename;

  // Interpreter with -c/-e: still banned
  if (isInterpreterExec(basename, tokens)) return basename;

  // Has additional arguments that narrow the command → allowed
  return null;
}

function isShellExec(command: string, tokens: string[]): boolean {
  const shells = new Set(["bash", "sh", "zsh", "fish", "csh", "tcsh", "ksh", "dash"]);
  if (!shells.has(command)) return false;
  return tokens.some((t) => t === "-c" || t === "-e");
}

function isInterpreterExec(command: string, tokens: string[]): boolean {
  const interpreters = new Set([
    "python", "python3", "python2", "node", "ruby", "perl", "lua", "php",
  ]);
  if (!interpreters.has(command)) return false;
  return tokens.some((t) => t === "-c" || t === "-e");
}

/**
 * Validate a batch of proposed rules. Returns list of banned ones.
 */
export function checkBannedPrefixes(
  rulePrefixes: readonly string[],
): readonly { prefix: string; bannedCommand: string }[] {
  const results: { prefix: string; bannedCommand: string }[] = [];
  for (const prefix of rulePrefixes) {
    const banned = checkBannedPrefix(prefix);
    if (banned !== null) {
      results.push({ prefix, bannedCommand: banned });
    }
  }
  return results;
}

/**
 * Get the full list of banned command names for documentation/display.
 */
export function getBannedPrefixList(): readonly string[] {
  return BANNED_PREFIXES;
}
