/**
 * stale-base.test.ts — uses real tiny git repos in tmpdir to exercise the
 * `check()` + `formatWarning()` surface. Cheap: a fresh repo + one commit.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { check, formatWarning } from "./stale-base.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-base-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  await fs.writeFile(path.join(dir, "f.txt"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: dir });
  return dir;
}

function head(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
    .toString()
    .trim();
}

describe("stale-base.check", () => {
  it("returns { kind: 'matches' } when HEAD equals expectedBase", async () => {
    const dir = await mkRepo();
    const h = head(dir);
    const result = await check({ cwd: dir, expectedBase: h });
    expect(result.kind).toBe("matches");
    expect(formatWarning(result)).toBeNull();
  });

  it("returns { kind: 'diverged' } with expected/actual when they differ", async () => {
    const dir = await mkRepo();
    const bogus = "0000000000000000000000000000000000000000";
    const result = await check({ cwd: dir, expectedBase: bogus });
    expect(result.kind).toBe("diverged");
    if (result.kind === "diverged") {
      expect(result.expected).toBe(bogus);
      expect(result.actual).toHaveLength(40);
    }
    const msg = formatWarning(result);
    expect(msg).toContain("base diverged");
    expect(msg).toContain(bogus);
  });

  it("returns { kind: 'no-expected-base' } when neither opts nor .openswarm-base provides one", async () => {
    const dir = await mkRepo();
    const result = await check({ cwd: dir });
    expect(result.kind).toBe("no-expected-base");
    expect(formatWarning(result)).toBeNull();
  });

  it("returns { kind: 'not-a-git-repo' } when cwd isn't a git repo", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-base-nogit-"));
    tmpDirs.push(dir);
    const result = await check({ cwd: dir, expectedBase: "abc123" });
    expect(result.kind).toBe("not-a-git-repo");
    expect(formatWarning(result)).toBeNull();
  });

  it("reads expectedBase from <cwd>/.openswarm-base when opts.expectedBase is absent", async () => {
    const dir = await mkRepo();
    const h = head(dir);
    await fs.writeFile(path.join(dir, ".openswarm-base"), h + "\n");
    const result = await check({ cwd: dir });
    expect(result.kind).toBe("matches");
  });
});
