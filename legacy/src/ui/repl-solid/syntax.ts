/**
 * syntax.ts — shared Tree-sitter client + SyntaxStyle palettes (doc 49 Phase A).
 *
 * Centralizes what used to live inline in transcript.tsx so the assistant
 * markdown renderer AND the tool-output <code>/<diff> renderers share ONE
 * Tree-sitter client (getTreeSitterClient is a process singleton) and one set
 * of lazily-constructed, FFI-backed SyntaxStyle instances.
 *
 * Three exports matter to callers:
 *   - treeSitterClient()   — the shared, lazily-initialized client (or undefined
 *                            when disabled / init failed). Registers any extra
 *                            grammars found on disk right after core init.
 *   - markdownSyntaxStyle() — palette for assistant markdown markup scopes.
 *   - codeSyntaxStyle()     — palette for source-code capture groups, used by
 *                            <code> tool bodies and <diff> hunks.
 *   - filetypeFromPath()    — path/extension → filetype, delegating to OpenTUI's
 *                            resolve-ft tables (superset of anything we'd hand-roll).
 *
 * Grammar set (doc 49 A1): OpenTUI bundles typescript, javascript, markdown,
 * markdown_inline, zig. Additional grammars are opt-in via an on-disk assets
 * directory (see registerExtraGrammars) so we don't commit binary .wasm blobs
 * into the repo. Missing assets are a silent no-op — highlighting simply falls
 * back to plain text for unknown filetypes, never throwing.
 *
 * Disable everything via OPENSWARM_DISABLE_TREE_SITTER=1.
 */

import {
  SyntaxStyle,
  TreeSitterClient,
  getTreeSitterClient,
  type ThemeTokenStyle,
  type FiletypeParserOptions,
} from "@opentui/core";
import { theme } from "./theme.js";

// Re-export the node-safe path resolver so existing importers of
// `./syntax.js` keep working; the implementation lives in filetype.ts (which
// has no @opentui/core dependency, so vitest-run modules can use it).
export { filetypeFromPath } from "./filetype.js";

// ---------------------------------------------------------------------------
// SyntaxStyle palettes (lazy — first use mounts the FFI-backed style)
// ---------------------------------------------------------------------------

/**
 * Markdown scope → palette mapping. Scope names are the ones OpenTUI's
 * <markdown> emits internally for marked tokens.
 */
const markdownTheme: ThemeTokenStyle[] = [
  { scope: ["markup.heading"], style: { foreground: theme.accent, bold: true } },
  { scope: ["markup.strong"], style: { foreground: theme.text, bold: true } },
  { scope: ["markup.italic"], style: { foreground: theme.text, italic: true } },
  { scope: ["markup.strikethrough"], style: { foreground: theme.muted, dim: true } },
  { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.success } },
  { scope: ["markup.link", "markup.link.label"], style: { foreground: theme.accent, underline: true } },
  { scope: ["markup.link.url"], style: { foreground: theme.muted, underline: true } },
];

/**
 * Source-code capture group → palette mapping. Scope names follow the
 * nvim-treesitter capture convention emitted by the bundled highlights.scm
 * queries (keyword, string, comment, function, type, number, …). OpenTUI's
 * SyntaxStyle resolves more-specific scopes (e.g. keyword.return) down to the
 * base scope, so mapping the base groups covers the long tail.
 */
const codeTheme: ThemeTokenStyle[] = [
  { scope: ["keyword"], style: { foreground: theme.codeKeyword } },
  { scope: ["string"], style: { foreground: theme.codeString } },
  { scope: ["comment"], style: { foreground: theme.codeComment, italic: true } },
  { scope: ["number", "boolean"], style: { foreground: theme.codeNumber } },
  { scope: ["constant", "constant.builtin"], style: { foreground: theme.codeConstant } },
  { scope: ["function", "function.call", "function.method", "constructor"], style: { foreground: theme.codeFunction } },
  { scope: ["type", "type.builtin", "module"], style: { foreground: theme.codeType } },
  { scope: ["variable", "variable.member", "variable.parameter", "property"], style: { foreground: theme.codeVariable } },
  { scope: ["operator", "punctuation.bracket", "punctuation.delimiter", "punctuation.special"], style: { foreground: theme.codePunctuation } },
  { scope: ["attribute", "label"], style: { foreground: theme.codeType } },
];

let _markdownSyntaxStyle: SyntaxStyle | null = null;
export function markdownSyntaxStyle(): SyntaxStyle {
  if (_markdownSyntaxStyle === null) {
    _markdownSyntaxStyle = SyntaxStyle.fromTheme(markdownTheme);
  }
  return _markdownSyntaxStyle;
}

let _codeSyntaxStyle: SyntaxStyle | null = null;
export function codeSyntaxStyle(): SyntaxStyle {
  if (_codeSyntaxStyle === null) {
    _codeSyntaxStyle = SyntaxStyle.fromTheme(codeTheme);
  }
  return _codeSyntaxStyle;
}

// ---------------------------------------------------------------------------
// Shared Tree-sitter client + extra-grammar registration
// ---------------------------------------------------------------------------

/**
 * Directory holding opt-in grammar assets. Each immediate subdirectory named
 * for a filetype must contain `<name>.wasm` (or `tree-sitter-<name>.wasm`) and
 * `highlights.scm`; optional `injections.scm` is picked up when present.
 *
 * Override with OPENSWARM_GRAMMAR_DIR. Populate via `npm run grammars:update`
 * (see scripts) which downloads assets using OpenTUI's updateAssets(). When the
 * directory is absent, registration is a silent no-op.
 */
function grammarAssetsDir(): string | undefined {
  return process.env.OPENSWARM_GRAMMAR_DIR;
}

/** Alias map so common info-strings / extensions resolve to a grammar filetype. */
const GRAMMAR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  python: ["py"],
  bash: ["sh", "shell", "zsh"],
  yaml: ["yml"],
  rust: ["rs"],
  go: [],
  json: [],
  toml: [],
  c: ["h"],
  cpp: ["cc", "cxx", "hpp", "c++"],
  css: [],
  html: ["htm"],
  tsx: [],
  ruby: ["rb"],
  java: [],
};

/**
 * Discover and register extra grammar parsers from grammarAssetsDir(). Each
 * addFiletypeParser call is wrapped so a single malformed grammar can't abort
 * the rest or crash the REPL. Returns the number registered (0 when the dir is
 * unset/missing). Synchronous fs use is intentional: this runs once at startup
 * behind the fire-and-forget client init.
 */
export function registerExtraGrammars(client: TreeSitterClient): number {
  const dir = grammarAssetsDir();
  if (dir === undefined) return 0;
  let registered = 0;
  try {
    // Lazy require so the fs dependency never loads in non-TTY/headless paths.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ft = entry.name;
      const subdir = path.join(dir, ft);
      const files = fs.readdirSync(subdir);
      const wasm = files.find((f) => f.endsWith(".wasm"));
      const highlights = files.find((f) => f === "highlights.scm");
      if (wasm === undefined || highlights === undefined) continue;
      const injections = files.find((f) => f === "injections.scm");
      const opts: FiletypeParserOptions = {
        filetype: ft,
        aliases: GRAMMAR_ALIASES[ft] ? [...GRAMMAR_ALIASES[ft]] : undefined,
        wasm: path.join(subdir, wasm),
        queries: {
          highlights: [path.join(subdir, highlights)],
          ...(injections !== undefined
            ? { injections: [path.join(subdir, injections)] }
            : {}),
        },
      };
      try {
        client.addFiletypeParser(opts);
        registered += 1;
      } catch {
        // Skip this grammar; keep going with the rest.
      }
    }
  } catch {
    // fs/require unavailable or dir unreadable — degrade to core grammars only.
    return registered;
  }
  return registered;
}

// `undefined` = not yet attempted; client instance = success or pending init;
// `null` = attempted and failed terminally — don't retry.
let _treeSitterClient: TreeSitterClient | null | undefined = undefined;

/**
 * Shared, lazily-initialized Tree-sitter client. First caller triggers
 * fire-and-forget init; extra grammars are registered once init resolves.
 * Returns undefined when disabled or when construction throws.
 */
export function treeSitterClient(): TreeSitterClient | undefined {
  if (process.env.OPENSWARM_DISABLE_TREE_SITTER === "1") return undefined;
  if (_treeSitterClient !== undefined) return _treeSitterClient ?? undefined;
  try {
    const client = getTreeSitterClient();
    void client
      .initialize()
      .then(() => {
        registerExtraGrammars(client);
      })
      .catch(() => {
        _treeSitterClient = null;
      });
    _treeSitterClient = client;
    return client;
  } catch {
    _treeSitterClient = null;
    return undefined;
  }
}
