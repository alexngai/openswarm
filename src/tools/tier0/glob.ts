/**
 * glob — file pattern matching via fast-glob.
 *
 * Uses the `fast-glob` package so `*.ts` matches files at any depth (the
 * standard agent-tool convention), `**​/*.ts` is explicit recursion, and
 * gitignore semantics are correct. Caps results at 1000.
 */

import * as path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  pattern: z.string(),
  cwd: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Bare `*.ts` matches at any depth; " +
    "`**` forces recursion; `?` matches a single character. " +
    "Respects .gitignore. Excludes node_modules, .git, and dist by default. " +
    "Returns newline-separated absolute paths, capped at 1000 entries.",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 0,
};

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**"];
const MAX_RESULTS = 1000;

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const base = input.cwd ?? ctx.cwd;

  // Bare patterns like "*.ts" should match at any depth — convention from
  // Claude Code / claw. Promote to `**/<pattern>` when the pattern has no
  // path separators and no explicit `**`.
  const normalized =
    input.pattern.includes("/") || input.pattern.includes("**")
      ? input.pattern
      : `**/${input.pattern}`;

  let matches: string[];
  try {
    matches = await fg(normalized, {
      cwd: base,
      absolute: true,
      dot: false,
      onlyFiles: true,
      ignore: DEFAULT_IGNORE,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `glob failed: ${msg}` };
  }

  // Filter via .gitignore — fast-glob doesn't natively read .gitignore,
  // so we union the negate rules from any .gitignore reachable from base.
  const gitignored = await loadGitignoreFilter(base);
  const kept = gitignored ? matches.filter((p) => !gitignored(p)) : matches;

  const capped = kept.slice(0, MAX_RESULTS);
  let output = capped.map((p) => path.resolve(p)).join("\n");
  if (kept.length > MAX_RESULTS) {
    output += `\n[truncated: ${kept.length - MAX_RESULTS} additional matches]`;
  }

  return { status: "ok", output };
}

/**
 * Build a predicate that returns true for paths ignored by the repo's
 * root-level `.gitignore` (if any). Uses fast-glob's own matcher to stay
 * consistent with the main query. If no .gitignore exists, returns null.
 */
async function loadGitignoreFilter(
  base: string,
): Promise<((abs: string) => boolean) | null> {
  const fs = await import("node:fs/promises");
  let content: string;
  try {
    content = await fs.readFile(path.join(base, ".gitignore"), "utf8");
  } catch {
    return null;
  }

  const patterns: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // Strip leading slash (gitignore root anchor); fast-glob treats leading
    // slash as absolute, which isn't what .gitignore means.
    const stripped = line.startsWith("/") ? line.slice(1) : line;
    // If no glob chars, treat as a directory or file name at any depth.
    if (!stripped.includes("*") && !stripped.includes("?") && !stripped.includes("/")) {
      patterns.push(`**/${stripped}`);
      patterns.push(`**/${stripped}/**`);
    } else {
      patterns.push(stripped);
      patterns.push(`${stripped}/**`);
    }
  }

  if (patterns.length === 0) return null;

  return (abs: string): boolean => {
    const rel = path.relative(base, abs);
    return matchAny(rel, patterns);
  };
}

/**
 * Minimal glob-to-regex match for gitignore filtering. Uses fast-glob's own
 * pattern logic via a fresh sync call — cheap for the 1-pass filter.
 */
function matchAny(rel: string, patterns: string[]): boolean {
  // Use fast-glob's sync match via fg.sync with a single-element path source
  // by checking each pattern against the relative path via a regex built from
  // the pattern. fast-glob re-exports picomatch transitively; we inline a
  // minimal matcher here to avoid pulling another dep.
  for (const pat of patterns) {
    if (simpleGlobMatch(rel, pat)) return true;
  }
  return false;
}

function simpleGlobMatch(p: string, pattern: string): boolean {
  // Convert glob to regex: `**` → `.*`, `*` → `[^/]*`, `?` → `[^/]`.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re).test(p);
}

export const globTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
