# Open questions

Each question has a provisional **Lean**. Nothing is locked until we pick a v0 scope and resolve these. Decisions move to the log at the bottom.

## 1. ~~Agent SDK vs. raw SDK~~ — RESOLVED

**Decision:** Hybrid. **Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) as primary transport**, we own the turn loop. Agent SDK (`@anthropic-ai/claude-agent-sdk`) available as an **optional `FrameworkProvider` path** for Claude Max subscription auth (users opt in via `--framework claude-agent-sdk`).

**Why not Option A (Agent SDK everywhere):** Anthropic-shaped all the way down; multi-provider at M4 means ejection rewrite; SDK's tool loop doesn't know about our SwarmHost.

**Why not Option B (raw `@anthropic-ai/sdk` + own loop):** M4 multi-provider means wiring N raw SDKs; Vercel AI SDK already normalizes across providers.

**Why hybrid:** Subscription auth validation (see Q16/Q17 below) showed the three paths have different constraints:
- API key: Vercel AI SDK clean path for all providers
- Claude Max: Direct OAuth would require impersonating `user-agent: claude-code/…` + `anthropic-beta: claude-code-20250219` headers → Anthropic Feb 2026 policy tightening + impersonation risk. Delegating to Agent SDK keeps users on Anthropic's supported path.
- ChatGPT Plus/Pro: Codex App Server OAuth is partially documented; needs custom provider.
- GitHub Copilot: No public path; reverse-engineered only. Skip.

**Architectural consequence:** `Provider` becomes a tagged union of `TransportProvider` (Vercel AI SDK, our loop) and `FrameworkProvider` (Agent SDK, its loop). Users choosing the Framework path get constrained swarm features — documented as tradeoff.

## 2. ~~Subprocess vs. in-process atomic agents~~ — RESOLVED

**Decision:** Subprocess first. Reinforced by research/05-swarm.md — claw's thread-based `Agent` tool is exactly the pattern we're diverging from (shared mutable state, no crash isolation, can't cross machine boundaries). In-process mode stays on the table as an optimization behind the same `SwarmHost` interface.

## 3. ~~Session format~~ — RESOLVED

**Decision:** Match claw's JSONL format (`session_meta` header + interleaved `message` / `compaction` / `prompt_history` records, append-on-push, atomic-rename snapshots — research/03-runtime.md §3). **Add per-worktree isolation** at `.swarm-harness/sessions/<fnv1a(cwd)>/` — non-negotiable for multi-agent, prevents "phantom completions" where multiple workers stomp shared state. Swarm-coder extensions live under a `swarm:` namespace key.

## 4. ~~v0 swarm scope~~ — RESOLVED

**Decision:** M1 ships task fanout only. Tier 2 cut for M1: `agent`, `task_create`, `task_update`, `task_get`, `task_list`. `send_message`, `check_inbox`, `task_stop`, `task_output` slip to M3. See `07-implementation-plan.md` for full M1 scope.

## 5. ~~Config file layout~~ — RESOLVED

**Decision:** `~/.swarm-harness/` for our own state. Read-only discovery over Claude-Code-shaped paths (`~/.claude/plugins`, `~/.claude/skills`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `.claude`, `.codex`, `.claw`, `.omc`) via `PluginSource` / `SkillSource` impls (research/04-integrations.md §3). We never mutate Claude Code's installation.

## 6. ~~Name and framing~~ — RESOLVED

**Decision:** Keep `swarm-harness`. Rename remains cheap pre-v0.1; no compelling pull toward an alternative surfaced during review.

## 7. ~~Ink version and mount strategy~~ — RESOLVED

**Decision:** Ink v5 (Node 18+). TTY-gated routing at CLI entry — `process.stdout.isTTY` false → headless JSONL path bypasses ink entirely. No mid-run mode swap in v0; a process is either interactive or headless for its lifetime.

## 8. ~~Permission prompt UX under headless mode~~ — RESOLVED

**Decision:** Headless mode emits a `permission_prompt` lane event instead of blocking. Orchestrator receives the event and either (a) injects an `allow` / `deny` message, or (b) auto-denies after a grace period. Default permission mode when spawned headless is `workspace-write`. Orchestrators can pass `--permission-mode danger-full-access` per worker. Prompts never block a headless worker.

## 9. ~~`multi_edit` in Tier 0?~~ — RESOLVED

**Decision:** **Yes, add to Tier 0.** Sequential `edit_file` calls waste turns and compound the cost of our uniqueness-check divergence. Single-turn multi-edit is strictly better UX. Implementation is `edit_file` in a loop with atomic all-or-nothing application. Adds one tool to M0 scope.

## 10. ~~Streaming markdown renderer — port or library?~~ — RESOLVED

**Decision:** Off-the-shelf. Try `ink-markdown` first; fall back to `marked` + custom ink components if it's abandoned or underpowered. **Do not port claw's `MarkdownStreamState.push` pipeline** (~200 LOC of pulldown-cmark + syntect + ANSI state). Revisit only if stream-safe rendering misbehaves in real use.

## 11. ~~Ripgrep dependency strategy~~ — RESOLVED

**Decision:** Bundle `@vscode/ripgrep` unconditionally. No system `rg` detection. Platform-appropriate binary is downloaded by the package install script — one platform's worth per install. Predictable cross-environment behavior outweighs the ~5 MB install footprint.

## 12. ~~MCP first-class tools vs. generic dispatcher~~ — RESOLVED

**Decision:** **First-class at startup in M2.** All configured MCP servers connect before the first turn; each MCP tool registers into our tool table as `mcp__<server>__<tool>`. Model plans against them by name. Parallel connect with per-server timeout; fail-soft if a server is unreachable (degraded startup event, skip its tools).

Dynamic (mid-session) tool registration deferred to M5 — needed only if users want to hot-add MCP servers during a running session.

**Why the change from the earlier lean:** startup-time first-class registration doesn't need deferred schemas; it's a ~small incremental cost over the generic dispatcher, and the UX win is real (model can plan against named MCP tools).

## 13. ~~WorkerRegistry-style tool family~~ — RESOLVED

**Decision:** Skip entirely. Claw's 9-tool family exists to drive external Claude Code via tmux screen scraping — a workaround for not having an SDK. We have the SDK; our `agent` tool covers spawn, lane events cover observation. We lift the **atomic state-file pattern** (write `.swarm-harness/workers/<agentId>.json` on lifecycle transitions) per `05-swarm-model.md`; we do not port the tool surface.

## 14. ~~Compaction strategy~~ — RESOLVED

**Decision:** Mechanical compaction, port claw's approach (research/03-runtime.md §7). Tool-use / tool-result boundary guard is load-bearing for M4 cross-provider compatibility — OpenAI-compat providers 400 on orphan tool results after a sloppy compaction. Post-compaction `glob` health probe confirms tool transport is alive. No LLM-driven compaction in any milestone.

## 15. ~~AskUserQuestion UX in headless mode~~ — RESOLVED

**Decision:** Lane event pattern, mirroring Q8. The question becomes a `question_asked` lane event. Orchestrator surfaces to the human operator (any channel: Slack, Discord, CLI prompt). Orchestrator replies by sending an `answer_received` message back to the worker. Standalone mode prompts the TTY directly. Consistent with how permission prompts work under orchestration.

## 16. Claude Max subscription auth path

**Question:** For users on a Claude Max subscription, do we (a) reimplement OAuth + send impersonating headers (`user-agent: claude-code/…`, `anthropic-beta: claude-code-20250219`) directly through Vercel AI SDK, or (b) delegate to the Agent SDK as a `FrameworkProvider`?

**Decision:** (b) Delegate to Agent SDK. Validated by research spike — path (a) is technically viable (claw-code does it) but (i) requires impersonating Claude Code in user-agent, (ii) reportedly conflicts with Anthropic's Feb 2026 policy tightening on third-party OAuth proxying, (iii) exposes us to silent API changes since the flow is undocumented. (b) keeps Max users on Anthropic's supported path.

**Cost accepted:** In `--framework claude-agent-sdk` mode, swarm features are constrained — Agent SDK owns the loop, permissions, session, and tool execution, so our `SwarmHost`-routed tools (`send_message`, `check_inbox`, lane events for Tier 2 coordination) either degrade or don't function. Documented tradeoff.

**What it affects:** M3 scope; `src/providers/framework/claude-agent-sdk.ts`; user-facing docs that explain the tradeoff.

## 17. ChatGPT Plus/Pro subscription auth path

**Question:** Is subscription-quota auth achievable for OpenAI models, and if so, how?

**Decision:** Yes, via a **custom Vercel AI SDK provider** targeting `https://chatgpt.com/backend-api/codex/responses` using the Codex App Server OAuth flow. `@ai-sdk/openai` cannot be reused (different base URL, different auth header shape). Flow is partially documented at `developers.openai.com/codex/app-server`; client ID `app_EMoamEEZ73f0CkXaXp7hrann` is in production third-party use (Cline, OpenClaw, opencode) but unregistered as an independent developer program.

**Deferred to M4.** Out of scope for M0–M3. Gate behind `--framework codex-chatgpt` or a provider flag; handled like a `FrameworkProvider` since it bypasses the standard OpenAI Messages surface.

**Known risks:** Shared client ID could be revoked; no formal partner agreement; OpenAI could change endpoints without notice. Document as "policy-tolerated, not contracted."

## 18. GitHub Copilot subscription — explicitly out

**Decision:** No Copilot subscription auth support. Community proxies (`copilot-api`, `copilot-proxy`) work only via reverse-engineered internal endpoints, violating the March 2026 Copilot Product Specific Terms, and exposing users to account suspension. Any future Copilot support requires an official third-party API from GitHub.

## Decision log

| Date | Question | Decision | Rationale |
|---|---|---|---|
| 2026-04-20 | Q1 Agent SDK vs. raw SDK | Hybrid: Vercel AI SDK primary + Agent SDK as optional FrameworkProvider | Multi-provider from day 1; Agent SDK only for Max subscription where policy requires it |
| 2026-04-20 | Q2 Subprocess vs. in-process | Subprocess | Crash isolation + claw's thread model is what we're diverging from |
| 2026-04-20 | Q3 Session format | claw JSONL + per-worktree isolation | Compat for `/resume` + prevents phantom completions |
| 2026-04-20 | Q4 v0 swarm scope | Task fanout only | Proves the atomic-unit contract before adding coordination |
| 2026-04-20 | Q5 Config layout | `~/.swarm-harness/` + read-only Claude Code sources | Keeps our state separate; user's existing plugins/skills light up free |
| 2026-04-20 | Q8 Headless permission prompts | `permission_prompt` lane event, no blocking | Unblocks orchestrator; matches async swarm model |
| 2026-04-20 | Q16 Claude Max auth path | Agent SDK FrameworkProvider (not direct OAuth) | Avoids impersonation + Feb 2026 Anthropic policy risk |
| 2026-04-20 | Q17 ChatGPT Plus/Pro auth | Custom Vercel provider + Codex App Server OAuth, M4 | Partially documented; requires distinct endpoint |
| 2026-04-20 | Q18 GitHub Copilot | Skip entirely | ToS violation risk |
| 2026-04-20 | Q6 Name | Keep `swarm-harness` | Cheap to rename later; no alternative surfaced |
| 2026-04-20 | Q7 Ink strategy | Ink v5, TTY-gated at entry, no mid-run swap | Simplest correct behavior |
| 2026-04-20 | Q9 multi_edit in Tier 0 | Yes | Single-turn beats N sequential edit calls |
| 2026-04-20 | Q10 Markdown renderer | `ink-markdown` first, `marked` fallback; don't port claw pipeline | Ink-native libs exist; claw's 200-LOC pipeline not worth replicating |
| 2026-04-20 | Q11 Ripgrep | Bundle `@vscode/ripgrep` unconditionally | Predictable cross-env behavior |
| 2026-04-20 | Q12 MCP first-class tools | First-class at startup in M2; dynamic in M5 | Near-free over generic dispatcher; model can plan by name |
| 2026-04-20 | Q13 Worker 9-tool family | Skip | Claw's family is screen-scraping workaround we don't need |
| 2026-04-20 | Q14 Compaction | Mechanical (port claw approach) | Boundary guard is load-bearing for M4 multi-provider |
| 2026-04-20 | Q15 AskUserQuestion headless | Lane event `question_asked` / `answer_received` | Consistent with Q8 permission-prompt pattern |

All open questions resolved as of 2026-04-20. New questions will be added at the bottom as they arise during M0+.

## Q20. Codex ChatGPT endpoint SSE shape — RESOLVED 2026-04-30 (pivot to App Server)

**Original question:** What is the exact SSE event vocabulary emitted by `https://chatgpt.com/backend-api/codex/responses`? What headers does it require beyond the OAuth bearer token?

**Resolution:** Question is **moot** under the v0.3 redesign. Web research surfaced that the official OpenAI integration surface is the **Codex App Server (JSON-RPC over stdio)**, not the private browser-to-backend SSE channel. Phase 6 pivoted: spawn the locally-installed `codex` binary as a subprocess, speak JSON-RPC over stdio, delegate auth to `codex login`. No SSE capture needed; no reverse-engineered endpoint to chase.

**Replacement design:** [docs/24-phase-6-codex-app-server-plan.md](24-phase-6-codex-app-server-plan.md). Categorization changes from `TransportProvider` (custom Vercel AI SDK) to `FrameworkProvider` (delegating the agent loop to Codex). Mirrors the Anthropic Agent SDK pattern for Claude Max subscription auth.

**Decision log entry:**

| Date | Question | Decision | Rationale |
|---|---|---|---|
| 2026-04-30 | Q20 Codex SSE shape | RESOLVED — pivot to App Server JSON-RPC; SSE spike no longer needed | Official integration path is the documented App Server protocol, not the private browser channel; lower risk + better architecture fit |

## Q19. NativeEngine concurrency — RESOLVED

**Question (from M3b Phase 4 caveat):** Parallel tool execution was untested on a real concurrent path — only the Agent SDK's MCP bridge had exercised it, and whether it serialized internally was unknown.

**Resolution:** NativeEngine's `dispatchBatch` fan-out is proven concurrent in M4a. The `native.test.ts` suite exercises three simultaneous MockProvider tool calls and asserts that all three start within a 50 ms window. The compactor's tool-pair boundary guard correctly handles tool-use/tool-result pairs that span a compaction cut. NativeEngine is engine-agnostic w.r.t. SwarmHost — Tier 2 tools work identically under both `ClaudeAgentSdkEngine` and `NativeEngine`.

**Decision log entry:**

| Date | Question | Decision | Rationale |
|---|---|---|---|
| 2026-04-21 | Q19 NativeEngine concurrency | Concurrent via dispatchBatch fan-out; proven in M4a test suite | native.test.ts 3-tool parallel start verified within 50ms window |
