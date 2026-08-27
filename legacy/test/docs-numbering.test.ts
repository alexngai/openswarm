/**
 * Doc numbering and cross-reference integrity.
 *
 * `docs/` is numbered, and the number is how every reference in the tree points
 * at a document: source comments cite `docs/67 §A5`, the roadmap links
 * `./60-gap-regime-findings.md`, CI cites `docs/55`. Two documents claiming one
 * number makes those references ambiguous, and renaming a document without
 * following its references makes them dangle.
 *
 * Both have already happened. Two documents were numbered 55 and two were
 * numbered 63; resolving that moved files without updating the prose that
 * pointed at them, leaving the gap-regime and composition-sweep findings cited
 * by their old numbers, which by then belonged to nothing. A reference to a
 * missing document is not a broken link a reader can work around — it silently
 * reads as "that analysis doesn't exist", which is the opposite of what the
 * citing sentence claims. (Naming those stale numbers here would make this file
 * fail its own check, which is the check working.)
 *
 * This runs as a test rather than as a script so the check is enforced by
 * `npm test` and CI without anybody remembering to invoke it, which is the
 * property the previous renames lacked.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const docsDir = path.join(repoRoot, "docs");

/** Files that exist, keyed by the leading number. */
function docsByNumber(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const name of fs.readdirSync(docsDir)) {
    if (!name.endsWith(".md")) continue;
    const m = /^(\d+)-/.exec(name);
    if (m === null) continue;
    const key = m[1]!;
    out.set(key, [...(out.get(key) ?? []), name]);
  }
  return out;
}

/** Tracked text files, so untracked scratch notes cannot fail the suite. */
function trackedTextFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => f !== "");

  const binary = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|mp4|wasm)$/i;
  return listed.filter((f) => {
    if (binary.test(f)) return false;
    const p = path.join(repoRoot, f);
    // Lockfiles are enormous and never cite documents.
    if (f === "package-lock.json" || f === "bun.lock") return false;
    return fs.existsSync(p) && fs.statSync(p).isFile();
  });
}

interface Reference {
  readonly file: string;
  readonly line: number;
  readonly raw: string;
  /** The doc number cited. */
  readonly number: string;
  /** Full filename when the reference named one, else null. */
  readonly filename: string | null;
}

/**
 * Three reference shapes appear in the tree, and all three have to resolve:
 * `docs/NN-name.md` (explicit), a markdown link `](./NN-name.md)` relative to
 * `docs/`, and a bare `docs/NN` used when prose cites a document by number.
 */
function collectReferences(): Reference[] {
  const full = /docs\/(\d+)-([A-Za-z0-9._-]+\.md)/g;
  const rel = /\]\(\.\/?(\d+)-([A-Za-z0-9._-]+\.md)\)/g;
  // Negative lookahead so `docs/67-product-parity...` is not also read as a bare
  // `docs/67`, and so `docs/6` inside a longer number is not split.
  const bare = /docs\/(\d{2})(?![\d\-A-Za-z])/g;

  const refs: Reference[] = [];
  for (const file of trackedTextFiles()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    if (!text.includes("docs/") && !text.includes("](./")) continue;

    text.split("\n").forEach((lineText, i) => {
      const at = (raw: string, number: string, filename: string | null): Reference => ({
        file,
        line: i + 1,
        raw,
        number,
        filename,
      });
      for (const m of lineText.matchAll(full)) {
        refs.push(at(m[0]!, m[1]!, `${m[1]}-${m[2]}`));
      }
      // Relative links only mean a doc when the citing file is itself in docs/.
      if (path.dirname(file) === "docs") {
        for (const m of lineText.matchAll(rel)) {
          refs.push(at(m[0]!, m[1]!, `${m[1]}-${m[2]}`));
        }
      }
      for (const m of lineText.matchAll(bare)) {
        refs.push(at(m[0]!, m[1]!, null));
      }
    });
  }
  return refs;
}

describe("docs numbering", () => {
  it("gives every document a unique number", () => {
    const collisions = [...docsByNumber()]
      .filter(([, names]) => names.length > 1)
      .map(([n, names]) => `${n}: ${names.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("resolves every reference to a document that exists", () => {
    const byNumber = docsByNumber();
    const dangling = collectReferences()
      .filter((ref) =>
        ref.filename !== null
          ? !fs.existsSync(path.join(docsDir, ref.filename))
          : !byNumber.has(ref.number),
      )
      // One line per miss, so a failure names the file to fix rather than a count.
      .map((ref) => `${ref.file}:${ref.line} -> ${ref.raw}`);
    expect([...new Set(dangling)]).toEqual([]);
  });

  it("finds the references it claims to check", () => {
    // Guards the regexes themselves: a pattern that silently stops matching
    // would make both checks above pass by finding nothing at all.
    const refs = collectReferences();
    expect(refs.length).toBeGreaterThan(50);
    expect(refs.some((r) => r.filename !== null)).toBe(true);
    expect(refs.some((r) => r.filename === null)).toBe(true);
    // The roadmap is cited from source comments; if that stops being true the
    // bare-reference pattern has probably drifted.
    expect(refs.some((r) => r.number === "67")).toBe(true);
  });
});
