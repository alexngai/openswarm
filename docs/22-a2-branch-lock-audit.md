# A2 Branch-Lock Audit — doc 22

**Stage:** v0.2 Stage 2C  
**Date:** 2026-04-30  
**Auditor:** Stage 2C executor  
**Scope:** `src/swarm/git/` vs claw's three reference modules  
**Verdict (preview):** No code changes needed. Our implementation is at functional parity with claw's three modules and goes meaningfully beyond them in two areas (atomic filesystem lock, hash-based filename disambiguation). Row A2 flips to 🟦 (divergent — intentionally richer).

---

## Section 1 — What we have today

### `src/swarm/git/branch-lock.ts`

**Layer A — Pure collision detector** (advisory, mirrors claw verbatim)

| Function / Type | Signature | Behavior |
|---|---|---|
| `BranchLockIntent` | `{ laneId, branch, modules }` | Input shape for the collision detector. |
| `BranchLockCollision` | `{ branch, module, laneIds }` | Output shape: one tuple per (branch × module) pair that collides. |
| `detectCollisions(intents)` | `(readonly BranchLockIntent[]) → readonly BranchLockCollision[]` | O(n²) pair scan; calls `overlappingModules` per pair; sorts + deduplicates output. Pure, read-only. Ported near-verbatim from claw. |
| `overlappingModules(left, right)` | private | Cartesian product over both module lists; filters through `modulesOverlap`; returns sorted + deduped overlap names. |
| `modulesOverlap(l, r)` | private | `l===r || l.startsWith(r+'/') || r.startsWith(l+'/')` — handles parent/child nesting. |
| `sharedScope(l, r)` | private | Returns the shorter (parent) scope. |

**Layer B — Atomic filesystem lock** (NEW design on top; not in claw)

| Function / Type | Signature | Behavior |
|---|---|---|
| `LockHandle` | `{ branch, release() }` | Handle returned by `acquire`. |
| `AcquireOptions` | `{ agentId, timeoutMs, lockDir?, cwd?, pollIntervalMs?, staleReclaimAfterMs? }` | Options. `lockDir` overrides git-anchored path (test-only). |
| `LockFileContent` | private `{ ownerAgentId, acquiredAt, pid, branch }` | JSON written to the lock file. |
| `acquire(branch, opts)` | `async → LockHandle` | `fs.open(path, "wx")` (O_EXCL-equivalent). On EEXIST: calls `tryReclaimStale`; if not reclaimed, polls until timeout. Throws on timeout with descriptive message to stderr. Release is idempotent. |
| `resolveLockDir(override, cwd)` | private async | Runs `git rev-parse --git-common-dir`; resolves relative path; anchors to `<gitCommonDir>/swarm-harness/branch-locks`. |
| `tryReclaimStale(lockPath, threshold)` | private async | Reads lock file; checks `isDeadPid(parsed.pid)`; checks age vs `staleReclaimAfterMs`; unlinks if stale. Returns `true` if the slot is now free. |
| `isDeadPid(pid)` | private | `process.kill(pid, 0)` signal-0 test. ESRCH → dead. EPERM → alive (process exists, no permission). |
| `sanitizeBranchName(branch)` | exported | Replaces `[^A-Za-z0-9._-]` with `-`; appends 4-char FNV-1a hash of original branch; appends `.lock`. |
| `fnv1a4(s)` | exported | Stable 32-bit FNV-1a hash truncated to 4 lower-hex chars. Used by `sanitizeBranchName`. |

**Test coverage** (`src/swarm/git/branch-lock.test.ts`): 10 tests covering serialize/release, timeout, stale reclaim, live-pid non-reclaim, idempotent release, concurrent serialization, filename sanitization, hash stability, hash disambiguation.

---

### `src/swarm/git/stale-base.ts`

| Function / Type | Signature | Behavior |
|---|---|---|
| `StaleBaseResult` | `matches | diverged{expected,actual} | no-expected-base | not-a-git-repo` | Four-variant discriminated union. |
| `CheckOptions` | `{ cwd?, expectedBase? }` | Inputs. |
| `check(opts)` | `async → StaleBaseResult` | Resolves expected base (opts > `.swarm-base` file > none). Runs `git rev-parse HEAD`. Compares strings. Returns appropriate variant. |
| `resolveExpectedBase(override, cwd)` | private async | Reads `<cwd>/.swarm-base` if no explicit override. Returns `undefined` if absent or empty. |
| `formatWarning(result)` | exported | Returns `"base diverged: expected X, got Y"` for `diverged`; `null` for all other variants. |

**Note on file marker:** Our marker file is `.swarm-base`; claw's is `.claw-base`. Intentional: swarm-harness is not a claw fork and should not read claw's artifacts.

**Test coverage** (`src/swarm/git/stale-base.test.ts`): 5 tests using real temporary git repos — matches, diverged, no-expected-base, not-a-git-repo, `.swarm-base` file resolution.

---

### `src/swarm/git/stale-branch.ts`

| Function / Type | Signature | Behavior |
|---|---|---|
| `Freshness` | `fresh | stale{commitsBehind,missingFixes} | diverged{ahead,behind,missingFixes}` | Three-variant result. |
| `PolicyKind` | `"AutoRebase" | "AutoMergeForward" | "WarnOnly" | "Block"` | Maps 1:1 to claw's `StaleBranchPolicy` variants. |
| `PolicyIntent` | `Noop | Warn{message} | Block{reason} | Rebase | MergeForward` | Maps 1:1 to claw's `StaleBranchAction` variants. |
| `CheckOptions` | `{ cwd? }` | |
| `check(branch, mainRef?, opts)` | `async → Freshness` | `revListCount(main, branch)` (behind) + `revListCount(branch, main)` (ahead). `behind===0` → fresh (even if ahead>0). `behind>0 && ahead>0` → diverged. `behind>0 && ahead===0` → stale. Calls `missingFixSubjects` for stale/diverged. |
| `applyPolicy(freshness, policy)` | exported pure | Maps `(Freshness × PolicyKind) → PolicyIntent`. Warn messages include commit counts and missing fix subjects. Block reasons include counts. |
| `resolveMainRef(cwd)` | exported async | Tries `origin/main` → `main` → `origin/master` → `master`. Throws if none resolve. |
| `revListCount(a, b, cwd)` | private async | `git rev-list --count b..a`. Returns 0 on error. |
| `missingFixSubjects(a, b, cwd)` | private async | `git log --format=%s b..a`. Returns `[]` on error. No regex filter (mirrors claw exactly). |
| `formatFixes(fixes)` | private | `"(none)"` or semicolon-joined. |

**Test coverage** (`src/swarm/git/stale-branch.test.ts`): 16 tests — pure `applyPolicy` matrix (8 cases) + mocked `check()` scenarios (fresh, stale+fixes, stale+empty, diverged, ahead-only-fresh, mainRef-fallback).

---

## Section 2 — What claw has

### `rust/crates/runtime/src/branch_lock.rs`

**Public surface:**

| Item | Kind | Behavior |
|---|---|---|
| `BranchLockIntent` | struct | `{ lane_id, branch, worktree?, modules }`. Note: has optional `worktree` field. |
| `BranchLockCollision` | struct | `{ branch, module, lane_ids }` |
| `detect_branch_lock_collisions(intents)` | `fn(&[BranchLockIntent]) → Vec<BranchLockCollision>` | O(n²) pair scan. Same algorithm as ours. Sorts by (branch, module, lane_ids); calls `Vec::dedup()`. |
| `overlapping_modules` | private fn | Same logic as ours. |
| `modules_overlap` | private fn | Same predicate. |
| `shared_scope` | private fn | Same scope selection. |

**Failure model:** Pure function; no I/O; no panics. Returns empty vec on no collisions.

**What's NOT in claw's branch_lock.rs:** No atomic filesystem lock. No file-based lock acquisition. No stale reclaim. No pid checking. No lock directory resolution. claw's runtime uses a separate in-process mutex registry (`OnceLock`) — a design we explicitly reject (see `05-swarm-model.md:158-162`).

---

### `rust/crates/runtime/src/stale_base.rs`

**Public surface:**

| Item | Kind | Behavior |
|---|---|---|
| `BaseCommitState` | enum | `Matches | Diverged{expected,actual} | NoExpectedBase | NotAGitRepo` |
| `BaseCommitSource` | enum | `Flag(String) | File(String)` — tracks provenance of the expected value. |
| `read_claw_base_file(cwd)` | `fn(&Path) → Option<String>` | Reads `.claw-base`; trims; returns None if absent or empty. |
| `resolve_expected_base(flag_value, cwd)` | `fn(Option<&str>, &Path) → Option<BaseCommitSource>` | Flag wins over file. Returns `Some(BaseCommitSource::Flag | File)`. |
| `check_base_commit(cwd, expected_base)` | `fn(&Path, Option<&BaseCommitSource>) → BaseCommitState` | Runs `git rev-parse HEAD` + `git rev-parse <expected>`. Has partial-SHA fallback: if expected ref can't be resolved as a git object, falls back to string prefix comparison. |
| `format_stale_base_warning(state)` | `fn(&BaseCommitState) → Option<String>` | Returns warning for `Diverged` and `NotAGitRepo`; None for others. |
| `resolve_head_sha` / `resolve_rev` | private | Git plumbing. |

**Failure model:** Returns typed enum variants; never panics. `NotAGitRepo` is a surface-level result, not an error.

**Key difference from ours:** claw emits a warning for `NotAGitRepo` ("stale-base check skipped — not inside a git repository."); we return `null` from `formatWarning` for that case. claw also exposes `BaseCommitSource` enum tracking whether the value came from a flag or file; we don't surface provenance.

---

### `rust/crates/runtime/src/stale_branch.rs`

**Public surface:**

| Item | Kind | Behavior |
|---|---|---|
| `BranchFreshness` | enum | `Fresh | Stale{commits_behind,missing_fixes} | Diverged{ahead,behind,missing_fixes}` |
| `StaleBranchPolicy` | enum | `AutoRebase | AutoMergeForward | WarnOnly | Block` |
| `StaleBranchEvent` | enum | `BranchStaleAgainstMain{branch,commits_behind,missing_fixes} | RebaseAttempted{branch,result} | MergeForwardAttempted{branch,result}` — **event log types** |
| `StaleBranchAction` | enum | `Noop | Warn{message} | Block{message} | Rebase | MergeForward` |
| `check_freshness(branch, main_ref)` | `fn(&str, &str) → BranchFreshness` | Wrapper calling `check_freshness_in` with `Path::new(".")`. |
| `check_freshness_in(branch, main_ref, repo_path)` | `pub(crate) fn` | Core: `rev_list_count` for behind + ahead; returns Fresh/Stale/Diverged. |
| `apply_policy(freshness, policy)` | `fn(&BranchFreshness, StaleBranchPolicy) → StaleBranchAction` | Same logic as ours. |
| `rev_list_count` / `missing_fix_subjects` / `format_missing_fixes` | private fn | Same git plumbing as ours. |

**Failure model:** `check_freshness_in` returns `Fresh` on git errors (same as ours returning `0` counts). `apply_policy` is pure.

**What's NOT in ours:** `StaleBranchEvent` enum — claw defines structured event types for lane-event emission (`BranchStaleAgainstMain`, `RebaseAttempted`, `MergeForwardAttempted`). We have `applyPolicy` returning a `PolicyIntent` but no structured event envelope for lane-event emission. Our `resolveMainRef` (fallback chain: `origin/main` → `main` → `origin/master` → `master`) has no direct equivalent in claw (claw callers always supply `main_ref` explicitly).

---

## Section 3 — Gap table

| Claw item | Our item | Gap | Risk class | Porting cost |
|---|---|---|---|---|
| `detect_branch_lock_collisions` | `detectCollisions` | None — algorithm is identical; output is sorted + deduped the same way. | — | — |
| `BranchLockIntent.worktree` field | Not present | Minor — we don't track worktree on the intent. No consumer reads it in claw's public surface either. | nice-to-have | XS |
| In-process `OnceLock` mutex registry (claw pattern) | Atomic file lock (`acquire`) | Divergent by design. We ship a cross-process file lock; claw uses in-process mutexes. Our design is load-bearing for multi-process swarm safety. | — (intentional divergence) | — |
| `BaseCommitState` + `check_base_commit` | `StaleBaseResult` + `check` | None in semantics. Four variants map 1:1. Same comparison logic. | — | — |
| `BaseCommitSource` (Flag vs File provenance) | Not exposed | We merge provenance into `check` rather than surfacing it. No consumer of ours needs to distinguish source. | nice-to-have | XS |
| `format_stale_base_warning` emits warning for `NotAGitRepo` | `formatWarning` returns null for `not-a-git-repo` | Minor behavioral difference. Claw warns; we are silent. Our silence matches doc 05's "not-a-git-repo are silent (no event)" note (`05-swarm-model.md:153`). | none (intentional) | — |
| `read_claw_base_file` / `.claw-base` | `resolveExpectedBase` / `.swarm-base` | Marker file name differs (`claw-base` vs `swarm-base`). Intentional: we don't want to pick up claw's artifacts. | none (intentional) | — |
| Partial-SHA prefix comparison fallback in `check_base_commit` | Not present | If `expectedBase` is a partial SHA (e.g. `"abc1234"`), claw does prefix comparison; we do exact string match against `git rev-parse HEAD` output. Partial SHAs from callers not observed in our codebase. | nice-to-have | XS |
| `StaleBranchEvent` enum (`BranchStaleAgainstMain`, `RebaseAttempted`, `MergeForwardAttempted`) | Not present | We return `PolicyIntent` but don't wrap results in a lane-event envelope. Event emission belongs in the orchestrator calling `applyPolicy`, not in this module. | observability | S |
| `check_freshness` (cwd=".") / `check_freshness_in(branch, main_ref, path)` | `check(branch, mainRef?, opts)` | claw always requires an explicit `main_ref`; we add an async `resolveMainRef` fallback. Richer; not a gap. | none (improvement) | — |
| `StaleBranchAction.Block.message` field name | `PolicyIntent.Block.reason` field name | Field is named `message` in claw, `reason` in ours. Cosmetic; our name is clearer. | nice-to-have | XS |

---

## Section 4 — Recommendations

### Risk = correctness
No correctness gaps were found. The collision detection algorithm, the stale-base comparison logic, and the stale-branch freshness computation all match claw's behavior exactly. The atomic file lock goes beyond claw (claw has no cross-process lock) and is the right design for swarm's multi-process workers.

### Risk = observability — `StaleBranchEvent`
**Defer to a v0.3+ telemetry pass.** Claw defines `StaleBranchEvent` for structured lane-event emission (`BranchStaleAgainstMain`, `RebaseAttempted`, `MergeForwardAttempted`). These are useful when a lane-event bus is wired to structured logging or a UI panel. Our current architecture returns `PolicyIntent` from `applyPolicy`; the orchestrator is responsible for converting that intent into lane events when it acts on the recommendation. Adding a `StaleBranchEvent` wrapper now would be premature — the lane-event types for git coordination haven't been defined in `TypedLaneEvent` yet (that belongs in a future pass alongside A3/A4 or a dedicated telemetry milestone). Mark as deferred to v0.3+.

### Risk = nice-to-have — deferred indefinitely

- **`BranchLockIntent.worktree` field** — claw serializes but never reads it in the collision detector. No consumer in our codebase would benefit from it. Mark deferred indefinitely.
- **`BaseCommitSource` provenance enum** — no caller of ours needs to distinguish whether the expected base came from an explicit option or a file. Mark deferred indefinitely.
- **Partial-SHA prefix comparison** — callers in our codebase always supply full 40-char SHAs. The edge case doesn't arise. Mark deferred indefinitely.
- **`Block.message` vs `Block.reason` naming** — our name (`reason`) is more idiomatic for a block reason. No change needed.

### Summary decision
> **No code changes are needed.** The audit finds no correctness gaps. All behavioral differences are either intentional divergences (cross-process file lock, `.swarm-base` vs `.claw-base`, `NotAGitRepo` silence, `resolveMainRef` fallback) or nice-to-have additions (worktree field, provenance source, partial-SHA fallback) that have no load-bearing consumers. The one observability gap (`StaleBranchEvent`) belongs in a future telemetry pass, not in Stage 2C.

---

## Section 5 — Implementation deltas

**None.** The audit identifies zero load-bearing correctness gaps and zero items within the 0.5d cap that would improve safety or correctness. No code changes are made as part of Stage 2C.

The full implementation already exceeds claw-parity in the two areas where swarm's multi-process design demands it:
1. **Atomic cross-process file lock** (`acquire` with O_EXCL, stale-reclaim, PID liveness) — claw's in-process `OnceLock` would be unsafe for swarm's subprocess workers.
2. **`resolveMainRef` fallback chain** — claw callers always supply the ref explicitly; we auto-detect from common ref names to reduce caller burden.

---

## Appendix — File inventory

| File | Lines | Role |
|---|---|---|
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/branch-lock.ts` | 331 | Layer A: collision detector (claw port) + Layer B: atomic file lock (new) |
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/branch-lock.test.ts` | 307 | Tests for both layers |
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/stale-base.ts` | 77 | HEAD vs expected-base comparison |
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/stale-base.test.ts` | 86 | Real-git-repo tests |
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/stale-branch.ts` | 191 | Branch freshness + policy application |
| `/Users/alexngai/GitHub/swarm-coder/src/swarm/git/stale-branch.test.ts` | 306 | Pure policy + mocked git tests |
| `/Users/alexngai/GitHub/swarm-coder/references/claw-code/rust/crates/runtime/src/branch_lock.rs` | 145 | Claw reference: collision detector only |
| `/Users/alexngai/GitHub/swarm-coder/references/claw-code/rust/crates/runtime/src/stale_base.rs` | 430 | Claw reference: base-commit check |
| `/Users/alexngai/GitHub/swarm-coder/references/claw-code/rust/crates/runtime/src/stale_branch.rs` | 418 | Claw reference: freshness + policy |
