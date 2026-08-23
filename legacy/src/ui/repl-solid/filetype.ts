/**
 * filetype.ts — path → Tree-sitter filetype resolution (doc 49 Phase A).
 *
 * Node-safe on purpose: this module has NO `@opentui/core` import, so it can be
 * pulled into vitest-run code (e.g. tools/registry.ts and its vitest test)
 * without dragging in OpenTUI's `bun:ffi` bundle. The syntax-highlighting
 * machinery that DOES need OpenTUI lives in syntax.ts.
 *
 * The map is a pragmatic superset of the grammars we can highlight (the bundled
 * ts/js/markdown plus any registered via OPENSWARM_GRAMMAR_DIR). Unknown
 * extensions return undefined so callers fall back to plain text.
 */

const EXT_TO_FILETYPE: Readonly<Record<string, string>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",
  rb: "ruby",
  java: "java",
  zig: "zig",
};

const BASENAME_TO_FILETYPE: Readonly<Record<string, string>> = {
  Dockerfile: "dockerfile",
  Makefile: "make",
  "go.mod": "gomod",
  "go.sum": "gosum",
};

/**
 * Resolve a file path to a Tree-sitter filetype, or undefined when unknown.
 * Checks basename first (Dockerfile, Makefile…), then the file extension.
 */
export function filetypeFromPath(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash >= 0 ? path.slice(slash + 1) : path;

  const byName = BASENAME_TO_FILETYPE[base];
  if (byName !== undefined) return byName;

  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return undefined;
  return EXT_TO_FILETYPE[base.slice(dot + 1).toLowerCase()];
}
