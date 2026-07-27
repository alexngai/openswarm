/**
 * certification.ts — pinned identities for `DDP-PROV-01` and `DDP-PLAT-01`.
 *
 * docs/63 asks `WP-01` to "encode exact certified provider/model/API IDs; mark all other models
 * `unverified`", and `WP-25` to "pin exact OS/distribution builds, Node/Bun versions, LSP server
 * versions, provider model IDs, and certification dates".
 *
 * Nothing here is certified yet, and saying otherwise would be the exact failure the manifest
 * exists to prevent: certification means passing the provider contract suite, which `WP-16` builds.
 * So every model is a *candidate* with no certification date, and `labelFor` returns `unverified` for
 * all of them. When `WP-16` lands it promotes candidates by recording a date and a passing artifact;
 * until then the honest label is the pessimistic one.
 *
 * The value of pinning candidates now is that it fixes the target: the evaluation corpus, the
 * comparator pairing, and the platform matrix all need to name exact identifiers before `WP-28` can
 * run, and choosing them later invites choosing whichever model happens to score well.
 */

/** The three providers `DDP-PROV-01` requires portability across. */
export type CertifiedProvider = "anthropic" | "openai" | "google";

export const REQUIRED_PROVIDERS: readonly CertifiedProvider[] = [
  "anthropic",
  "openai",
  "google",
];

export type CertificationStatus = "candidate" | "certified";

/** How a model is labelled to users. `DDP-PROV-01` requires the negative case be visible. */
export type ModelLabel = "certified" | "unverified";

export interface ModelCertification {
  readonly provider: CertifiedProvider;
  /** The exact API identifier, never an alias. Aliases move; certification cannot. */
  readonly modelId: string;
  readonly status: CertificationStatus;
  /** ISO date on which the contract suite last passed. Absent until it has. */
  readonly certifiedOn?: string;
  /** Why this identifier was chosen as the candidate, so the choice can be argued with. */
  readonly rationale: string;
}

/**
 * One candidate per required provider. The Anthropic and OpenAI identifiers are the ones
 * `src/providers/aliases.ts` already pins; the Google identifier is the most capable entry in
 * `src/providers/capability-catalog.ts`, since no Gemini alias exists yet.
 */
export const MODEL_CERTIFICATIONS: readonly ModelCertification[] = [
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    status: "candidate",
    rationale:
      "The default working model behind the `sonnet` alias, so certifying it matches what users actually run.",
  },
  {
    provider: "openai",
    modelId: "gpt-5-2025-08-07",
    status: "candidate",
    rationale:
      "Dated snapshot rather than the floating `gpt-5` alias, so a provider-side model refresh cannot silently change what was certified.",
  },
  {
    provider: "google",
    modelId: "gemini-2.5-pro",
    status: "candidate",
    rationale:
      "The only Gemini family with full capability metadata in the catalog; no Gemini alias is pinned yet, which WP-16 must fix.",
  },
];

/**
 * The `DDP-PROV-01` labelling rule. Anything not explicitly certified is `unverified` — including
 * candidates, and including models OpenSwarm supports perfectly well. The label describes evidence,
 * not quality.
 */
export function labelFor(modelId: string): ModelLabel {
  const entry = MODEL_CERTIFICATIONS.find((m) => m.modelId === modelId);
  return entry?.status === "certified" ? "certified" : "unverified";
}

/** Models eligible to appear in evaluation evidence. Empty until `WP-16` certifies. */
export function evidenceEligibleModels(): readonly string[] {
  return MODEL_CERTIFICATIONS.filter((m) => m.status === "certified").map(
    (m) => m.modelId,
  );
}

/**
 * The pinned execution environment. `nodeVersion` and `bunVersion` must match `Dockerfile.parity`,
 * which in turn matches what CI resolves; the parity gate checks this rather than trusting it.
 */
export interface PinnedToolchain {
  readonly nodeVersion: string;
  readonly bunVersion: string;
  readonly baseImage: string;
}

export const PINNED_TOOLCHAIN: PinnedToolchain = {
  nodeVersion: "22.23.1",
  bunVersion: "1.3.8",
  baseImage: "node:22.23.1-bookworm",
};

/**
 * LSP servers `DDP-LSP-01` certifies. Deliberately unpinned: `WP-21` selects and pins the versions,
 * and inventing version numbers now would put three unverifiable facts into the manifest. The
 * languages are pinned because those are a scope decision docs/63 already made.
 */
export interface LspServerPin {
  readonly language: "typescript" | "python" | "go";
  readonly server: string;
  readonly version: string | null;
}

export const LSP_SERVERS: readonly LspServerPin[] = [
  { language: "typescript", server: "typescript-language-server", version: null },
  { language: "python", server: "pyright", version: null },
  { language: "go", server: "gopls", version: null },
];
