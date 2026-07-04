/**
 * syntax.test.tsx — extra-grammar registration (doc 49 Phase A1).
 *
 * Uses bun:test (.tsx) because syntax.ts imports @opentui/core, which needs
 * Bun's runtime for bun:ffi. Node-safe path resolution is covered by
 * filetype.test.ts under vitest.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerExtraGrammars } from "./syntax.js";

describe("registerExtraGrammars", () => {
  const created: string[] = [];
  afterEach(() => {
    delete process.env.OPENSWARM_GRAMMAR_DIR;
    for (const dir of created.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function fakeClient() {
    const calls: unknown[] = [];
    return {
      calls,
      addFiletypeParser: (opts: unknown) => {
        calls.push(opts);
      },
    };
  }

  it("no-ops (returns 0) when OPENSWARM_GRAMMAR_DIR is unset", () => {
    const client = fakeClient();
    expect(registerExtraGrammars(client as never)).toBe(0);
    expect(client.calls).toHaveLength(0);
  });

  it("no-ops when the directory does not exist", () => {
    process.env.OPENSWARM_GRAMMAR_DIR = join(tmpdir(), "definitely-missing-xyz");
    const client = fakeClient();
    expect(registerExtraGrammars(client as never)).toBe(0);
  });

  it("registers a grammar subdir with .wasm + highlights.scm", () => {
    const root = mkdtempSync(join(tmpdir(), "osw-grammars-"));
    created.push(root);
    const py = join(root, "python");
    mkdirSync(py);
    writeFileSync(join(py, "tree-sitter-python.wasm"), "stub");
    writeFileSync(join(py, "highlights.scm"), "; stub");
    process.env.OPENSWARM_GRAMMAR_DIR = root;

    const client = fakeClient();
    expect(registerExtraGrammars(client as never)).toBe(1);
    const opts = client.calls[0] as {
      filetype: string;
      aliases?: string[];
      wasm: string;
      queries: { highlights: string[] };
    };
    expect(opts.filetype).toBe("python");
    expect(opts.aliases).toContain("py");
    expect(opts.wasm).toContain("tree-sitter-python.wasm");
    expect(opts.queries.highlights[0]).toContain("highlights.scm");
  });

  it("skips subdirs missing required files", () => {
    const root = mkdtempSync(join(tmpdir(), "osw-grammars-"));
    created.push(root);
    const incomplete = join(root, "nolang");
    mkdirSync(incomplete);
    writeFileSync(join(incomplete, "tree-sitter-nolang.wasm"), "stub");
    process.env.OPENSWARM_GRAMMAR_DIR = root;

    const client = fakeClient();
    expect(registerExtraGrammars(client as never)).toBe(0);
  });
});
