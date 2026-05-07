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
const dbDir = path.join(repo, ".swarm-harness", "git-cascade");
const dbPath = path.join(dbDir, "tracker.db");
mkdirSync(dbDir, { recursive: true });
mkdirSync(path.join(repo, ".swarm-harness", "worktrees"), { recursive: true });
// Share a single tracker between the smoke's raw setup (trunk) and the
// adapter (member streams). Without sharing, the adapter would open its
// own DB and not see the trunk stream.
const tracker = new MultiAgentRepoTracker({ repoPath: repo, dbPath });
const adapter = new GitCascadeBranchPolicyAdapter({
  repoPath: repo,
  trackerForTest: tracker,
});

// ---- Setup: trunk stream as merge target (no worktree) ---------------------
// git-cascade's mergeStream checks out the target branch in the source's
// worktree to perform the merge. If the target has its own worktree, the
// checkout fails ("already checked out"). So integration targets must be
// stream-only — no worktree. Create trunk via the raw tracker.
const trunkStreamId = tracker.createStream({
  name: "trunk",
  agentId: "smoke-driver",
});
console.log("trunk:" + trunkStreamId);

// ---- Flow A: worktree creation ---------------------------------------------
// Spawn a feature stream forking from trunk.
const r1 = await adapter.resolve(
  { kind: "stream", baseStreamId: trunkStreamId, name: "feat-x" },
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

// ---- Flow D: merge feat → trunk --------------------------------------------
const m1 = await adapter.mergeStream({
  sourceAgentId: "agent-A",
  targetStream: trunkStreamId,
});
if (!m1.success) {
  console.error("FAIL: mergeStream failed: " + JSON.stringify(m1));
  process.exit(4);
}
// Confirm feature.txt now exists in the trunk stream's branch.
const trunkBranch = `stream/${trunkStreamId}`;
const filesInTrunk = execSync(`git ls-tree -r --name-only ${trunkBranch}`, { cwd: repo }).toString();
if (!filesInTrunk.includes("feature.txt")) {
  console.error("FAIL: feature.txt did not land in " + trunkBranch);
  console.error("files: " + filesInTrunk);
  process.exit(4);
}
console.log("OK_D:" + JSON.stringify({ newHead: m1.newHead, trunkBranch }));

await adapter.dispose();
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
else
  echo "$DRIVER_OUT" | grep -q "^OK_A:" && record PASS FlowA "worktree created on disk" || record FAIL FlowA "worktree missing"
  echo "$DRIVER_OUT" | grep -q "^OK_C:" && record PASS FlowC "commitChanges adds Change-Id trailer" || record FAIL FlowC "commitChanges missing trailer"
  echo "$DRIVER_OUT" | grep -q "^OK_D:" && record PASS FlowD "mergeStream lands files in target" || record FAIL FlowD "mergeStream did not land changes"
fi

# ---- Flow E: worktree CLI ---------------------------------------------------
LIST_OUT=$(node "$REPO_ROOT/dist/cli.js" worktree list --repo "$TMP" 2>&1)
if echo "$LIST_OUT" | grep -q "/.swarm-harness/worktrees/"; then
  record PASS FlowE-list "worktree list found a worktree"
else
  echo "$LIST_OUT"
  record FAIL FlowE-list "worktree list missed the worktree"
fi

CLEAN_OUT=$(node "$REPO_ROOT/dist/cli.js" worktree clean --repo "$TMP" 2>&1)
if echo "$CLEAN_OUT" | grep -qE "removed: .*\\.swarm-harness/worktrees/" && echo "$CLEAN_OUT" | grep -qE "summary: removed=[0-9]+ failed=0"; then
  record PASS FlowE-clean "worktree clean removed worktrees with no failures"
else
  echo "$CLEAN_OUT"
  record FAIL FlowE-clean "worktree clean did not report success"
fi

# Verify the worktree directory is actually gone.
if [[ ! -d "$TMP/.swarm-harness/worktrees" ]] || [[ -z "$(ls -A "$TMP/.swarm-harness/worktrees" 2>/dev/null)" ]]; then
  record PASS FlowE-cleanup "worktree dir is gone post-clean"
else
  ls -la "$TMP/.swarm-harness/worktrees"
  record FAIL FlowE-cleanup "worktree dir still exists post-clean"
fi

echo
echo "============================================"
echo "v0.7 git-cascade smoke: $PASS pass, $FAIL fail"
echo "============================================"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
