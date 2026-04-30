/**
 * init.ts — initialize a swarm-coder workspace.
 *
 * Creates:
 *   .swarm-coder/        (recursive mkdir)
 *   .gitignore           (appends .swarm-coder/ if not already present)
 *   CLAUDE.md            (stack-detected starter; never overwrites existing)
 *
 * Idempotent — safe to run multiple times.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Stack detection
// ---------------------------------------------------------------------------

type Stack = "node" | "rust" | "python" | "generic";

async function detectStack(cwd: string): Promise<Stack> {
  const checks: Array<[string, Stack]> = [
    ["package.json", "node"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
  ];
  for (const [file, stack] of checks) {
    try {
      await fs.access(path.join(cwd, file));
      return stack;
    } catch {
      // not found, try next
    }
  }
  return "generic";
}

function claudeMdContent(stack: Stack): string {
  const header = `# CLAUDE.md\n\nThis file provides context to AI coding agents working in this repository.\n\n`;
  switch (stack) {
    case "node":
      return (
        header +
        `## Project type\n\nNode.js / TypeScript project.\n\n` +
        `## Common commands\n\n` +
        `Run \`npm run build\` to compile.\n` +
        `Run \`npm test\` to run the test suite.\n` +
        `Run \`npm run lint\` to check code style (if configured).\n\n` +
        `## Notes\n\n` +
        `Check package.json scripts for available npm commands.\n`
      );
    case "rust":
      return (
        header +
        `## Project type\n\nRust project.\n\n` +
        `## Common commands\n\n` +
        `Run \`cargo build\` to compile.\n` +
        `Run \`cargo test\` to run the test suite.\n` +
        `Run \`cargo clippy\` to lint.\n\n` +
        `## Notes\n\n` +
        `See Cargo.toml for workspace members and dependencies.\n`
      );
    case "python":
      return (
        header +
        `## Project type\n\nPython project.\n\n` +
        `## Common commands\n\n` +
        `Run \`python -m pytest\` to run the test suite.\n` +
        `Run \`ruff check .\` to lint (if ruff is installed).\n\n` +
        `## Notes\n\n` +
        `See pyproject.toml for dependencies and tool configuration.\n`
      );
    case "generic":
      return (
        header +
        `## Project type\n\nGeneric project.\n\n` +
        `## Notes\n\n` +
        `Add project-specific build and test commands here.\n`
      );
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runInit(cwd: string): Promise<number> {
  const configDir = path.join(cwd, ".swarm-coder");
  const gitignorePath = path.join(cwd, ".gitignore");
  const claudeMdPath = path.join(cwd, "CLAUDE.md");

  // 1. Create .swarm-coder/ directory.
  let dirCreated = false;
  try {
    await fs.mkdir(configDir, { recursive: true });
    // Check if it already existed by reading — if we just created it, it's new.
    // We rely on mkdir's recursive silently succeeding for existing dirs.
    dirCreated = true;
  } catch (err) {
    process.stderr.write(`error: could not create .swarm-coder/: ${String(err)}\n`);
    return 1;
  }

  // Determine if the dir was already there before this run.
  // We can't easily detect "already existed" from mkdir recursive, so check
  // if it was empty (newly created dirs are empty).
  let dirWasNew = false;
  try {
    const entries = await fs.readdir(configDir);
    dirWasNew = dirCreated && entries.length === 0;
  } catch {
    dirWasNew = dirCreated;
  }

  if (dirWasNew) {
    process.stdout.write("created  .swarm-coder/\n");
  } else {
    process.stdout.write("skipped  .swarm-coder/ (already exists)\n");
  }

  // 2. Append .swarm-coder/ to .gitignore if not already present.
  const gitignoreEntry = ".swarm-coder/";
  let gitignoreUpdated = false;
  try {
    let existing = "";
    try {
      existing = await fs.readFile(gitignorePath, "utf8");
    } catch {
      // File doesn't exist yet — will create it.
    }

    const lines = existing.split("\n").map((l) => l.trim());
    if (!lines.includes(gitignoreEntry)) {
      const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      await fs.writeFile(gitignorePath, existing + separator + gitignoreEntry + "\n", "utf8");
      gitignoreUpdated = true;
    }
  } catch (err) {
    process.stderr.write(`warning: could not update .gitignore: ${String(err)}\n`);
  }

  if (gitignoreUpdated) {
    process.stdout.write("updated  .gitignore (added .swarm-coder/)\n");
  } else {
    process.stdout.write("skipped  .gitignore (.swarm-coder/ already present)\n");
  }

  // 3. Create CLAUDE.md if it doesn't exist.
  let claudeMdCreated = false;
  try {
    await fs.access(claudeMdPath);
    // Already exists — skip.
  } catch {
    // Doesn't exist — create it.
    const stack = await detectStack(cwd);
    await fs.writeFile(claudeMdPath, claudeMdContent(stack), "utf8");
    claudeMdCreated = true;
    process.stdout.write(`created  CLAUDE.md (${stack} starter)\n`);
  }

  if (!claudeMdCreated) {
    process.stdout.write("skipped  CLAUDE.md (already exists)\n");
  }

  return 0;
}
