import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  buildSeccompFilter,
  buildBwrapArgs,
  buildLandlockArgs,
  compileLandlockHelper,
  detectSandboxMode,
  resetSandboxDetection,
  spawnSandboxed,
  type SandboxConfig,
} from "./sandbox.js";

afterEach(() => {
  resetSandboxDetection();
});

const baseConfig: SandboxConfig = {
  writableRoots: [],
  cwd: "/home/user/project",
};

describe("buildSeccompFilter", () => {
  it("produces a valid BPF filter buffer", () => {
    const filter = buildSeccompFilter();
    // Each BPF instruction is 8 bytes
    expect(filter.length % 8).toBe(0);
    // Should have at least: arch check (3 insns) + syscall checks + allow + deny
    expect(filter.length).toBeGreaterThan(8 * 5);
  });

  it("first instruction loads arch field (offset 4)", () => {
    const filter = buildSeccompFilter();
    // BPF_LD | BPF_W | BPF_ABS = 0x20, k = 4
    expect(filter.readUInt16LE(0)).toBe(0x20);
    expect(filter.readUInt32LE(4)).toBe(4);
  });

  it("second instruction checks x86_64 arch", () => {
    const filter = buildSeccompFilter();
    // BPF_JMP | BPF_JEQ | BPF_K = 0x15, k = 0xC000003E
    expect(filter.readUInt16LE(8)).toBe(0x15);
    expect(filter.readUInt32LE(12)).toBe(0xc000003e);
  });

  it("last instruction returns ERRNO(EPERM)", () => {
    const filter = buildSeccompFilter();
    const lastOffset = filter.length - 8;
    // BPF_RET | BPF_K = 0x06
    expect(filter.readUInt16LE(lastOffset)).toBe(0x06);
    // SECCOMP_RET_ERRNO | EPERM = 0x00050001
    expect(filter.readUInt32LE(lastOffset + 4)).toBe(0x00050001);
  });

  it("second-to-last instruction returns ALLOW", () => {
    const filter = buildSeccompFilter();
    const offset = filter.length - 16;
    expect(filter.readUInt16LE(offset)).toBe(0x06);
    expect(filter.readUInt32LE(offset + 4)).toBe(0x7fff0000);
  });

  it("blocks 27+ syscalls", () => {
    const filter = buildSeccompFilter();
    const numInsns = filter.length / 8;
    // 3 (arch check) + N (blocked) + 2 (allow + deny) >= 32
    expect(numInsns).toBeGreaterThanOrEqual(32);
  });
});

describe("buildBwrapArgs", () => {
  it("includes read-only root bind", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    const roIdx = args.indexOf("--ro-bind");
    expect(roIdx).toBeGreaterThanOrEqual(0);
    expect(args[roIdx + 1]).toBe("/");
    expect(args[roIdx + 2]).toBe("/");
  });

  it("includes fresh /dev, /proc, /tmp", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");
    expect(args).toContain("--tmpfs");
  });

  it("includes writable bind for cwd", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    const bindIdx = args.indexOf("--bind");
    expect(bindIdx).toBeGreaterThanOrEqual(0);
    expect(args[bindIdx + 1]).toBe("/home/user/project");
  });

  it("includes namespace isolation", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--share-net");
  });

  it("omits --share-net when networkAccess is false", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], {
      ...baseConfig,
      networkAccess: false,
    });
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
  });

  it("includes safety flags", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  it("includes seccomp flag on x86_64", () => {
    if (os.arch() !== "x64") return;
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    expect(args).toContain("--seccomp");
    const secIdx = args.indexOf("--seccomp");
    expect(args[secIdx + 1]).toBe("3");
  });

  it("includes --chdir with cwd", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], baseConfig);
    const chdirIdx = args.indexOf("--chdir");
    expect(chdirIdx).toBeGreaterThanOrEqual(0);
    expect(args[chdirIdx + 1]).toBe("/home/user/project");
  });

  it("ends with separator and command", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "echo hi"], baseConfig);
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThanOrEqual(0);
    expect(args[sepIdx + 1]).toBe("/bin/bash");
    expect(args[sepIdx + 2]).toBe("-c");
    expect(args[sepIdx + 3]).toBe("echo hi");
  });

  it("adds additional writable roots", () => {
    const args = buildBwrapArgs("/bin/bash", ["-c", "ls"], {
      ...baseConfig,
      writableRoots: ["/data/shared"],
    });
    let bindCount = 0;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--bind") bindCount++;
    }
    expect(bindCount).toBeGreaterThanOrEqual(2);
  });
});

describe("buildLandlockArgs", () => {
  it("includes writable roots before separator", () => {
    const args = buildLandlockArgs(
      "/tmp/ll-helper",
      "/bin/bash",
      ["-c", "ls"],
      baseConfig,
    );
    expect(args[0]).toBe("/tmp/ll-helper");
    expect(args[1]).toBe("/home/user/project");
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(0);
    expect(args[sepIdx + 1]).toBe("/bin/bash");
    expect(args[sepIdx + 2]).toBe("-c");
    expect(args[sepIdx + 3]).toBe("ls");
  });

  it("includes additional writable roots", () => {
    const args = buildLandlockArgs(
      "/tmp/ll-helper",
      "/bin/bash",
      ["-c", "ls"],
      { ...baseConfig, writableRoots: ["/data"] },
    );
    expect(args).toContain("/data");
  });
});

describe("compileLandlockHelper", () => {
  it("compiles the helper binary", async () => {
    // Landlock is a Linux kernel feature (5.13+); the helper uses Linux-only
    // syscalls and requires -static linking which is unsupported on macOS.
    if (process.platform !== "linux") return;

    // This test requires gcc — skip if not available
    let hasGcc = false;
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("which", ["cc"], { stdio: "pipe" });
      hasGcc = true;
    } catch { /* */ }

    if (!hasGcc) return;

    resetSandboxDetection();
    const helperPath = await compileLandlockHelper();
    expect(helperPath).not.toBeNull();
    expect(fs.existsSync(helperPath!)).toBe(true);

    // Verify it's executable
    const stat = fs.statSync(helperPath!);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });
});

describe("detectSandboxMode", () => {
  it("returns a valid mode", async () => {
    const caps = await detectSandboxMode();
    expect(["bwrap", "landlock", "none"]).toContain(caps.mode);
  });

  it("caches the result", async () => {
    const caps1 = await detectSandboxMode();
    const caps2 = await detectSandboxMode();
    expect(caps1.mode).toBe(caps2.mode);
  });
});

describe("spawnSandboxed", () => {
  it("runs with policy=off (no sandbox)", async () => {
    const child = await spawnSandboxed(
      "/bin/echo",
      ["hello"],
      { stdio: "pipe" },
      { ...baseConfig, policy: "off" },
    );

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));

    await new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });

    const output = Buffer.concat(chunks).toString("utf8").trim();
    expect(output).toBe("hello");
  });

  it("throws with policy=require when no sandbox available", async () => {
    // Force no sandbox
    resetSandboxDetection();
    // detectSandboxMode will find whatever is actually available
    // We can't easily force "none" without mocking, so just verify the API shape
    const caps = await detectSandboxMode();
    if (caps.mode !== "none") {
      // Sandbox IS available — skip this test
      return;
    }

    await expect(
      spawnSandboxed(
        "/bin/echo",
        ["test"],
        { stdio: "pipe" },
        { ...baseConfig, policy: "require" },
      ),
    ).rejects.toThrow(/sandbox required/i);
  });

  it("runs with available sandbox (prefer mode)", async () => {
    const child = await spawnSandboxed(
      "/bin/echo",
      ["sandboxed"],
      { stdio: "pipe" },
      { ...baseConfig, cwd: os.tmpdir(), policy: "prefer" },
    );

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));

    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (c) => resolve(c));
    });

    const output = Buffer.concat(chunks).toString("utf8").trim();
    // With either sandbox mode or no sandbox, echo should succeed
    expect(output).toBe("sandboxed");
    expect(code).toBe(0);
  });

  it("can run bash inside sandbox", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-test-"));

    try {
      const child = await spawnSandboxed(
        "/bin/bash",
        ["-c", `echo "hello from sandbox" && pwd`],
        { stdio: ["ignore", "pipe", "pipe"] },
        { writableRoots: [], cwd: tmpDir, policy: "prefer" },
      );

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));

      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const output = Buffer.concat(chunks).toString("utf8");
      expect(output).toContain("hello from sandbox");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sandbox prevents writing outside writable roots", async () => {
    const caps = await detectSandboxMode();
    if (caps.mode === "none") return; // skip if no sandbox

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-write-"));

    try {
      // Try to write to /etc (read-only in both bwrap and Landlock)
      const child = await spawnSandboxed(
        "/bin/bash",
        ["-c", `touch /etc/swarm-sandbox-test 2>&1; echo "exit=$?"`],
        { stdio: ["ignore", "pipe", "pipe"] },
        { writableRoots: [], cwd: tmpDir, policy: "prefer" },
      );

      const chunks: Buffer[] = [];
      child.stdout?.on("data", (d: Buffer) => chunks.push(d));

      await new Promise<void>((resolve) => {
        child.on("close", () => resolve());
      });

      const output = Buffer.concat(chunks).toString("utf8");
      // With sandbox, the write should fail
      // bwrap: read-only filesystem
      // Landlock: EACCES
      expect(output).toMatch(/Permission denied|Read-only|Operation not permitted/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
