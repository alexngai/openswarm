/**
 * Generated path-escape corpus (docs/67 WP-03, FX-PATH-001..020).
 *
 * The hand-written containment tests each encode a gap someone already
 * thought of. This one is built the other way round: generate paths from
 * primitives that compose — traversal noise, link shapes, case and
 * normalization variants — and decide each verdict against the filesystem
 * rather than against the code that produced it.
 *
 * The oracle matters more than the count. Asking `canonicalize` whether it
 * agrees with itself proves nothing, so an allowed path is *used*: bytes are
 * written through it with link-following semantics, and the file that results
 * is realpath'd once it exists. A realpath over an existing file needs no
 * ancestor reasoning, which is exactly the reasoning under test, so the two
 * can disagree — and when they do, the write already landed somewhere, which
 * is the fact worth reporting.
 *
 * Link-following writes are deliberate even though `write_file` renames into
 * place and therefore replaces a link instead of traversing it. Containment
 * has to hold for the most permissive write a tool might perform, not the
 * safest one, and `edit_file` and the notebook tools are not all renames.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInWorkspace, resetWorkspaceAuthorities } from "./workspace-path.js";

/** Fixed so a failure names a seed that reproduces it exactly. */
const SEED = 0x5eed_03;
const CASES = 10_000;

/** Marker planted outside the workspace; reading it back is a containment failure. */
const SECRET = "s3cret-outside-marker";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

let workspace: string;
let outside: string;
let realWorkspace: string;

/**
 * The twenty named shapes (FX-PATH-001..020). Each is a directory entry in the
 * workspace whose resolution is interesting for a different reason; the
 * generator layers noise on top of these rather than inventing link topologies
 * at random, so a failing case is always attributable to one shape.
 */
const SHAPES = [
  "real/file.txt", // 001 ordinary file
  "real", // 002 ordinary directory
  "alias", // 003 in-workspace directory link
  "alias-file.txt", // 004 in-workspace file link
  "out-leaf.txt", // 005 leaf link pointing out
  "out-dir", // 006 directory link pointing out
  "out-dir/secret.txt", // 007 file beneath a directory link pointing out
  "dangle-out.txt", // 008 broken link whose target is outside
  "dangle-out-dir", // 009 broken directory link pointing out
  "dangle-out-dir/new.txt", // 010 creation beneath a broken outward link
  "dangle-in.txt", // 011 broken link whose target is inside
  "chain-out", // 012 link chain ending outside
  "chain-in", // 013 link chain ending inside
  "cycle-a", // 014 mutual link cycle
  "self", // 015 self-referential link
  "nested/deep/climb", // 016 relative link climbing out of the workspace
  "rel-dangle.txt", // 017 relative broken link climbing out
  "fs-root", // 018 link to the filesystem root
  "tmp-link", // 019 link to a shared system directory
  "absent/never/here.txt", // 020 path with no existing ancestor at all
] as const;

function buildFixtures(): void {
  fs.mkdirSync(path.join(workspace, "real"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "real", "file.txt"), "inside");
  fs.mkdirSync(path.join(workspace, "nested", "deep"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "caf\u00e9"), { recursive: true }); // NFC
  fs.mkdirSync(path.join(workspace, "with space"), { recursive: true });

  fs.writeFileSync(path.join(outside, "secret.txt"), SECRET);
  fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
  fs.writeFileSync(path.join(outside, "sub", "secret.txt"), SECRET);

  const link = (from: string, to: string): void => {
    fs.symlinkSync(to, path.join(workspace, from));
  };

  link("alias", path.join(workspace, "real"));
  link("alias-file.txt", path.join(workspace, "real", "file.txt"));
  link("out-leaf.txt", path.join(outside, "secret.txt"));
  link("out-dir", outside);
  link("dangle-out.txt", path.join(outside, "absent.txt"));
  link("dangle-out-dir", path.join(outside, "absent-dir"));
  link("dangle-in.txt", path.join(workspace, "not-yet.txt"));

  link("chain-out", path.join(workspace, "chain-out-2"));
  link("chain-out-2", path.join(workspace, "chain-out-3"));
  link("chain-out-3", path.join(outside, "absent.txt"));

  link("chain-in", path.join(workspace, "chain-in-2"));
  link("chain-in-2", path.join(workspace, "chain-in-3"));
  link("chain-in-3", path.join(workspace, "real", "file.txt"));

  link("cycle-a", path.join(workspace, "cycle-b"));
  link("cycle-b", path.join(workspace, "cycle-a"));
  link("self", path.join(workspace, "self"));

  fs.symlinkSync("../../../outside-target", path.join(workspace, "nested", "deep", "climb"));
  link("rel-dangle.txt", "../outside-target/absent.txt");
  link("fs-root", path.sep);
  link("tmp-link", os.tmpdir());
}

/** Traversal that cancels out, and traversal that does not. */
const NOISE = [
  "",
  "./",
  ".//",
  "real/../",
  "nested/../",
  "./././",
  "alias/../",
  "with space/../",
] as const;

const SUFFIX = ["", "/", "/.", "/..", "/../x.txt", "/sub/secret.txt", "/x.txt"] as const;

const PREFIX = ["", "../", "../../", "nested/deep/../../"] as const;

function generate(rand: () => number): string {
  const shape = SHAPES[Math.floor(rand() * SHAPES.length)] as string;
  const noise = NOISE[Math.floor(rand() * NOISE.length)] as string;
  const suffix = SUFFIX[Math.floor(rand() * SUFFIX.length)] as string;
  const prefix = PREFIX[Math.floor(rand() * PREFIX.length)] as string;

  let candidate = `${prefix}${noise}${shape}${suffix}`;

  const roll = rand();
  if (roll < 0.25) {
    candidate = path.join(workspace, candidate); // absolute form
  } else if (roll < 0.3) {
    // Case flip: a no-op on Linux, a distinct path on a case-folding volume.
    candidate = candidate.toUpperCase();
  } else if (roll < 0.35) {
    // NFD form of the accented fixture, which is a different byte string.
    candidate = candidate.normalize("NFD");
  } else if (roll < 0.4) {
    candidate = `${candidate}${"/.".repeat(1 + Math.floor(rand() * 4))}`;
  }

  return candidate;
}

describe("generated path-escape corpus", () => {
  beforeAll(() => {
    resetWorkspaceAuthorities();
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "corpus-"));
    workspace = path.join(base, "workspace");
    // Named to match the ../../../outside-target links built above.
    outside = path.join(base, "outside-target");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    realWorkspace = fs.realpathSync(workspace);
    buildFixtures();
  });

  afterAll(() => {
    resetWorkspaceAuthorities();
    fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
  });

  it(`grants no unauthorized access across ${CASES} generated paths`, async () => {
    const rand = mulberry32(SEED);

    const escapes: string[] = [];
    const leaks: string[] = [];
    let allowed = 0;
    let refused = 0;

    for (let i = 0; i < CASES; i += 1) {
      const candidate = generate(rand);

      let verdict;
      try {
        verdict = await resolveInWorkspace(candidate, workspace);
      } catch (err) {
        // A containment helper that throws is a containment helper the caller
        // will not have handled; that is a failure, not an exemption.
        escapes.push(`${candidate} :: threw ${(err as Error).message}`);
        continue;
      }

      if (!verdict.ok) {
        refused += 1;
        continue;
      }
      allowed += 1;

      // Reading is the cheaper probe: if the secret comes back, the path
      // reached outside regardless of what any subsequent write would do.
      try {
        const seen = fs.readFileSync(verdict.path, "utf8");
        if (seen.includes(SECRET)) leaks.push(candidate);
      } catch {
        // Absent, a directory, or unreadable — nothing observed, nothing leaked.
      }

      // Writing with link-following semantics, then realpathing the file that
      // now exists. Ground truth needs no ancestor walk once the file is real.
      try {
        fs.writeFileSync(verdict.path, `probe-${i}`);
      } catch {
        continue; // EISDIR, ENOENT under an absent parent, ELOOP: nothing landed.
      }
      try {
        const landed = fs.realpathSync(verdict.path);
        if (!isWithin(landed, realWorkspace)) {
          escapes.push(`${candidate} :: wrote to ${landed}`);
        }
      } catch (err) {
        escapes.push(`${candidate} :: wrote but could not verify (${(err as Error).message})`);
      }
    }

    expect({ escapes: escapes.slice(0, 10), leaks: leaks.slice(0, 10) }).toEqual({
      escapes: [],
      leaks: [],
    });

    // A helper that refuses everything would satisfy the assertions above, so
    // the corpus is only meaningful if it also grants a substantial share.
    expect(allowed).toBeGreaterThan(CASES * 0.1);
    expect(refused).toBeGreaterThan(CASES * 0.1);
  });

  it("leaves nothing outside the workspace after the corpus runs", () => {
    // A path that escapes without being read or realpathed still leaves a
    // trace. Two entries were planted; anything else was created by a probe.
    const entries = fs.readdirSync(outside).sort();
    expect(entries).toEqual(["secret.txt", "sub"]);
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe(SECRET);
    expect(fs.readdirSync(path.join(outside, "sub"))).toEqual(["secret.txt"]);
  });

  it("decides every named shape without throwing", async () => {
    // FX-PATH-001..020: the generator only layers noise onto these, so a shape
    // that cannot be decided at all would silently narrow everything above.
    for (const shape of SHAPES) {
      await expect(resolveInWorkspace(shape, workspace)).resolves.toBeDefined();
    }
  });

  it("refuses every shape that resolves outside, and allows every shape that does not", async () => {
    const mustRefuse = [
      "out-leaf.txt",
      "out-dir",
      "out-dir/secret.txt",
      "dangle-out.txt",
      "dangle-out-dir",
      "dangle-out-dir/new.txt",
      "chain-out",
      "cycle-a",
      "self",
      "nested/deep/climb",
      "rel-dangle.txt",
      "fs-root",
      "tmp-link",
    ];
    const mustAllow = [
      "real/file.txt",
      "real",
      "alias",
      "alias-file.txt",
      "dangle-in.txt",
      "chain-in",
      "absent/never/here.txt",
    ];

    for (const shape of mustRefuse) {
      expect({ shape, ok: (await resolveInWorkspace(shape, workspace)).ok }).toEqual({
        shape,
        ok: false,
      });
    }
    for (const shape of mustAllow) {
      expect({ shape, ok: (await resolveInWorkspace(shape, workspace)).ok }).toEqual({
        shape,
        ok: true,
      });
    }
  });
});
