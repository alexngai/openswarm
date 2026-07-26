import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceAuthority, PathEscapeError } from "./workspace-authority.js";

describe("WorkspaceAuthority", () => {
  let root: string;
  let outside: string;
  let authority: WorkspaceAuthority;

  beforeEach(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openswarm-ws-"));
    root = path.join(base, "workspace");
    outside = path.join(base, "outside");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    authority = new WorkspaceAuthority(root);
    await authority.init();
  });

  afterEach(async () => {
    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });

  describe("canonicalization", () => {
    it("resolves a relative path against the workspace root", async () => {
      const result = await authority.canonicalize("src/index.ts");
      expect(result.relative).toBe("src/index.ts");
      expect(result.workspaceRoot).toBe(authority.workspaceRoot);
      expect(path.isAbsolute(result.canonical)).toBe(true);
    });

    it("resolves the root itself to an empty relative path", async () => {
      expect((await authority.canonicalize(".")).relative).toBe("");
    });

    it("canonicalizes a path that does not exist yet", async () => {
      // A create has to get containment right before the file is there.
      const result = await authority.canonicalize("does/not/exist/yet.txt");
      expect(result.relative).toBe("does/not/exist/yet.txt");
    });

    it("collapses traversal that stays inside the workspace", async () => {
      expect((await authority.canonicalize("a/../b.txt")).relative).toBe("b.txt");
    });
  });

  describe("containment", () => {
    it("rejects traversal above the workspace root", async () => {
      await expect(authority.canonicalize("../outside/secret.txt")).rejects.toThrow(
        PathEscapeError,
      );
    });

    it("rejects an absolute path outside the workspace", async () => {
      await expect(authority.canonicalize(path.join(outside, "secret.txt"))).rejects.toThrow(
        PathEscapeError,
      );
    });

    it("rejects a path whose leaf is a symlink pointing out", async () => {
      await fs.writeFile(path.join(outside, "secret.txt"), "s3cret");
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

      await expect(authority.canonicalize("link.txt")).rejects.toThrow(PathEscapeError);
    });

    it("rejects a path whose parent directory is a symlink pointing out", async () => {
      // The case the per-tool isUnderCwd check misses: nothing about the leaf
      // is a symlink, so a leaf-only realpath never fires.
      await fs.mkdir(path.join(outside, "escape"));
      await fs.writeFile(path.join(outside, "escape", "secret.txt"), "s3cret");
      await fs.symlink(path.join(outside, "escape"), path.join(root, "hop"));

      await expect(authority.canonicalize("hop/secret.txt")).rejects.toThrow(PathEscapeError);
    });

    it("rejects a not-yet-existing file under a symlinked parent", async () => {
      await fs.mkdir(path.join(outside, "escape"));
      await fs.symlink(path.join(outside, "escape"), path.join(root, "hop"));

      await expect(authority.canonicalize("hop/new-file.txt")).rejects.toThrow(PathEscapeError);
    });

    it("allows a symlink that stays inside the workspace", async () => {
      await fs.mkdir(path.join(root, "real"));
      await fs.writeFile(path.join(root, "real", "file.txt"), "ok");
      await fs.symlink(path.join(root, "real"), path.join(root, "alias"));

      const result = await authority.canonicalize("alias/file.txt");
      expect(result.relative).toBe("real/file.txt");
    });

    it("rejects a path containing a null byte", async () => {
      await expect(authority.canonicalize("bad\0name.txt")).rejects.toThrow(PathEscapeError);
    });

    it("refuses to operate before init", async () => {
      const uninitialized = new WorkspaceAuthority(root);
      expect(() => uninitialized.workspaceRoot).toThrow(/init\(\) must run/);
    });
  });

  describe("identity and compare-and-swap", () => {
    it("hashes an existing file", async () => {
      await fs.writeFile(path.join(root, "a.txt"), "hello");
      const identity = await authority.identify(await authority.canonicalize("a.txt"));

      expect(identity.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(identity.sizeBytes).toBe(5);
    });

    it("reports an absent file as all-null rather than failing", async () => {
      const identity = await authority.identify(await authority.canonicalize("missing.txt"));
      expect(identity.contentHash).toBeNull();
      expect(identity.sizeBytes).toBeNull();
    });

    it("matches an unchanged file and rejects a modified one", async () => {
      const target = await authority.canonicalize("a.txt");
      await fs.writeFile(target.canonical, "before");
      const expected = await authority.identify(target);

      expect(await authority.matches(expected)).toBe(true);

      await fs.writeFile(target.canonical, "after");
      expect(await authority.matches(expected)).toBe(false);
    });

    it("treats creation of an expected-absent file as a mismatch", async () => {
      const target = await authority.canonicalize("new.txt");
      const expected = await authority.identify(target);

      await fs.writeFile(target.canonical, "someone got there first");
      expect(await authority.matches(expected)).toBe(false);
    });
  });

  describe("generation", () => {
    it("starts at 1 and advances on demand", async () => {
      expect(authority.generation).toBe(1);
      expect(authority.bumpGeneration()).toBe(2);
      expect(authority.generation).toBe(2);
    });
  });
});
