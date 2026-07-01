#!/usr/bin/env bash
# scripts/smoke-v07-git-cascade.sh — v0.7 git-cascade end-to-end smoke.
#
# Validates the v0.7 flows (7A/7B/7C/7D) against a real tmp git repo using
# the real git-cascade tracker. No LLM calls — exercises the BranchPolicy
# adapter primitives directly + the `worktree` CLI subcommand.
#
# Flows covered:
#   A. Worktree creation via adapter.resolve({kind:"stream"})           [7A]
#   B. (skipped — topology integration is in unit tests)                [7D]
#   C. Audited commit via adapter.commitChanges (Change-Id trailer)     [7B]
#   D. Auto-merge via adapter.mergeStream                                [7C]
#   E. Worktree CLI list + clean                                         [7D]
#
# Usage:  ./scripts/smoke-v07-git-cascade.sh
# Exits 0 if all checks pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

record() {
  local status="$1" n="$2" label="$3"
  echo "[$n] $status - $label"
  if [[ "$status" == "PASS" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

# ---- Build first ------------------------------------------------------------
echo "Building..."
npm run build > /tmp/build.log 2>&1 || { cat /tmp/build.log; exit 1; }

# ---- Set up tmp git repo ----------------------------------------------------
TMP="$(mktemp -d)"
trap "rm -rf $TMP" EXIT
echo "Tmp repo: $TMP"

cd "$TMP"
git init -q -b main
git config user.email "smoke@example.com"
git config user.name "Smoke Test"
echo "initial" > README.md
git add README.md
git commit -q -m "initial commit"

# ---- Driver script (Node, exercises adapter directly) -----------------------
cat > driver.mjs <<'NODE'
import { GitCascadeBranchPolicyAdapter } from "$REPO/dist/swarm/adapters/git-cascade-branch-policy.js";
import { MultiAgentRepoTracker } from "$REPO/node_modules/git-cascade/dist/tracker.js";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

const repo = process.cwd();
// Ensure the harness state dirs exist before the tracker opens its sqlite DB.
const dbDir = path.join(repo, ".openswarm", "git-cascade");
const dbPath = path.join(dbDir, "tracker.db");
mkdirSync(dbDir, { recursive: true });
mkdirSync(path.join(repo, ".openswarm", "worktrees"), { recursive: true });
// Share a single tracker between the smoke's raw setup (trunk) and the
// adapter (member streams). Without sharing, the adapter would open its
// own DB and not see the trunk stream.
const tracker = new MultiAgentRepoTracker({ repoPath: repo, dbPath });
const adapter = new GitCascadeBranchPolicyAdapter({
  repoPath: repo,
  trackerForTest: tracker,
});

// ---- Setup: validate ensureIntegratorStream idempotency (7F) --------------
// (Integrator streams are exposed for cascade-rebase parent linkage; the
// auto-merge path uses mergeStreamToBranch instead — git-cascade's
// mergeStream can't accept integrator streams as targets.)
const trunkStreamId = await adapter.ensureIntegratorStream("main");
console.log("trunk:" + trunkStreamId);
const trunkAgain = await adapter.ensureIntegratorStream("main");
if (trunkAgain !== trunkStreamId) {
  console.error("FAIL: ensureIntegratorStream not idempotent");
  process.exit(2);
}

// ---- Flow A: worktree creation ---------------------------------------------
// Spawn a feature stream from current HEAD (which is main). Forking from
// the integrator (which tracks an existing branch, not a synthetic
// stream/<id> branch) doesn't work — git-cascade's forkStream expects
// stream/<parentId> to exist as a ref.
const r1 = await adapter.resolve(
  { kind: "stream", name: "feat-x" },
  "agent-A",
);
if (!r1.cwd || !existsSync(r1.cwd)) {
  console.error("FAIL: worktree was not created at " + r1.cwd);
  process.exit(2);
}
console.log("OK_A:" + JSON.stringify({ streamId: r1.streamId, cwd: r1.cwd, branch: r1.branch }));

// ---- Flow C: write a file in the worktree, then audited commit -------------
writeFileSync(path.join(r1.cwd, "feature.txt"), "hello from agent A\n");
execSync("git add feature.txt", { cwd: r1.cwd });
const c1 = await adapter.commitChanges("agent-A", "feat: add feature.txt", { taskId: "t-99" });
if (!c1 || !c1.commitSha) {
  console.error("FAIL: commitChanges returned null/undefined");
  process.exit(3);
}
// Verify Change-Id trailer is in the commit message.
const msg = execSync(`git log -1 --format=%B ${c1.commitSha}`, { cwd: r1.cwd }).toString();
if (!msg.match(/Change-Id:/)) {
  console.error("FAIL: commit is missing Change-Id trailer");
  console.error(msg);
  process.exit(3);
}
console.log("OK_C:" + JSON.stringify({ commitSha: c1.commitSha, changeId: c1.changeId, hasChangeId: true }));

// ---- Flow D: merge feat → main via mergeStreamToBranch ---------------------
// v0.7 stage 7F path. Plain-git merge in a tmp worktree; lands changes
// directly in main without disturbing the source's checkout.
const m1 = await adapter.mergeStreamToBranch({
  sourceAgentId: "agent-A",
  targetBranch: "main",
});
if (!m1.success) {
  console.error("FAIL: mergeStreamToBranch failed: " + JSON.stringify(m1));
  process.exit(4);
}
const filesInMain = execSync(`git ls-tree -r --name-only main`, { cwd: repo }).toString();
if (!filesInMain.includes("feature.txt")) {
  console.error("FAIL: feature.txt did not land in main");
  console.error("files: " + filesInMain);
  process.exit(4);
}
console.log("OK_D:" + JSON.stringify({ newHead: m1.newHead, target: "main" }));

// ---- Flow G: cascade rebase propagates to dependents (7K) ------------------
// Build a 3-stream chain: root → child → grandchild, all forked off each other.
// Land a new commit on root, then call cascadeRebase(root) and verify both
// child + grandchild contain the new file.
const rootStreamId = await (async () => {
  const r = await adapter.resolve(
    { kind: "stream", name: "cascade-root" },
    "agent-root",
  );
  return r.streamId;
})();
const childStreamId = await (async () => {
  const r = await adapter.resolve(
    { kind: "stream", baseStreamId: rootStreamId, name: "cascade-child" },
    "agent-child",
  );
  return r.streamId;
})();
const grandStreamId = await (async () => {
  const r = await adapter.resolve(
    { kind: "stream", baseStreamId: childStreamId, name: "cascade-grand" },
    "agent-grand",
  );
  return r.streamId;
})();

// Drop a new file in the root's worktree and commit it.
const rootWorktree = path.join(repo, ".openswarm", "worktrees", rootStreamId);
writeFileSync(path.join(rootWorktree, "cascade.txt"), "cascade payload\n");
execSync("git add cascade.txt", { cwd: rootWorktree });
const cRoot = await adapter.commitChanges("agent-root", "feat: cascade payload");
if (!cRoot || !cRoot.commitSha) {
  console.error("FAIL_G: root commitChanges returned null");
  process.exit(7);
}

const cascadeR = await adapter.cascadeRebase({ rootStream: rootStreamId });
if (!cascadeR.success) {
  console.error("FAIL_G: cascadeRebase failed: " + JSON.stringify(cascadeR));
  process.exit(7);
}
// Verify both dependents now contain cascade.txt.
const childFiles = execSync(`git ls-tree -r --name-only stream/${childStreamId}`, { cwd: repo }).toString();
const grandFiles = execSync(`git ls-tree -r --name-only stream/${grandStreamId}`, { cwd: repo }).toString();
if (!childFiles.includes("cascade.txt")) {
  console.error("FAIL_G: cascade.txt did not land in child stream");
  process.exit(7);
}
if (!grandFiles.includes("cascade.txt")) {
  console.error("FAIL_G: cascade.txt did not land in grandchild stream");
  process.exit(7);
}
console.log("OK_G:" + JSON.stringify({
  root: rootStreamId,
  child: childStreamId,
  grand: grandStreamId,
  rebased: cascadeR.rebased?.length ?? 0,
}));

await adapter.dispose();

// ---- Flow F: cleanupOnDispose removes worktrees automatically (7H) ---------
// Use a fresh tracker + adapter so disposal cleanup is the only thing
// removing worktrees in this section.
const tracker2 = new MultiAgentRepoTracker({ repoPath: repo, dbPath });
const cleanupAdapter = new GitCascadeBranchPolicyAdapter({
  repoPath: repo,
  trackerForTest: tracker2,
  cleanupOnDispose: true,
});
const r2 = await cleanupAdapter.resolve(
  { kind: "stream", name: "cleanup-test" },
  "agent-cleanup",
);
if (!existsSync(r2.cwd)) {
  console.error("FAIL_F: worktree was not created at " + r2.cwd);
  process.exit(5);
}
await cleanupAdapter.dispose();
if (existsSync(r2.cwd)) {
  console.error("FAIL_F: worktree dir still exists after dispose: " + r2.cwd);
  process.exit(5);
}
console.log("OK_F:" + JSON.stringify({ worktree: r2.cwd, removed: true }));
NODE

# Substitute REPO into driver.
sed -i.bak "s|\$REPO|$REPO_ROOT|g" driver.mjs && rm driver.mjs.bak

# ---- Run the driver ---------------------------------------------------------
DRIVER_OUT=$(node driver.mjs 2>&1)
DRIVER_RC=$?

if [[ $DRIVER_RC -ne 0 ]]; then
  echo "$DRIVER_OUT"
  record FAIL FlowA "worktree creation"
  record FAIL FlowC "audited commit (commitChanges)"
  record FAIL FlowD "auto-merge (mergeStream)"
  record FAIL FlowG "cascade rebase propagates to dependents"
  record FAIL FlowF "cleanupOnDispose removes worktrees"
else
  echo "$DRIVER_OUT" | grep -q "^OK_A:" && record PASS FlowA "worktree created on disk" || record FAIL FlowA "worktree missing"
  echo "$DRIVER_OUT" | grep -q "^OK_C:" && record PASS FlowC "commitChanges adds Change-Id trailer" || record FAIL FlowC "commitChanges missing trailer"
  echo "$DRIVER_OUT" | grep -q "^OK_D:" && record PASS FlowD "mergeStream lands files in target" || record FAIL FlowD "mergeStream did not land changes"
  echo "$DRIVER_OUT" | grep -q "^OK_G:" && record PASS FlowG "cascade rebase propagates to child + grandchild" || record FAIL FlowG "cascade rebase did not propagate"
  echo "$DRIVER_OUT" | grep -q "^OK_F:" && record PASS FlowF "cleanupOnDispose removes worktrees" || record FAIL FlowF "cleanupOnDispose did not remove worktree"
fi

# ---- Flow E: worktree CLI ---------------------------------------------------
LIST_OUT=$(node "$REPO_ROOT/dist/cli.js" worktree list --repo "$TMP" 2>&1)
if echo "$LIST_OUT" | grep -q "/.openswarm/worktrees/"; then
  record PASS FlowE-list "worktree list found a worktree"
else
  echo "$LIST_OUT"
  record FAIL FlowE-list "worktree list missed the worktree"
fi

CLEAN_OUT=$(node "$REPO_ROOT/dist/cli.js" worktree clean --repo "$TMP" 2>&1)
if echo "$CLEAN_OUT" | grep -qE "removed: .*\\.openswarm/worktrees/" && echo "$CLEAN_OUT" | grep -qE "summary: removed=[0-9]+ failed=0"; then
  record PASS FlowE-clean "worktree clean removed worktrees with no failures"
else
  echo "$CLEAN_OUT"
  record FAIL FlowE-clean "worktree clean did not report success"
fi

# Verify the worktree directory is actually gone.
if [[ ! -d "$TMP/.openswarm/worktrees" ]] || [[ -z "$(ls -A "$TMP/.openswarm/worktrees" 2>/dev/null)" ]]; then
  record PASS FlowE-cleanup "worktree dir is gone post-clean"
else
  ls -la "$TMP/.openswarm/worktrees"
  record FAIL FlowE-cleanup "worktree dir still exists post-clean"
fi

echo
echo "============================================"
echo "v0.7 git-cascade smoke: $PASS pass, $FAIL fail"
echo "============================================"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
