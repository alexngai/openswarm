/**
 * The workspace trust gate.
 *
 * @security This decision must be reached before any workspace configuration
 * is loaded, and nothing the workspace says may influence it. Both shipped
 * agents that have attempted this got the ordering wrong rather than the
 * policy wrong, and each mistake was a CVE:
 *
 *   - CVE-2025-59536 (Claude Code < 1.0.111) executed project code before the
 *     trust dialog was accepted.
 *   - CVE-2026-33068 (Claude Code < 2.1.53) read the repository's settings
 *     first, so a repo setting `defaultMode: bypassPermissions` put the
 *     session in a permissive mode, and the permissive mode caused the dialog
 *     to be skipped. The repository talked its way out of its own gate.
 *
 * OpenCode has no trust gate at all; the report is sst/opencode#6361, closed
 * by a stale bot rather than by a fix.
 *
 * Two properties keep those failures out. First, `resolveTrust` reads only the
 * user-level trust store and the *hashes* of workspace files, never their
 * settings, so there is no repository-supplied value on the path to the
 * decision. Second, the result is inert data — a `TrustDecision`, not a mode
 * or a permission level — and `buildAgentRuntime` requires one, so a caller
 * cannot assemble a runtime without having asked. The gate cannot be skipped
 * by forgetting it; it has to be passed something.
 */

import { scanProvenance, summarize, type Provenance } from "./provenance.js";
import { TrustStore, type TrustScope } from "./store.js";

/**
 * The answer, as data. Deliberately not a permission mode: a mode invites the
 * question "can configuration change it?", which is exactly how CVE-2026-33068
 * happened.
 */
export interface TrustDecision {
  /** Whether configuration inside the workspace may be read at all. */
  readonly allowWorkspaceConfig: boolean;
  readonly reason:
    | "trusted"
    | "granted"
    | "inert"
    | "declined"
    | "non-interactive"
    | "disabled";
  readonly provenance: Provenance;
}

/** How the user answered. `deny` exits; the CLI does not run degraded on a refusal. */
export type TrustAnswer =
  | { readonly kind: "trust"; readonly scope: TrustScope }
  | { readonly kind: "deny" };

export type TrustPrompt = (
  provenance: Provenance,
  /** "unknown" on a first visit, "stale" when trusted config has since changed. */
  situation: "unknown" | "stale",
) => Promise<TrustAnswer>;

export interface ResolveTrustOptions {
  readonly cwd: string;
  /** Absent in non-interactive runs; its absence is what denies. */
  readonly prompt?: TrustPrompt;
  readonly store?: TrustStore;
  /** Pre-trust for CI. Mirrors OpenCode's OPENCODE_DISABLE_PROJECT_CONFIG. */
  readonly envOverrides?: NodeJS.ProcessEnv;
}

/** Set to opt a known-good automated environment out of the prompt. */
export const TRUST_ENV = "OPENSWARM_TRUST_WORKSPACE";
/** Set to refuse workspace configuration outright, prompt or no prompt. */
export const DISABLE_ENV = "OPENSWARM_DISABLE_PROJECT_CONFIG";

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Decide whether this workspace's configuration may be loaded.
 *
 * Never throws: a failure to determine trust denies, because the alternative
 * is a crash that a malicious repository can trigger deliberately and a user
 * can only escape by disabling the check.
 */
export async function resolveTrust(opts: ResolveTrustOptions): Promise<TrustDecision> {
  const env = opts.envOverrides ?? process.env;
  const provenance = await scanProvenance(opts.cwd).catch(
    (): Provenance => ({
      root: opts.cwd,
      findings: [],
      // An unscannable workspace is not an empty one. Claiming `inert` here
      // would turn a read error into a grant.
      digest: "",
      inert: false,
    }),
  );

  if (truthy(env[DISABLE_ENV])) {
    return { allowWorkspaceConfig: false, reason: "disabled", provenance };
  }

  // Nothing here can execute, so there is nothing to consent to. This is what
  // keeps the prompt rare enough that people read it.
  if (provenance.inert) {
    return { allowWorkspaceConfig: true, reason: "inert", provenance };
  }

  if (truthy(env[TRUST_ENV])) {
    return { allowWorkspaceConfig: true, reason: "trusted", provenance };
  }

  const store = opts.store ?? new TrustStore();
  // Keyed on the scanned root rather than the caller's cwd string, so a
  // symlinked path and its target share one record.
  const identity = provenance.root;
  const lookup = await store
    .lookup(identity, provenance.digest)
    .catch(() => ({ state: "unknown" }) as const);

  if (lookup.state === "trusted") {
    return { allowWorkspaceConfig: true, reason: "trusted", provenance };
  }

  if (opts.prompt === undefined) {
    return { allowWorkspaceConfig: false, reason: "non-interactive", provenance };
  }

  const answer = await opts.prompt(provenance, lookup.state).catch(
    (): TrustAnswer => ({ kind: "deny" }),
  );
  if (answer.kind === "deny") {
    return { allowWorkspaceConfig: false, reason: "declined", provenance };
  }

  await store.grant(identity, answer.scope, provenance.digest).catch(() => {
    // Failing to persist costs a prompt next time; it must not cost the
    // decision the user just made.
  });
  return { allowWorkspaceConfig: true, reason: "granted", provenance };
}

/**
 * Publish a resolved decision to child processes.
 *
 * Workers run in their parent's workspace, so re-deciding per worker would
 * either re-prompt or — with no TTY in a worker — deny in a workspace the user
 * already trusted. `spawnWorker` spreads `process.env`, so setting the same
 * variable a CI user would set is the whole channel.
 *
 * @security Only ever sets the variable, never clears it, and is only called
 * with a decision that came from `resolveTrust`.
 */
export function propagateTrust(decision: TrustDecision, env = process.env): void {
  if (decision.allowWorkspaceConfig) env[TRUST_ENV] = "1";
}

/**
 * A trusting decision for callers with no workspace of their own to vet —
 * worker subprocesses, whose parent already resolved trust, and tests.
 *
 * @security Not for the CLI entry points. A worker inherits its parent's
 * decision because it inherits the parent's workspace; anything else would
 * re-prompt per worker.
 */
export function inheritedTrust(cwd: string): TrustDecision {
  return {
    allowWorkspaceConfig: true,
    reason: "trusted",
    provenance: { root: cwd, findings: [], digest: "", inert: true },
  };
}

/** What to print when a workspace is running degraded. */
export function explainDenial(decision: TrustDecision): string {
  const count = decision.provenance.findings.filter((f) => f.severity === "execute").length;
  const what = `${count} executable configuration file${count === 1 ? "" : "s"}`;
  const head =
    decision.reason === "non-interactive"
      ? `[openswarm] untrusted workspace: ignoring ${what}.\n` +
        `  Non-interactive runs cannot prompt. Trust it interactively, or set ${TRUST_ENV}=1.\n`
      : decision.reason === "disabled"
        ? `[openswarm] ${DISABLE_ENV} is set: ignoring ${what}.\n`
        : `[openswarm] workspace not trusted: ignoring ${what}.\n`;
  const detail = summarize(decision.provenance)
    .map((l) => `  ${l}\n`)
    .join("");
  return head + detail;
}
