/**
 * ProcessBroker — the single place openswarm launches an untrusted child.
 *
 * "Untrusted" here means the command, its arguments, or the code it will run
 * are influenced by something other than openswarm itself: a model-authored
 * shell command, a repository's hook script, an MCP server, a plugin. Git
 * plumbing and openswarm's own worker binary are not brokered; their argv is
 * ours and they are supervised elsewhere.
 *
 * Before this existed, each caller decided independently whether to isolate,
 * how to cancel, and whether to keep a handle. They decided differently, and
 * the differences were the bugs: a persistent shell that read a detection
 * cache and ran unconfined when it was cold, a timeout that killed a shell and
 * orphaned everything under it, background commands with no handle at all. A
 * chokepoint does not make those decisions correct on its own, but it makes
 * them decisions that are made once.
 *
 * What the broker guarantees:
 *
 *   - Isolation is resolved by awaiting detection, never by reading a cache
 *     that may be cold, and a `require` policy that cannot be satisfied
 *     refuses to spawn rather than downgrading.
 *   - Every child is a process-group leader, so cancelling one reaps the tree.
 *   - Every live child is in a registry, so nothing is unkillable and nothing
 *     outlives the session unnoticed.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  spawnSandboxed,
  detectSandboxMode,
  type SandboxMode,
  type SandboxPolicy,
} from "../tools/tier0/sandbox.js";
import { killProcessTree } from "./tree.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What kind of thing asked for this process. Recorded so `list()` can tell an
 * operator *why* something is running, and so diagnostics can distinguish a
 * runaway build from a wedged MCP server.
 */
export type ProcessKind = "shell" | "shell-session" | "hook" | "mcp" | "plugin";

export interface SpawnRequest {
  readonly kind: ProcessKind;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: SpawnOptions["stdio"];
  /** Additional directories the child may write to, beyond `cwd`. */
  readonly writableRoots?: readonly string[];
  readonly networkAccess?: boolean;
  readonly proxyUrl?: string;
  /** Short human description for diagnostics, e.g. the command line. */
  readonly label?: string;
}

export interface BrokeredProcess {
  readonly id: string;
  readonly child: ChildProcess;
  /** Isolation actually applied — not what was asked for. */
  readonly isolation: SandboxMode;
  /** Signal this child and everything it spawned. */
  kill(signal?: NodeJS.Signals): void;
}

export interface ProcessEntry {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly pid: number | undefined;
  readonly label: string;
  readonly isolation: SandboxMode;
  readonly startedAt: number;
}

/** Thrown when policy demands isolation the host cannot provide. */
export class IsolationUnavailableError extends Error {
  constructor(readonly platform: string) {
    super(
      `Sandbox policy is "require" but no isolation mechanism is available on ` +
        `${platform}. Install bubblewrap (apt install bubblewrap) or run with a ` +
        `sandbox policy of "prefer" to accept an unisolated child.`,
    );
    this.name = "IsolationUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export class ProcessBroker {
  private readonly live = new Map<string, { entry: ProcessEntry; child: ChildProcess }>();
  private policy: SandboxPolicy;
  private exitHookInstalled = false;

  constructor(policy: SandboxPolicy = "prefer") {
    this.policy = policy;
  }

  setPolicy(policy: SandboxPolicy): void {
    this.policy = policy;
  }

  getPolicy(): SandboxPolicy {
    return this.policy;
  }

  /**
   * Report the isolation a child would actually get right now.
   *
   * Callers use this to tell the truth in a UI or a doctor check. It awaits
   * detection rather than guessing, so asking the question is also what makes
   * the answer available to later spawns.
   */
  async effectiveIsolation(): Promise<{ mode: SandboxMode; satisfiesPolicy: boolean }> {
    if (this.policy === "off") return { mode: "none", satisfiesPolicy: true };
    const caps = await detectSandboxMode();
    return {
      mode: caps.mode,
      satisfiesPolicy: caps.mode !== "none" || this.policy !== "require",
    };
  }

  /**
   * Launch a child under the broker.
   *
   * Rejects rather than downgrading when policy is "require" and the host
   * offers nothing: a caller that asked for isolation and silently did not get
   * it is the failure mode this package exists to remove.
   */
  async spawn(req: SpawnRequest): Promise<BrokeredProcess> {
    const { mode, satisfiesPolicy } = await this.effectiveIsolation();
    if (!satisfiesPolicy) throw new IsolationUnavailableError(process.platform);

    const child = await spawnSandboxed(
      req.command,
      req.args ?? [],
      {
        cwd: req.cwd,
        // Every brokered child leads its own group so kill() reaps the tree.
        // Windows has no equivalent; killProcessTree walks it with taskkill.
        detached: process.platform !== "win32",
        stdio: req.stdio ?? ["ignore", "pipe", "pipe"],
        ...(req.env !== undefined && { env: req.env }),
      },
      {
        cwd: req.cwd,
        writableRoots: req.writableRoots ?? [],
        policy: this.policy,
        ...(req.env !== undefined && { env: req.env }),
        ...(req.networkAccess !== undefined && { networkAccess: req.networkAccess }),
        ...(req.proxyUrl !== undefined && { proxyUrl: req.proxyUrl }),
      },
    );

    const id = randomUUID();
    const entry: ProcessEntry = {
      id,
      kind: req.kind,
      pid: child.pid,
      label: req.label ?? `${req.command} ${(req.args ?? []).join(" ")}`.trim(),
      isolation: mode,
      startedAt: Date.now(),
    };

    this.live.set(id, { entry, child });
    const forget = () => this.live.delete(id);
    child.once("close", forget);
    child.once("error", forget);

    this.installExitHook();

    return {
      id,
      child,
      isolation: mode,
      kill: (signal: NodeJS.Signals = "SIGKILL") => {
        killProcessTree(child, signal);
      },
    };
  }

  /** Every child the broker still believes is running. */
  list(): readonly ProcessEntry[] {
    return [...this.live.values()].map((v) => v.entry);
  }

  /** Signal every live child's tree. Returns how many were signalled. */
  killAll(signal: NodeJS.Signals = "SIGKILL"): number {
    const victims = [...this.live.values()];
    for (const { child } of victims) killProcessTree(child, signal);
    return victims.length;
  }

  /**
   * Reap on the way out.
   *
   * Detaching children to gain process-group cancellation also detaches them
   * from our fate: they no longer die when our terminal group is signalled.
   * That trade is only acceptable if we take responsibility for them, which
   * this does. Registered on first spawn rather than at construction so
   * constructing a broker has no global effect.
   */
  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    registerForExitReaping(this);
  }
}

/**
 * Brokers that have launched something and therefore have children to reap.
 *
 * One shared listener rather than one per broker. A broker per listener works
 * until something replaces the process-wide broker — tests do, repeatedly —
 * at which point the old broker's listener stays installed for the life of the
 * process and Node starts warning about a leak that is real, if small.
 */
const reaping = new Set<ProcessBroker>();
let exitHookInstalled = false;

function registerForExitReaping(broker: ProcessBroker): void {
  reaping.add(broker);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Only synchronous work is possible in an "exit" handler, which is why
  // killProcessTree signals rather than waiting for children to be reaped.
  process.once("exit", () => {
    for (const b of reaping) b.killAll();
  });
}

// ---------------------------------------------------------------------------
// Process-wide default
// ---------------------------------------------------------------------------

let _default: ProcessBroker | undefined;

/**
 * The broker used by tools that have no other way to reach one.
 *
 * Tools are constructed far from the CLI that knows the sandbox policy, so a
 * process-wide instance is the pragmatic seam. It is a `let` rather than a
 * const so tests can replace it, and so the CLI can configure the policy once
 * at startup instead of threading it through every tool signature.
 */
export function getProcessBroker(): ProcessBroker {
  if (_default === undefined) _default = new ProcessBroker();
  return _default;
}

/** Replace the process-wide broker. For tests and for CLI startup. */
export function setProcessBroker(broker: ProcessBroker): void {
  _default = broker;
}
