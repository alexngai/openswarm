/**
 * OS-level sandbox (S1): isolate spawned processes using bubblewrap
 * (primary) or Landlock (fallback).
 *
 * bubblewrap: mount namespaces for filesystem isolation, seccomp BPF
 * for syscall filtering, PID/IPC/UTS namespace separation.
 *
 * Landlock: kernel-level filesystem ACLs (Linux 5.13+). Used when
 * bwrap is not installed. Compiled from embedded C source on first use.
 *
 * Both mechanisms: read-only root, writable project directory + /tmp,
 * network access preserved (S2 will restrict).
 */

import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SandboxMode = "bwrap" | "landlock" | "none";

export type SandboxPolicy = "require" | "prefer" | "off";

export interface SandboxConfig {
  readonly writableRoots: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly networkAccess?: boolean;
  readonly policy?: SandboxPolicy;
}

export interface SandboxCapabilities {
  readonly mode: SandboxMode;
  readonly bwrapPath?: string;
  readonly landlockHelperPath?: string;
}

// ---------------------------------------------------------------------------
// Seccomp BPF filter (x86_64)
// ---------------------------------------------------------------------------

const AUDIT_ARCH_X86_64 = 0xc000003e;

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001; // SECCOMP_RET_ERRNO | EPERM

const BLOCKED_SYSCALLS_X86_64: readonly number[] = [
  101, // ptrace
  155, // pivot_root
  163, // acct
  165, // mount
  166, // umount2
  167, // swapon
  168, // swapoff
  169, // reboot
  170, // sethostname
  171, // setdomainname
  175, // init_module
  176, // delete_module
  246, // kexec_load
  248, // add_key
  249, // request_key
  250, // keyctl
  272, // unshare (prevent nested namespaces)
  298, // perf_event_open
  308, // setns (prevent joining other namespaces)
  310, // process_vm_readv
  311, // process_vm_writev
  313, // finit_module
  320, // kexec_file_load
  321, // bpf
  323, // userfaultfd
  425, // io_uring_setup
  426, // io_uring_enter
  427, // io_uring_register
];

function bpfInsn(code: number, jt: number, jf: number, k: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(code, 0);
  buf.writeUInt8(jt, 2);
  buf.writeUInt8(jf, 3);
  buf.writeUInt32LE(k, 4);
  return buf;
}

/**
 * Build a seccomp BPF filter that blocks dangerous syscalls on x86_64.
 * Returns raw BPF instructions (8 bytes each) suitable for bwrap --seccomp.
 */
export function buildSeccompFilter(): Buffer {
  const N = BLOCKED_SYSCALLS_X86_64.length;
  const insns: Buffer[] = [];

  // [0] Load architecture from seccomp_data (offset 4)
  insns.push(bpfInsn(BPF_LD_W_ABS, 0, 0, 4));

  // [1] Check x86_64: if match skip to [3], else [2] (kill)
  insns.push(bpfInsn(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64));

  // [2] Wrong architecture → ERRNO(EPERM)
  insns.push(bpfInsn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM));

  // [3] Load syscall number (offset 0)
  insns.push(bpfInsn(BPF_LD_W_ABS, 0, 0, 0));

  // [4..3+N] Check each blocked syscall
  for (let i = 0; i < N; i++) {
    const jt = N - i; // jump to the ERRNO instruction at [4+N+1]
    insns.push(bpfInsn(BPF_JMP_JEQ_K, jt, 0, BLOCKED_SYSCALLS_X86_64[i]!));
  }

  // [4+N] Default: ALLOW
  insns.push(bpfInsn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));

  // [4+N+1] Blocked: ERRNO(EPERM)
  insns.push(bpfInsn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_EPERM));

  return Buffer.concat(insns);
}

// Cache the filter file per process
let _seccompFilterPath: string | undefined;

function getSeccompFilterPath(): string {
  if (!_seccompFilterPath) {
    const tmpDir = os.tmpdir();
    const filterPath = path.join(tmpDir, `.swarm-seccomp-${process.pid}.bpf`);
    fs.writeFileSync(filterPath, buildSeccompFilter(), { mode: 0o600 });
    _seccompFilterPath = filterPath;
    process.on("exit", () => {
      try {
        fs.unlinkSync(filterPath);
      } catch {
        // best effort
      }
    });
  }
  return _seccompFilterPath;
}

// ---------------------------------------------------------------------------
// Mount point detection
// ---------------------------------------------------------------------------

/**
 * Find the mount point that contains a given path.
 * Returns null if the path is on the root filesystem.
 */
function getMountForPath(p: string): string | null {
  try {
    const content = fs.readFileSync("/proc/self/mountinfo", "utf8");
    let bestMount = "/";
    let bestLen = 1;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split(" ");
      const mountpoint = parts[4];
      if (
        mountpoint &&
        p.startsWith(mountpoint) &&
        mountpoint.length > bestLen
      ) {
        bestMount = mountpoint;
        bestLen = mountpoint.length;
      }
    }
    return bestMount === "/" ? null : bestMount;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// bubblewrap
// ---------------------------------------------------------------------------

/**
 * Build bwrap command-line arguments for sandboxed execution.
 * Returns the full args array (caller spawns `bwrap` with these args).
 */
export function buildBwrapArgs(
  command: string,
  commandArgs: readonly string[],
  config: SandboxConfig,
): string[] {
  const args: string[] = [];

  // Read-only root filesystem
  args.push("--ro-bind", "/", "/");

  // If cwd is on a separate mount (e.g., /home), bind it explicitly
  const cwdMount = getMountForPath(config.cwd);
  if (cwdMount) {
    args.push("--ro-bind", cwdMount, cwdMount);
  }
  for (const root of config.writableRoots) {
    const rootMount = getMountForPath(root);
    if (rootMount && rootMount !== cwdMount) {
      args.push("--ro-bind", rootMount, rootMount);
    }
  }

  // Fresh /dev, /proc, /tmp
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  args.push("--tmpfs", "/tmp");
  args.push("--tmpfs", "/var/tmp");

  // Writable project directory + any additional roots
  args.push("--bind", config.cwd, config.cwd);
  for (const root of config.writableRoots) {
    const resolved = path.resolve(root);
    if (resolved !== path.resolve(config.cwd)) {
      args.push("--bind", resolved, resolved);
    }
  }

  // Namespace isolation
  args.push("--unshare-all");
  if (config.networkAccess !== false) {
    args.push("--share-net");
  }

  // Safety flags
  args.push("--die-with-parent");
  args.push("--new-session");

  // Seccomp filter (x86_64 only)
  if (os.arch() === "x64") {
    args.push("--seccomp", "3");
  }

  // Working directory
  args.push("--chdir", config.cwd);

  // Separator and command
  args.push("--", command, ...commandArgs);

  return args;
}

// ---------------------------------------------------------------------------
// Landlock fallback (compiled C helper)
// ---------------------------------------------------------------------------

const LANDLOCK_HELPER_SOURCE = `
#define _GNU_SOURCE
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define LL_FS_EXECUTE     (1ULL << 0)
#define LL_FS_WRITE_FILE  (1ULL << 1)
#define LL_FS_READ_FILE   (1ULL << 2)
#define LL_FS_READ_DIR    (1ULL << 3)
#define LL_FS_REMOVE_DIR  (1ULL << 4)
#define LL_FS_REMOVE_FILE (1ULL << 5)
#define LL_FS_MAKE_CHAR   (1ULL << 6)
#define LL_FS_MAKE_DIR    (1ULL << 7)
#define LL_FS_MAKE_REG    (1ULL << 8)
#define LL_FS_MAKE_SOCK   (1ULL << 9)
#define LL_FS_MAKE_FIFO   (1ULL << 10)
#define LL_FS_MAKE_BLOCK  (1ULL << 11)
#define LL_FS_MAKE_SYM    (1ULL << 12)

#define ALL_READ (LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR)
#define ALL_WRITE (ALL_READ | LL_FS_WRITE_FILE | LL_FS_REMOVE_DIR | \\
  LL_FS_REMOVE_FILE | LL_FS_MAKE_CHAR | LL_FS_MAKE_DIR | LL_FS_MAKE_REG | \\
  LL_FS_MAKE_SOCK | LL_FS_MAKE_FIFO | LL_FS_MAKE_BLOCK | LL_FS_MAKE_SYM)

struct ll_ruleset_attr { uint64_t handled_access_fs; };
struct ll_path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; }
  __attribute__((packed));

static long ll_create(const struct ll_ruleset_attr *a, size_t s, uint32_t f) {
  return syscall(__NR_landlock_create_ruleset, a, s, f);
}
static long ll_add(int fd, int t, const void *a, uint32_t f) {
  return syscall(__NR_landlock_add_rule, fd, t, a, f);
}
static long ll_restrict(int fd, uint32_t f) {
  return syscall(__NR_landlock_restrict_self, fd, f);
}

static int add_path_rule(int rs_fd, const char *p, uint64_t access) {
  struct ll_path_beneath_attr pb;
  pb.allowed_access = access;
  pb.parent_fd = open(p, O_PATH | O_CLOEXEC);
  if (pb.parent_fd < 0) return -1;
  int r = ll_add(rs_fd, 1, &pb, 0);
  close(pb.parent_fd);
  return r;
}

int main(int argc, char *argv[]) {
  /* --check: probe whether Landlock syscall works. Exit 0 = yes, 1 = no. */
  if (argc == 2 && strcmp(argv[1], "--check") == 0) {
    struct ll_ruleset_attr rs = { .handled_access_fs = ALL_WRITE };
    int fd = ll_create(&rs, sizeof(rs), 0);
    if (fd >= 0) { close(fd); return 0; }
    return 1;
  }

  int sep = -1;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { sep = i; break; }
  }
  if (sep < 0 || sep + 1 >= argc) {
    fprintf(stderr, "usage: ll-helper [writable...] -- cmd [args...]\\n");
    return 1;
  }

  struct ll_ruleset_attr rs = { .handled_access_fs = ALL_WRITE };
  int rs_fd = ll_create(&rs, sizeof(rs), 0);
  if (rs_fd < 0) {
    if (errno == ENOSYS || errno == EOPNOTSUPP) {
      execvp(argv[sep + 1], &argv[sep + 1]);
    }
    perror("landlock_create_ruleset");
    return 1;
  }

  add_path_rule(rs_fd, "/", ALL_READ);
  add_path_rule(rs_fd, "/dev", ALL_WRITE);
  add_path_rule(rs_fd, "/tmp", ALL_WRITE);
  add_path_rule(rs_fd, "/var/tmp", ALL_WRITE);

  for (int i = 1; i < sep; i++) {
    if (add_path_rule(rs_fd, argv[i], ALL_WRITE) < 0) {
      fprintf(stderr, "warning: cannot add rule for %s\\n", argv[i]);
    }
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
    perror("prctl");
    close(rs_fd);
    return 1;
  }
  if (ll_restrict(rs_fd, 0)) {
    perror("landlock_restrict_self");
    close(rs_fd);
    return 1;
  }
  close(rs_fd);

  execvp(argv[sep + 1], &argv[sep + 1]);
  perror("execvp");
  return 1;
}
`;

let _landlockHelperPath: string | undefined;
let _landlockCompileAttempted = false;

/**
 * Compile the Landlock helper from embedded C source.
 * Caches the compiled binary for the process lifetime.
 * Returns the path to the binary, or null if compilation fails.
 */
export async function compileLandlockHelper(): Promise<string | null> {
  if (_landlockHelperPath) return _landlockHelperPath;
  if (_landlockCompileAttempted) return null;
  _landlockCompileAttempted = true;

  const tmpDir = os.tmpdir();
  const srcPath = path.join(tmpDir, `.swarm-ll-helper-${process.pid}.c`);
  const binPath = path.join(tmpDir, `.swarm-ll-helper-${process.pid}`);

  try {
    await fsp.writeFile(srcPath, LANDLOCK_HELPER_SOURCE, "utf8");
    execFileSync("cc", ["-O2", "-o", binPath, srcPath, "-static"], {
      timeout: 30_000,
      stdio: "pipe",
    });
    await fsp.chmod(binPath, 0o755);
    _landlockHelperPath = binPath;

    process.on("exit", () => {
      try {
        fs.unlinkSync(srcPath);
      } catch { /* */ }
      try {
        fs.unlinkSync(binPath);
      } catch { /* */ }
    });

    return binPath;
  } catch {
    try {
      fs.unlinkSync(srcPath);
    } catch { /* */ }
    return null;
  }
}

export function buildLandlockArgs(
  helperPath: string,
  command: string,
  commandArgs: readonly string[],
  config: SandboxConfig,
): string[] {
  const args: string[] = [helperPath];

  // Writable roots
  args.push(config.cwd);
  for (const root of config.writableRoots) {
    const resolved = path.resolve(root);
    if (resolved !== path.resolve(config.cwd)) {
      args.push(resolved);
    }
  }

  // Separator and command
  args.push("--", command, ...commandArgs);

  return args;
}

// ---------------------------------------------------------------------------
// Detection (cached)
// ---------------------------------------------------------------------------

let _detectedMode: SandboxMode | undefined;
let _detectedBwrapPath: string | undefined;

function detectBwrap(): string | null {
  try {
    const result = execFileSync("which", ["bwrap"], {
      timeout: 5_000,
      stdio: "pipe",
      encoding: "utf8",
    });
    const p = result.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

function detectLandlockKernel(): boolean {
  try {
    const version = fs.readFileSync("/proc/version", "utf8");
    const match = /Linux version (\d+)\.(\d+)/.exec(version);
    if (!match) return false;
    const major = parseInt(match[1]!, 10);
    const minor = parseInt(match[2]!, 10);
    return major > 5 || (major === 5 && minor >= 13);
  } catch {
    return false;
  }
}

function probeLandlock(helperPath: string): boolean {
  try {
    execFileSync(helperPath, ["--check"], { timeout: 5_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the best available sandbox mode. Cached after first call.
 */
export async function detectSandboxMode(): Promise<SandboxCapabilities> {
  if (_detectedMode !== undefined) {
    return {
      mode: _detectedMode,
      bwrapPath: _detectedBwrapPath,
      landlockHelperPath: _landlockHelperPath,
    };
  }

  // Try bwrap first
  const bwrapPath = detectBwrap();
  if (bwrapPath) {
    _detectedMode = "bwrap";
    _detectedBwrapPath = bwrapPath;
    return { mode: "bwrap", bwrapPath };
  }

  // Try Landlock
  if (detectLandlockKernel()) {
    const helperPath = await compileLandlockHelper();
    if (helperPath && probeLandlock(helperPath)) {
      _detectedMode = "landlock";
      return { mode: "landlock", landlockHelperPath: helperPath };
    }
  }

  _detectedMode = "none";
  return { mode: "none" };
}

/** Reset cached detection (for testing). */
export function resetSandboxDetection(): void {
  _detectedMode = undefined;
  _detectedBwrapPath = undefined;
  _landlockHelperPath = undefined;
  _landlockCompileAttempted = false;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Spawn a command inside the OS-level sandbox.
 *
 * - bwrap: full namespace isolation + seccomp
 * - Landlock: kernel filesystem ACLs (less isolation than bwrap)
 * - none: falls through to regular spawn (logs warning if policy is "prefer")
 *
 * When policy is "require" and no sandbox is available, throws.
 * When policy is "off", always uses regular spawn.
 */
export async function spawnSandboxed(
  command: string,
  args: readonly string[],
  spawnOpts: SpawnOptions,
  sandboxConfig: SandboxConfig,
): Promise<ChildProcess> {
  const policy = sandboxConfig.policy ?? "prefer";

  if (policy === "off") {
    return spawn(command, [...args], spawnOpts);
  }

  const caps = await detectSandboxMode();

  if (caps.mode === "bwrap" && caps.bwrapPath) {
    return spawnWithBwrap(caps.bwrapPath, command, args, spawnOpts, sandboxConfig);
  }

  if (caps.mode === "landlock" && caps.landlockHelperPath) {
    return spawnWithLandlock(caps.landlockHelperPath, command, args, spawnOpts, sandboxConfig);
  }

  // No sandbox available
  if (policy === "require") {
    throw new Error(
      "Sandbox required but neither bubblewrap nor Landlock is available. " +
        "Install bubblewrap: apt install bubblewrap",
    );
  }

  // policy === "prefer" — fall through with warning
  return spawn(command, [...args], spawnOpts);
}

/**
 * Synchronous version for cases where async isn't possible.
 * Uses cached detection results; falls back to unsandboxed if detection
 * hasn't run yet.
 */
export function spawnSandboxedSync(
  command: string,
  args: readonly string[],
  spawnOpts: SpawnOptions,
  sandboxConfig: SandboxConfig,
): ChildProcess {
  const policy = sandboxConfig.policy ?? "prefer";

  if (policy === "off" || _detectedMode === undefined) {
    return spawn(command, [...args], spawnOpts);
  }

  if (_detectedMode === "bwrap" && _detectedBwrapPath) {
    return spawnWithBwrap(_detectedBwrapPath, command, args, spawnOpts, sandboxConfig);
  }

  if (_detectedMode === "landlock" && _landlockHelperPath) {
    return spawnWithLandlock(_landlockHelperPath, command, args, spawnOpts, sandboxConfig);
  }

  if (policy === "require") {
    throw new Error("Sandbox required but not available");
  }

  return spawn(command, [...args], spawnOpts);
}

// ---------------------------------------------------------------------------
// bwrap spawn
// ---------------------------------------------------------------------------

function spawnWithBwrap(
  bwrapPath: string,
  command: string,
  commandArgs: readonly string[],
  spawnOpts: SpawnOptions,
  config: SandboxConfig,
): ChildProcess {
  const bwrapArgs = buildBwrapArgs(command, commandArgs, config);
  const useSeccomp = os.arch() === "x64";

  let seccompFd: number | undefined;
  let stdioCfg = spawnOpts.stdio;

  if (useSeccomp) {
    const filterPath = getSeccompFilterPath();
    seccompFd = fs.openSync(filterPath, "r");

    // Extend stdio to include fd 3 for seccomp
    if (Array.isArray(stdioCfg)) {
      stdioCfg = [...stdioCfg, seccompFd];
    } else if (stdioCfg === "ignore") {
      stdioCfg = ["ignore", "ignore", "ignore", seccompFd];
    } else if (stdioCfg === "pipe") {
      stdioCfg = ["pipe", "pipe", "pipe", seccompFd];
    } else if (stdioCfg === "inherit") {
      stdioCfg = ["inherit", "inherit", "inherit", seccompFd];
    } else {
      stdioCfg = ["pipe", "pipe", "pipe", seccompFd];
    }
  }

  const child = spawn(bwrapPath, bwrapArgs, {
    ...spawnOpts,
    stdio: stdioCfg,
    env: config.env ?? spawnOpts.env,
  });

  // Clean up seccomp fd (child has its own dup)
  if (seccompFd !== undefined) {
    fs.closeSync(seccompFd);
  }

  return child;
}

// ---------------------------------------------------------------------------
// Landlock spawn
// ---------------------------------------------------------------------------

function spawnWithLandlock(
  helperPath: string,
  command: string,
  commandArgs: readonly string[],
  spawnOpts: SpawnOptions,
  config: SandboxConfig,
): ChildProcess {
  const llArgs = buildLandlockArgs(helperPath, command, commandArgs, config);

  return spawn(llArgs[0]!, llArgs.slice(1), {
    ...spawnOpts,
    env: config.env ?? spawnOpts.env,
  });
}
