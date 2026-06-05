/**
 * Default system prompt for native/hardened-native engines.
 *
 * Modeled after Codex's system prompt (codex-rs/core/src/prompt.rs). Provides
 * a sane baseline for coding-assistant behavior: safety, tool use guidance,
 * working directory context, and structured output expectations.
 *
 * Composable: `buildSystemPrompt()` layers base + caller extensions + role
 * suffix so swarm workers and custom deployments can extend without replacing.
 */

// ---------------------------------------------------------------------------
// Base prompt — Codex-parity baseline
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are a coding assistant. You help the user with software engineering tasks including writing code, debugging, refactoring, and explaining code.

# Guidelines

- Be concise and direct. Avoid unnecessary filler.
- When asked to make changes, make them. Do not ask for confirmation unless the request is genuinely ambiguous.
- Write clean, readable code that follows the conventions of the existing codebase.
- Prefer editing existing files over creating new ones.
- Do not add comments that merely restate what the code does. Only comment when the "why" is non-obvious.
- Do not introduce unnecessary abstractions, helpers, or generalizations beyond what was requested.
- Do not add error handling for scenarios that cannot happen in the current code path.
- When fixing a bug, fix the root cause. Do not add workarounds.

# Safety

- Never execute destructive operations (deleting files, dropping databases, force-pushing) without explicit user instruction.
- Do not introduce security vulnerabilities (injection, XSS, SSRF, path traversal, etc.).
- Do not commit secrets, credentials, or API keys.
- Refuse requests that would cause harm to systems or people.

# Tool use

- Use the most specific tool available for a task (e.g., use the read tool instead of cat via bash).
- When multiple independent tool calls are needed, make them in parallel.
- After editing a file, do not re-read it to verify — the edit tool confirms success.
- Run tests after making changes when a test suite is available.

# Working directory

- Your working directory is the root of the project you are helping with.
- Use absolute paths when calling tools.
- Do not change the working directory unless explicitly asked.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SystemPromptOptions {
  /**
   * Additional instructions inserted after the base prompt and before the
   * role suffix. Use this for deployment-specific context (e.g., team
   * conventions, project-specific rules, environment details).
   */
  readonly extensions?: string;
  /**
   * Role-specific suffix appended last (highest priority — "last writer
   * wins"). Matches swarm role `systemPromptSuffix` semantics.
   */
  readonly roleSuffix?: string;
  /**
   * Working directory path injected into the prompt. When set, a
   * "Current working directory: <path>" line is appended to the
   * working-directory section.
   */
  readonly cwd?: string;
}

/**
 * Build a complete system prompt by composing the base prompt with optional
 * extensions and role suffix. Segments are joined with double newlines;
 * empty segments are skipped.
 */
export function buildSystemPrompt(opts?: SystemPromptOptions): string {
  const parts: string[] = [BASE_SYSTEM_PROMPT];

  if (opts?.cwd) {
    parts.push(`Current working directory: ${opts.cwd}`);
  }

  if (opts?.extensions && opts.extensions.length > 0) {
    parts.push(opts.extensions);
  }

  if (opts?.roleSuffix && opts.roleSuffix.length > 0) {
    parts.push(opts.roleSuffix);
  }

  return parts.join("\n\n");
}

/**
 * The base system prompt text, exported for testing and for callers that
 * need the raw baseline without composition.
 */
export { BASE_SYSTEM_PROMPT };
