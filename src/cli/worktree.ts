/**
 * worktree.ts — `openswarm worktree list|clean` subcommand (v0.7 stage 7D).
 *
 * Manages the per-team worktrees that the git-cascade BranchPolicy adapter
 * creates under `<repo>/.swarm-harness/worktrees/<streamId>/`. Run after a
 * team finishes to reclaim disk + git's worktree registry; the audit-trail
 * philosophy of git-cascade means we never auto-clean.
 *
 * Subcommands:
 *   list                  print one worktree path per line
 *   clean [--dry-run]     `git worktree remove --force` each, then `git worktree prune`
 *
 * Flags:
 *   --repo <path>         override the repo root (default: cwd)
 *   --dry-run             clean only — print what would be removed
 *   --json                list only — emit a JSON array
 */
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const WORKTREES_SUBDIR = path.join(".swarm-harness", "worktrees");

export interface WorktreeMainOpts {
  /** Override stdout — used by tests. Defaults to process.stdout.write. */
  readonly write?: (s: string) => void;
  /** Override the git binary path. Defaults to "git". */
  readonly gitBin?: string;
}

export async function worktreeMain(
  argv: readonly string[],
  opts: WorktreeMainOpts = {},
): Promise<number> {
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const gitBin = opts.gitBin ?? "git";

  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "help" || sub === "--help") {
    write(usage());
    return sub === undefined ? 1 : 0;
  }

  const flags = parseFlags(rest);

  switch (sub) {
    case "list": {
      const paths = await listWorktrees(flags.repo);
      if (flags.json) {
        write(JSON.stringify(paths) + "\n");
      } else if (paths.length === 0) {
        write("(no worktrees under " + path.join(flags.repo, WORKTREES_SUBDIR) + ")\n");
      } else {
        for (const p of paths) write(p + "\n");
      }
      return 0;
    }
    case "clean": {
      const paths = await listWorktrees(flags.repo);
      if (paths.length === 0) {
        write("(no worktrees to clean)\n");
        return 0;
      }
      let removed = 0;
      let failed = 0;
      for (const p of paths) {
        if (flags.dryRun) {
          write(`would remove: ${p}\n`);
          continue;
        }
        const r = spawnSync(gitBin, ["worktree", "remove", "--force", p], {
          cwd: flags.repo,
          stdio: "pipe",
        });
        if (r.status === 0) {
          write(`removed: ${p}\n`);
          removed++;
        } else {
          const stderr = r.stderr?.toString() ?? "";
          write(`FAILED: ${p}\n  ${stderr.trim()}\n`);
          failed++;
        }
      }
      if (!flags.dryRun) {
        // Prune git's registry to drop stale entries (e.g. directories
        // already removed manually).
        const prune = spawnSync(gitBin, ["worktree", "prune"], {
          cwd: flags.repo,
          stdio: "pipe",
        });
        if (prune.status === 0) write("pruned git worktree registry\n");
      }
      write(`\nsummary: removed=${removed} failed=${failed}\n`);
      return failed === 0 ? 0 : 1;
    }
    default:
      write(`unknown worktree subcommand: ${sub}\n\n${usage()}`);
      return 1;
  }
}

interface WorktreeFlags {
  readonly repo: string;
  readonly dryRun: boolean;
  readonly json: boolean;
}

function parseFlags(argv: readonly string[]): WorktreeFlags {
  let repo = process.cwd();
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo") {
      const v = argv[++i];
      if (v !== undefined) repo = path.resolve(v);
    } else if (a.startsWith("--repo=")) {
      repo = path.resolve(a.slice("--repo=".length));
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--json") {
      json = true;
    }
  }
  return { repo, dryRun, json };
}

async function listWorktrees(repo: string): Promise<string[]> {
  const root = path.join(repo, WORKTREES_SUBDIR);
  if (!existsSync(root)) return [];
  const entries = await readdir(root);
  const dirs: string[] = [];
  for (const e of entries) {
    const p = path.join(root, e);
    try {
      const s = await stat(p);
      if (s.isDirectory()) dirs.push(p);
    } catch {
      // ignore unreadable entries
    }
  }
  dirs.sort();
  return dirs;
}

function usage(): string {
  return `Usage:
  openswarm worktree list   [--repo <path>] [--json]
  openswarm worktree clean  [--repo <path>] [--dry-run]

Manages git-cascade-created worktrees under <repo>/.swarm-harness/worktrees/.
Use \`clean\` to reclaim disk and prune git's worktree registry after a team
run. Use \`list\` to inspect what's there. Default --repo is the cwd.
`;
}
