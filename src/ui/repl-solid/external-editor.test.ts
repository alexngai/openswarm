/**
 * external-editor.test.ts — $EDITOR round-trip (doc 49 Phase E2).
 *
 * Uses a scripted non-interactive "editor" that appends a marker to the file so
 * we can assert the edited text is read back.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTextInEditor, editorCommand } from "./external-editor.js";

describe("external-editor", () => {
  const savedVisual = process.env.VISUAL;
  const savedEditor = process.env.EDITOR;
  const created: string[] = [];

  afterEach(() => {
    if (savedVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = savedVisual;
    if (savedEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = savedEditor;
    for (const d of created.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("returns an error when no editor is configured", () => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    expect(editorCommand()).toBeUndefined();
    const res = editTextInEditor("hello");
    expect("error" in res).toBe(true);
  });

  it("reads back text edited by the configured editor", () => {
    const dir = mkdtempSync(join(tmpdir(), "osw-editor-"));
    created.push(dir);
    const script = join(dir, "edit.sh");
    writeFileSync(script, '#!/bin/sh\nprintf "\\nINJECTED" >> "$1"\n');
    chmodSync(script, 0o755);
    delete process.env.VISUAL;
    process.env.EDITOR = script;

    const res = editTextInEditor("original");
    expect("value" in res).toBe(true);
    if ("value" in res) {
      expect(res.value).toContain("original");
      expect(res.value).toContain("INJECTED");
    }
  });
});
