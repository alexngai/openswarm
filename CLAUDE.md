# Agent Instructions

OpenSwarm is being rebuilt as out-of-tree plugins on DeepSeek Harness (`dsh`,
Cordis-based). Read [`docs/01-dsh-foundation.md`](docs/01-dsh-foundation.md)
first — it is the governing design doc (decision, seams, focus features,
phases).

- **New work happens at the repo root** (packages to come; see the target
  layout in docs/01).
- **`legacy/`** is the frozen v0.x implementation, kept for reference while
  porting. Its own build/test instructions are in `legacy/CLAUDE.md`; run
  `bun install` inside `legacy/` before using them. Do not extend it.
- A dsh source checkout for reading lives at `../deepseek-harness` (also see
  its `docs/architecture.md` and cookbook). We consume dsh from npm at a
  pinned exact version — never patch the checkout as part of a change here.
- Docs are numbered and cited by number (`docs/01`); numbers are never
  reused. Legacy docs keep their old numbering under `legacy/docs/`.
