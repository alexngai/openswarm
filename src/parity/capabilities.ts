/**
 * capabilities.ts — the `DDP-*` capability contract from docs/63 as data.
 *
 * Each entry answers four questions that prose kept leaving implicit: which release must this pass,
 * who is accountable, which work-package gate proves it, and which fixtures inside that gate do the
 * proving. Encoding it surfaced three scheduling errors that four review passes over the prose had
 * missed, all of the same shape — a release exit gate naming a capability whose own stated beta
 * evidence is not produced until a later release:
 *
 *   - `DDP-SAFE-03` requires LSP to run through the process broker, but LSP arrives in `WP-21` (R4)
 *     while the R3 exit gate claimed the capability.
 *   - `DDP-SWM-04` requires survival of an eight-hour soak, but the soak is `FX-SOAK-001` in `WP-31`
 *     (R6) while the R3 exit gate claimed the capability.
 *   - `DDP-PRIV-01` is gated by `FX-PRIVACY-001` in `WP-32` (R6), after R5 exit declares every
 *     mandatory capability feature complete.
 *
 * All three are recorded here as `release` plus `partialFrom`, so a partial pass can never be read
 * as a full one, and docs/63's exit gates were corrected to match.
 *
 * `accountableOwner` is assigned by domain rather than derived, because deriving it from work-package
 * ownership produces nonsense for capabilities whose only gate is a measurement package: `WP-28`
 * would end up accountable for most of the product. Validation instead requires that the accountable
 * owner actually owns at least one of the capability's evidence packages — you cannot be accountable
 * for work you have no part in.
 */
import type { Capability } from "./contracts.js";
import { PLATFORM_CELLS } from "./contracts.js";

export const CAPABILITIES: readonly Capability[] = [
  // --- Daily-driver core ---------------------------------------------------
  {
    id: "DDP-CORE-01",
    group: "Daily-driver core",
    outcome:
      "Inspect, search, edit, diff, execute, and test TypeScript, Python, and Go repositories",
    betaEvidence:
      "Standard fix journey passes with one certified model from each provider",
    mandatory: true,
    release: "R5",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-28",
        cells: ["release-matrix"],
        fixtures: ["FX-MATRIX-001..045"],
      },
    ],
  },
  {
    id: "DDP-CONV-01",
    group: "Daily-driver core",
    outcome: "Automatic conversation continuity",
    betaEvidence: "Ten turns retain prior text and tool results without /resume",
    mandatory: true,
    release: "R2",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-07",
        cells: ["linux-x64"],
        fixtures: ["FX-JOURNAL-001..012"],
      },
      {
        workPackage: "WP-08",
        cells: ["linux-x64"],
        fixtures: ["FX-RESUME-001..011"],
      },
    ],
  },
  {
    id: "DDP-HDL-01",
    group: "Daily-driver core",
    outcome: "Versioned non-interactive protocol",
    betaEvidence:
      "Deterministic JSONL, exit codes, cancellation, sessions, resume, attachments, and approval outcomes",
    mandatory: true,
    release: "R5",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-26",
        cells: ["surface-matrix"],
        fixtures: ["FX-HDL-001..010"],
      },
    ],
  },
  {
    id: "DDP-ACP-01",
    group: "Daily-driver core",
    outcome: "Zed ACP daily-driver workflow",
    betaEvidence:
      "Streaming, tools, diffs, approvals, cancellation, images, resume, and errors round-trip",
    mandatory: true,
    release: "R5",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-26",
        cells: ["surface-matrix"],
        fixtures: ["FX-ACP-001..010"],
      },
    ],
  },

  // --- Sessions and recovery ----------------------------------------------
  {
    id: "DDP-SES-01",
    group: "Sessions and recovery",
    outcome: "Durable crash-safe sessions",
    betaEvidence:
      "Fault injection loses no acknowledged event and blindly repeats no ambiguous side effect",
    mandatory: true,
    release: "R2",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-00",
        cells: ["linux-x64"],
        fixtures: ["FX-CRASH-001"],
      },
      {
        workPackage: "WP-05",
        cells: ["linux-x64"],
        fixtures: ["FX-RETRY-001..010"],
      },
      {
        workPackage: "WP-07",
        cells: ["linux-x64"],
        fixtures: ["FX-JOURNAL-001..012", "FX-MIG-SESSION-001"],
      },
    ],
  },
  {
    id: "DDP-SES-02",
    group: "Sessions and recovery",
    outcome: "Checkpoint, conversation/code rewind, and fork",
    betaEvidence:
      "Restored state matches checkpoint hashes; original history remains intact",
    mandatory: true,
    release: "R4",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-19",
        cells: ["linux-x64"],
        fixtures: ["FX-REWIND-001..010"],
      },
    ],
  },
  {
    id: "DDP-MEM-01",
    group: "Sessions and recovery",
    outcome: "Durable curated memory and archive",
    betaEvidence:
      "Default encrypted 90-day history survives restart; configured retention/export/deletion work; unavailable secure keys produce an explicit ephemeral session",
    mandatory: true,
    release: "R5",
    partialFrom: "R4",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-00",
        cells: ["linux-x64"],
        fixtures: ["FX-STORAGE-DEFAULT-001"],
      },
      {
        workPackage: "WP-23",
        cells: ["linux-x64"],
        fixtures: ["FX-MEM-001..010", "FX-MIG-MEM-001"],
      },
      {
        workPackage: "WP-27",
        cells: ["crypto-matrix"],
        fixtures: ["FX-RET-001..010", "FX-MIG-CRYPTO-001"],
      },
    ],
  },

  // --- Safety and extensions ----------------------------------------------
  {
    id: "DDP-SAFE-01",
    group: "Safety and extensions",
    outcome: "Trust before project automation",
    betaEvidence:
      "A malicious fresh clone starts no process, network request, or secret access before trust",
    mandatory: true,
    release: "R1",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-02",
        cells: ["linux-x64"],
        fixtures: ["FX-TRUST-001..006"],
      },
    ],
  },
  {
    id: "DDP-SAFE-02",
    group: "Safety and extensions",
    outcome: "Canonical workspace confinement",
    betaEvidence:
      "Absolute, traversal, ancestor-symlink, broken-symlink, and swap-race corpus produces zero escapes",
    mandatory: true,
    release: "R1",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-00a",
        cells: ["linux-x64"],
        fixtures: ["FX-ESCAPE-001"],
      },
      {
        workPackage: "WP-03",
        cells: ["linux-x64"],
        fixtures: ["FX-PATH-001..020"],
      },
    ],
  },
  {
    id: "DDP-SAFE-03",
    group: "Safety and extensions",
    outcome: "Contained process execution",
    betaEvidence:
      "Shells, hooks, MCP, plugins, and LSP use one broker; missing isolation executes nothing",
    mandatory: true,
    // R4, not R3: the capability names LSP, which does not exist until WP-21.
    release: "R4",
    partialFrom: "R3",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-04",
        cells: ["linux-x64"],
        fixtures: ["FX-PROC-001..012"],
      },
      {
        workPackage: "WP-14",
        cells: ["linux-x64"],
        fixtures: ["FX-EXT-ABUSE-001..016"],
      },
      {
        workPackage: "WP-15",
        cells: ["linux-x64"],
        fixtures: ["FX-MCP-001..014"],
      },
      {
        workPackage: "WP-21",
        cells: ["lsp-matrix"],
        fixtures: ["FX-LSP-TS-001..004"],
      },
    ],
  },
  {
    id: "DDP-SAFE-04",
    group: "Safety and extensions",
    outcome: "Default-denied network and secrets",
    betaEvidence:
      "Only explicit domain/named-secret grants work; SSRF, rebinding, redirects, and ambient credential leaks fail",
    mandatory: true,
    release: "R3",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-13",
        cells: ["linux-x64"],
        fixtures: ["FX-NET-001..016", "FX-SECRET-001..008"],
      },
    ],
  },
  {
    id: "DDP-SAFE-05",
    group: "Safety and extensions",
    outcome: "Unified approvals",
    betaEvidence:
      "TTY/ACP approve; headless denies unless an authenticated, bounded request succeeds; default grants remain exact-resource, operation-class, and session scoped",
    mandatory: true,
    release: "R2",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-00a",
        cells: ["linux-x64"],
        fixtures: ["FX-GATE-001"],
      },
      {
        workPackage: "WP-09",
        cells: ["linux-x64"],
        fixtures: ["FX-APPROVAL-001..012"],
      },
    ],
  },
  {
    id: "DDP-EXT-01",
    group: "Safety and extensions",
    outcome: "Safe extension baseline",
    betaEvidence:
      "Skills/hooks/plugins and local/remote MCP have provenance, OAuth/named-secret auth, hash-pinned plugins, policy, time/output bounds, and cancellation",
    mandatory: true,
    release: "R3",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-14",
        cells: ["linux-x64"],
        fixtures: ["FX-EXT-ABUSE-001..016", "FX-PLUGIN-HASH-001"],
      },
      {
        workPackage: "WP-15",
        cells: ["linux-x64"],
        fixtures: ["FX-MCP-001..014", "FX-MCP-OAUTH-001"],
      },
    ],
  },
  {
    id: "DDP-PRIV-01",
    group: "Safety and extensions",
    outcome: "Local-first diagnostics",
    betaEvidence:
      "No diagnostic, usage, transcript, or code data leaves the machine except provider calls or an explicit redacted-telemetry/share action",
    mandatory: true,
    // R6: the only gate that proves this is FX-PRIVACY-001 in the WP-32 claims audit.
    release: "R6",
    partialFrom: "R5",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-32",
        cells: ["migration-claims"],
        fixtures: ["FX-PRIVACY-001"],
      },
    ],
  },

  // --- Providers, intelligence, and media ---------------------------------
  {
    id: "DDP-PROV-01",
    group: "Providers, intelligence, and media",
    outcome: "Anthropic/OpenAI/Gemini portability",
    betaEvidence:
      "One exact model/API identifier per provider passes the same contract; other models are visibly unverified and excluded from claims",
    mandatory: true,
    release: "R5",
    partialFrom: "R3",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-16",
        cells: ["provider-contract"],
        fixtures: ["FX-PROVIDER-001..018", "FX-MODEL-LABEL-001"],
      },
      {
        workPackage: "WP-28",
        cells: ["release-matrix"],
        fixtures: ["FX-MATRIX-001..045"],
      },
    ],
  },
  {
    id: "DDP-LSP-01",
    group: "Providers, intelligence, and media",
    outcome: "Core LSP",
    betaEvidence:
      "Diagnostics, definition, references, and transactional rename pass with TypeScript, Python, and Go",
    mandatory: true,
    release: "R4",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-21",
        cells: ["lsp-matrix"],
        fixtures: [
          "FX-LSP-TS-001..004",
          "FX-LSP-PY-001..004",
          "FX-LSP-GO-001..004",
        ],
      },
    ],
  },
  {
    id: "DDP-MEDIA-01",
    group: "Providers, intelligence, and media",
    outcome: "Image attachments",
    betaEvidence:
      "TUI, headless, and ACP send validated typed images without transcript-embedded base64",
    mandatory: true,
    release: "R4",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-22",
        cells: ["image-matrix"],
        fixtures: ["FX-IMG-001..012"],
      },
    ],
  },

  // --- Product UX and observability ---------------------------------------
  {
    id: "DDP-UX-01",
    group: "Product UX and observability",
    outcome: "Deterministic TUI input",
    betaEvidence:
      "Cursor, history, multiline, Tab, paste, global chords, and approval keys pass PTY tests",
    mandatory: true,
    release: "R2",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-10",
        cells: ["linux-x64-pty"],
        fixtures: ["FX-TUI-KEYS-001..014"],
      },
    ],
  },
  {
    id: "DDP-UX-02",
    group: "Product UX and observability",
    outcome: "Transparent execution/recovery",
    betaEvidence:
      "Tool activity, approvals, diffs, checkpoints, patches, and conflicts are inspectable",
    mandatory: true,
    release: "R4",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-12",
        cells: ["linux-x64"],
        fixtures: ["FX-EVENT-001..010"],
      },
      {
        workPackage: "WP-24",
        cells: ["linux-x64-team"],
        fixtures: ["FX-TEAM-UX-001..012"],
      },
    ],
  },
  {
    id: "DDP-UX-03",
    group: "Product UX and observability",
    outcome: "Observable teams",
    betaEvidence:
      "Agent tree, task board, steering, usage, failures, and patch state derive from real events",
    mandatory: true,
    release: "R4",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-24",
        cells: ["linux-x64-team"],
        fixtures: ["FX-TEAM-UX-001..012"],
      },
    ],
  },
  {
    id: "DDP-OBS-01",
    group: "Product UX and observability",
    outcome: "Auditable provenance and usage",
    betaEvidence:
      "Every effect records principal, decision, grant, attempt, generation, terminal result, and redacted cost",
    mandatory: true,
    release: "R5",
    partialFrom: "R3",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-12",
        cells: ["linux-x64"],
        fixtures: ["FX-EVENT-001..010"],
      },
      {
        workPackage: "WP-18",
        cells: ["linux-x64-load"],
        fixtures: ["FX-BUDGET-001..006"],
      },
      {
        workPackage: "WP-28",
        cells: ["release-matrix"],
        fixtures: ["FX-MATRIX-001..045"],
      },
    ],
  },

  // --- Swarm and platform correctness -------------------------------------
  {
    id: "DDP-SWM-01",
    group: "Swarm and platform correctness",
    outcome: "Authorized atomic task state",
    betaEvidence: "One claimant wins; invalid or unauthorized transitions fail",
    mandatory: true,
    release: "R1",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-06",
        cells: ["linux-x64"],
        fixtures: ["FX-CLAIM-002", "FX-CAS-001"],
      },
    ],
  },
  {
    id: "DDP-SWM-02",
    group: "Swarm and platform correctness",
    outcome: "Safe shared workspace",
    betaEvidence:
      "One writer; overlapping reader output is provisional, generation-stamped, automatically revalidated, and terminal only when verified",
    mandatory: true,
    release: "R2",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-11",
        cells: ["linux-x64"],
        fixtures: ["FX-RW-001..012"],
      },
    ],
  },
  {
    id: "DDP-SWM-03",
    group: "Swarm and platform correctness",
    outcome: "Safe isolated writers",
    betaEvidence:
      "Worktree writers overlap; landing is serialized and target-SHA compare-and-swap safe",
    mandatory: true,
    release: "R4",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-20",
        cells: ["linux-x64-git"],
        fixtures: ["FX-LAND-001..016"],
      },
    ],
  },
  {
    id: "DDP-SWM-04",
    group: "Swarm and platform correctness",
    outcome: "Supervision and bounded resources",
    betaEvidence:
      "Quotas, heartbeats, queues, cancellation, cleanup, and budgets survive an eight-hour soak",
    mandatory: true,
    // R6, not R3: the eight-hour soak this capability names is FX-SOAK-001 in WP-31.
    release: "R6",
    partialFrom: "R3",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-18",
        cells: ["linux-x64-load"],
        fixtures: ["FX-SUP-001..014", "FX-BUDGET-001..006"],
      },
      {
        workPackage: "WP-31",
        cells: ["soak-8h"],
        fixtures: ["FX-SOAK-001"],
      },
    ],
  },
  {
    // Not in the original docs/63 contract. Encoding the manifest surfaced WP-17 — three
    // person-weeks of R3 work — as evidence no capability had asked for, while the scope boundary
    // separately promised "one authoritative runtime contract across root agents, workers, daemons,
    // TUI, headless, and ACP" with no ID to hold it. This is that ID; the outcome is taken from
    // WP-17's own gate text rather than invented.
    id: "DDP-SWM-05",
    group: "Swarm and platform correctness",
    outcome:
      "One authoritative runtime contract across root agents, workers, and daemons",
    betaEvidence:
      "Root and worker capability manifests match; unauthorized cross-process task transitions are zero; daemon transport identity is authenticated",
    mandatory: true,
    release: "R3",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-17",
        cells: ["linux-x64"],
        fixtures: ["FX-WORKER-001..012", "FX-MIG-DAEMON-001"],
      },
    ],
  },
  {
    id: "DDP-REL-01",
    group: "Swarm and platform correctness",
    outcome: "Retry-safe side effects",
    betaEvidence:
      "Committed or ambiguous mutating calls are never blindly replayed",
    mandatory: true,
    release: "R1",
    accountableOwner: "B",
    evidence: [
      {
        workPackage: "WP-00",
        cells: ["linux-x64"],
        fixtures: ["FX-EFFECT-001"],
      },
      {
        workPackage: "WP-05",
        cells: ["linux-x64"],
        fixtures: ["FX-RETRY-001..010"],
      },
    ],
  },
  {
    id: "DDP-PLAT-01",
    group: "Swarm and platform correctness",
    outcome: "Focused platform matrix",
    betaEvidence:
      "All five platform targets pass release suites; native Windows shell execution is rejected",
    mandatory: true,
    release: "R5",
    accountableOwner: "A",
    evidence: [
      {
        workPackage: "WP-25",
        cells: PLATFORM_CELLS,
        fixtures: ["FX-PLAT-001..005", "FX-WSL-ID-001"],
      },
    ],
  },
  {
    id: "DDP-EVAL-01",
    group: "Swarm and platform correctness",
    outcome: "Evidence-backed claims",
    betaEvidence:
      "Mixed-corpus paired evaluation clears the −5-point 95% confidence bound plus 1.25× latency and 1.15× cost guardrails; every claim links to evidence",
    mandatory: true,
    release: "R6",
    partialFrom: "R5",
    accountableOwner: "C",
    evidence: [
      {
        workPackage: "WP-01",
        cells: ["linux-x64"],
        fixtures: ["FX-CLAIM-001", "FX-EVAL-PLAN-001"],
      },
      {
        workPackage: "WP-28",
        cells: ["release-matrix"],
        fixtures: ["FX-NONINFERIOR-001", "FX-EFFICIENCY-001"],
      },
      {
        workPackage: "WP-32",
        cells: ["migration-claims"],
        fixtures: ["FX-CLAIMS-001"],
      },
    ],
  },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function capability(id: string): Capability | undefined {
  return BY_ID.get(id);
}
