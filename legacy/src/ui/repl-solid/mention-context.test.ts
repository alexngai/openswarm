/**
 * mention-context.test.ts — @-mention → engine context (doc 49 Phase D1).
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMentionContext } from "./mention-context.js";

describe("buildMentionContext", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("returns empty string for no files", () => {
    expect(buildMentionContext([])).toBe("");
  });

  it("wraps file contents in <file> tags with the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "osw-mention-"));
    created.push(dir);
    const f = join(dir, "a.ts");
    writeFileSync(f, "const a = 1;");
    const out = buildMentionContext([f]);
    expect(out).toContain("Referenced files:");
    expect(out).toContain(`<file path="${f}">`);
    expect(out).toContain("const a = 1;");
    expect(out).toContain("</file>");
  });

  it("notes unreadable files inline instead of throwing", () => {
    const missing = join(tmpdir(), "definitely-missing-osw.ts");
    const out = buildMentionContext([missing]);
    expect(out).toContain(missing);
    expect(out).toContain("error=");
  });
});
