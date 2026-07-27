/**
 * Provenance scan — what does this workspace add, and what would it activate?
 *
 * The scan answers the question a trust prompt has to ask on the user's behalf.
 * "Do you trust this folder?" with no inventory is a dialog people dismiss;
 * "this folder starts two MCP subprocesses, here are their command lines" is a
 * decision someone can actually make.
 *
 * @security This module parses untrusted input. It must never execute, spawn,
 * import, or connect to anything it finds, and it must not resolve a candidate
 * through `realpath`: a repository symlink pointing at a home-directory file
 * would then be classified as user-owned and skip the gate. Candidates are
 * judged at the path the loader would name them by, which fails toward
 * treating a file as workspace-owned.
 *
 * Paths come from the loaders themselves (`mcpConfigCandidates`,
 * `hookConfigCandidates`) rather than a second copy of the hierarchy, so the
 * scan cannot describe one file while the loader reads another.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { isWithin } from "../kernel/workspace-authority.js";
import { mcpConfigCandidates } from "../mcp/config.js";
import { hookConfigCandidates } from "../hooks/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the worst case is if this file is honoured.
 *
 * `execute` covers anything that reaches a shell, a subprocess, or a module
 * load. `prompt` covers content that only reaches the model's context; it is
 * still an attack surface, but a different one, and it is not what a trust
 * dialog can meaningfully gate.
 */
export type Severity = "execute" | "prompt";

export interface Finding {
  readonly kind: "mcp" | "hooks" | "settings" | "roles" | "skills" | "instructions";
  /** Absolute path, as the loader would name it. */
  readonly path: string;
  /** Workspace-relative, for display. */
  readonly display: string;
  readonly severity: Severity;
  /** SHA-256 of the file's bytes; empty when unreadable. */
  readonly sha256: string;
  /** One line per activation, for the prompt. Empty when nothing parses. */
  readonly activates: readonly string[];
}

export interface Provenance {
  readonly root: string;
  readonly findings: readonly Finding[];
  /**
   * Binds a trust decision to what was reviewed. Covers the content of every
   * executing file, and the *names* of prompt-scoped files but not their
   * content — so a new skill appearing re-prompts, while editing AGENTS.md
   * does not. Instruction files change constantly and re-prompting on every
   * edit is how a trust dialog becomes something people click through.
   */
  readonly digest: string;
  /** True when nothing in the workspace can cause execution. */
  readonly inert: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readIfPresent(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Parse without throwing; malformed config is reported, not trusted. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * A command line, shortened for display. Truncation is display-only — the
 * digest always covers the full bytes.
 */
function summarizeCommand(command: unknown, args: unknown): string {
  const cmd = typeof command === "string" ? command : "<invalid>";
  const list = Array.isArray(args) ? args.filter((a) => typeof a === "string") : [];
  const full = [cmd, ...list].join(" ");
  return full.length > 120 ? `${full.slice(0, 117)}...` : full;
}

// ---------------------------------------------------------------------------
// Per-kind description
// ---------------------------------------------------------------------------

function describeMcp(raw: string): string[] {
  const servers = asRecord(asRecord(parseJson(raw))?.["mcpServers"]);
  if (servers === undefined) return ["unreadable MCP configuration"];
  return Object.entries(servers).map(([name, spec]) => {
    const s = asRecord(spec);
    return `MCP server "${name}" runs: ${summarizeCommand(s?.["command"], s?.["args"])}`;
  });
}

function describeHooks(raw: string, fromSettings: boolean): string[] {
  const root = asRecord(parseJson(raw));
  const hooks = asRecord(fromSettings ? root?.["hooks"] : root);
  if (hooks === undefined) return fromSettings ? [] : ["unreadable hook configuration"];

  const lines: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const e = asRecord(entry);
      // Both the flat shape and Claude Code's nested `{ hooks: [...] }` shape.
      const inner = Array.isArray(e?.["hooks"]) ? (e["hooks"] as unknown[]) : [entry];
      for (const h of inner) {
        const cfg = asRecord(h);
        const command = cfg?.["command"];
        if (typeof command === "string") {
          const short = command.length > 100 ? `${command.slice(0, 97)}...` : command;
          lines.push(`hook on ${event} runs: ${short}`);
        }
      }
    }
  }
  return lines;
}

/**
 * A Claude Code settings file is handed wholesale to the Claude Agent SDK via
 * `settingSources`, which acts on keys OpenSwarm never parses. The scan names
 * the ones that reach execution rather than pretending to enumerate the file.
 */
function describeSettings(raw: string): string[] {
  const root = asRecord(parseJson(raw));
  if (root === undefined) return ["unreadable Claude settings"];
  const lines: string[] = [];
  if (root["hooks"] !== undefined) lines.push(...describeHooks(raw, true));
  if (root["mcpServers"] !== undefined) {
    const servers = asRecord(root["mcpServers"]) ?? {};
    for (const [name, spec] of Object.entries(servers)) {
      const s = asRecord(spec);
      lines.push(`MCP server "${name}" runs: ${summarizeCommand(s?.["command"], s?.["args"])}`);
    }
  }
  // CVE-2026-33068: a repository that sets the permission mode can talk its way
  // out of the very prompt that should have vetted it. Always surfaced.
  const permissions = asRecord(root["permissions"]);
  const mode = permissions?.["defaultMode"] ?? root["defaultMode"];
  if (typeof mode === "string") {
    lines.push(`sets the default permission mode to "${mode}"`);
  }
  if (lines.length === 0) lines.push("Claude settings that the SDK reads directly");
  return lines;
}

function describeRoles(raw: string): string[] {
  const root = asRecord(parseJson(raw));
  if (root === undefined) return ["unreadable role definitions"];
  const names = Object.keys(asRecord(root["roles"]) ?? root);
  return names.length > 0
    ? [`redefines agent roles: ${names.slice(0, 8).join(", ")}`]
    : ["redefines agent roles"];
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

interface Source {
  readonly kind: Finding["kind"];
  readonly path: string;
  readonly severity: Severity;
  readonly describe: (raw: string) => string[];
}

/** Skill and instruction files anywhere under the workspace, bounded. */
async function promptScopedFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const skillRoots = [".claude/skills", ".codex/skills", ".omc/skills", ".openswarm/skills"];
  for (const rel of skillRoots) {
    const dir = path.join(root, rel);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      found.push(path.join(dir, entry, "SKILL.md"));
    }
  }
  for (const rel of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"]) {
    found.push(path.join(root, rel));
  }
  return found;
}

/**
 * Enumerate what `root` contributes. Only workspace-scoped files are reported:
 * a candidate resolving to the user's home directory is the user's own
 * configuration and is not the repository's to answer for.
 */
export async function scanProvenance(root: string): Promise<Provenance> {
  // Symlink-resolved so one workspace has one identity: reaching the same repo
  // through a link should not be a second trust decision, nor a way to sidestep
  // an existing one. Only the root is canonicalized — candidates beneath it are
  // still judged lexically, per the note above.
  const resolved = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
  const opts = { cwd: resolved };

  const sources: Source[] = [];

  for (const p of mcpConfigCandidates(opts)) {
    if (!isWithin(p, resolved)) continue;
    sources.push({ kind: "mcp", path: p, severity: "execute", describe: describeMcp });
  }
  for (const c of hookConfigCandidates(opts)) {
    if (!isWithin(c.path, resolved)) continue;
    sources.push({
      kind: c.isSettingsJson ? "settings" : "hooks",
      path: c.path,
      severity: "execute",
      describe: c.isSettingsJson ? describeSettings : (raw) => describeHooks(raw, false),
    });
  }
  sources.push({
    kind: "roles",
    path: path.join(resolved, ".openswarm", "roles.json"),
    severity: "execute",
    describe: describeRoles,
  });
  for (const p of await promptScopedFiles(resolved)) {
    sources.push({
      kind: p.endsWith("SKILL.md") ? "skills" : "instructions",
      path: p,
      severity: "prompt",
      describe: () => [],
    });
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.path)) continue;
    seen.add(source.path);
    const raw = await readIfPresent(source.path);
    if (raw === null) continue;
    findings.push({
      kind: source.kind,
      path: source.path,
      display: path.relative(resolved, source.path) || source.path,
      severity: source.severity,
      sha256: sha256(raw),
      activates: source.severity === "execute" ? source.describe(raw) : [],
    });
  }

  findings.sort((a, b) => a.path.localeCompare(b.path));

  const material = findings
    .map((f) => (f.severity === "execute" ? `${f.display}\u0000${f.sha256}` : f.display))
    .join("\n");

  return {
    root: resolved,
    findings,
    digest: sha256(material),
    inert: !findings.some((f) => f.severity === "execute"),
  };
}

/** A prompt-ready description of what trusting this workspace would enable. */
export function summarize(p: Provenance): string[] {
  const lines: string[] = [];
  for (const f of p.findings) {
    if (f.severity !== "execute") continue;
    lines.push(`${f.display}:`);
    for (const a of f.activates) lines.push(`  ${a}`);
  }
  const prompts = p.findings.filter((f) => f.severity === "prompt");
  if (prompts.length > 0) {
    lines.push(
      `${prompts.length} instruction or skill file(s) will be read into the model's context:`,
    );
    for (const f of prompts.slice(0, 10)) lines.push(`  ${f.display}`);
    if (prompts.length > 10) lines.push(`  ...and ${prompts.length - 10} more`);
  }
  return lines;
}
