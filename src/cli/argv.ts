/**
 * argv.ts — hand-rolled CLI argument parser for OpenSwarm.
 *
 * Parses process.argv.slice(2). No external dependencies.
 *
 * Subcommands: prompt, doctor, init, help, version, swarm
 * Bare positional (not a flag, not a known subcommand) → treated as prompt text.
 *
 * Flags:
 *   --model <str>
 *   --resume <session-id | "latest">
 *   --permission-mode <read-only | workspace-write | danger-full-access>
 *   --output-format <text | json>
 *   --headless
 *   --help / -h
 *   --version / -V
 *
 * swarm subcommand:
 *   swarm run <tasks-file> [--concurrency N] [--output <path>] [--permission-mode <mode>]
 */

import type { PermissionMode } from "../core/types.js";
import type { TopologyKind } from "../swarm/team-spec.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type FrameworkChoice = "native" | "hardened-native" | "claude-agent-sdk" | "codex-chatgpt" | "codex-native" | "auto";

export interface CommonOpts {
  model?: string;
  resume?: string;
  permissionMode: PermissionMode;
  outputFormat: "text" | "json";
  headless: boolean;
  /** When false, plugin discovery is disabled at startup. Default: true. */
  plugins: boolean;
  /** When false, skill discovery is disabled at startup. Default: true. */
  skills: boolean;
  /** When false, MCP server discovery is disabled at startup. Default: true. */
  mcp: boolean;
  /** When false, hook config discovery is disabled at startup. Default: true. */
  hooks: boolean;
  /**
   * When true, the runtime prints the registered tool list as JSON and exits
   * 0 without running a turn. For testing / smoke only — not advertised in
   * --help production output. See `runPrompt` for the implementation.
   */
  dumpTools: boolean;
  /**
   * When true, enables the Anthropic SDK's built-in `WebSearch` tool (via
   * `RunConfig.enabledBuiltinTools = ["WebSearch"]`). Default: false.
   */
  enableWebSearch: boolean;
  /**
   * Plan mode: read-only investigation + design persona. When true, the
   * *effective* permission mode is narrowed to `read-only` (in the runtime and
   * REPL) and the plan-mode persona is appended to the system prompt.
   * `permissionMode` above remains the user's ceiling so `/plan off` can
   * restore write access. Toggled live in the REPL via `/plan`.
   */
  plan: boolean;
  /**
   * acp subcommand: force single-agent mode (Stage A). docs/archive/33.
   */
  readonly single?: boolean;
  /**
   * acp subcommand: force team mode (coordinator). docs/archive/33.
   */
  readonly team?: boolean;
  /**
   * Engine/framework selection. Default: "auto" (claude* → claude-agent-sdk,
   * everything else → native). Not advertised prominently in --help.
   */
  readonly framework: FrameworkChoice;
  /**
   * codex-native transport. "sse" (default), or "websocket"/"auto" for the
   * delta connection that avoids re-uploading context each turn (docs/42 §9).
   */
  readonly codexTransport?: "sse" | "websocket" | "auto";
  /**
   * When true, print { engineId, providerId?, modelId } as JSON to stdout
   * and exit 0 before running any turn. For smoke tests only — not in --help.
   */
  readonly dumpEngine?: boolean;
  /**
   * HardenedNativeEngine: dispatch tool calls during streaming instead of
   * waiting for the full response. Requires --framework hardened-native.
   */
  readonly eagerToolDispatch?: boolean;
  /**
   * HardenedNativeEngine: compact context mid-turn when tool results push
   * token count above threshold. Requires --framework hardened-native.
   */
  readonly midTurnCompaction?: boolean;
  /**
   * Maximum total tokens (input + output + cache) for the entire run.
   * On exceed, the engine is aborted and the process exits with code 3.
   * Applies to single-agent prompt runs; swarm uses aggregate across workers.
   */
  readonly maxTokens?: number;
  /**
   * Maximum total cost in USD for the entire run, computed via model-pricing.
   * On exceed, the engine is aborted and the process exits with code 3.
   * Skipped for unknown models (only token limit applies).
   */
  readonly maxCostUsd?: number;
  /**
   * Maximum number of agent turns (model round-trips) for the run. On exceed the
   * engine stops (`error_max_turns`) with the work-so-far left on disk. Applies to
   * single-agent prompt runs — the STEP-budget analog of `--max-tokens`, for
   * manufacturing step-bounded headroom in evals (aligns a step-economy lever with
   * a step-denominated budget).
   */
  readonly maxTurns?: number;
}

export type ParsedArgs =
  | { kind: "prompt"; text: string; opts: CommonOpts }
  | { kind: "doctor"; outputFormat: "text" | "json" }
  | { kind: "init"; cwd?: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "worker" }
  | { kind: "team-daemon-entry" }
  | {
      kind: "swarm-run";
      tasksFile: string;
      concurrency: number;
      output: string;
      permissionMode: PermissionMode;
      deadLetter: string;
      allowDeadLetter: boolean;
      role?: string;
      /** v0.5 stage 5B: enable opentasks daemon mirror. */
      opentasks: boolean;
      /** v0.5 stage 5B: explicit opentasks daemon socket path. */
      opentasksSocket?: string;
      /** v0.6 stage 6A.2: enable agent-inbox library-backed InboxBackend. */
      agentInbox: boolean;
      /** v0.7 stage 7A.4: enable git-cascade BranchPolicy adapter. */
      gitCascade: boolean;
      /** v0.7 stage 7H: auto-cleanup worktrees on exit (requires --git-cascade). */
      cleanupWorktrees: boolean;
      /** Default worker model for tasks without an explicit task.model. */
      model?: string;
      /** Raw lane-event JSONL trace path. */
      traceOutput?: string;
    }
  | { kind: "plugin"; pluginArgv: string[] }
  | { kind: "worktree"; worktreeArgv: string[] }
  | { kind: "login"; provider: string; device: boolean }
  | { kind: "logout"; provider: string }
  | { kind: "acp"; opts: CommonOpts }
  | {
      kind: "team-start";
      template: string;
      concurrency: number;
      output: string;
      permissionMode: PermissionMode;
      /** When set, the CLI attaches a MAP-sidecar observer dialing this hub URL. */
      mapUrl?: string;
      /** v0.5 stage 5E.3: when true, fork the team daemon and return immediately. */
      detach: boolean;
      /** Ecosystem adapters — same semantics as swarm-run. */
      opentasks: boolean;
      opentasksSocket?: string;
      agentInbox: boolean;
      gitCascade: boolean;
      cleanupWorktrees: boolean;
    }
  | {
      kind: "topology";
      topologyKind: TopologyKind;
      specPath: string;
      concurrency: number;
      output: string;
      permissionMode: PermissionMode;
      /** When set, the CLI attaches a MAP-sidecar observer dialing this hub URL. */
      mapUrl?: string;
      maxTokens?: number;
      maxCostUsd?: number;
      /** Default worker model for members without an explicit member.model. */
      model?: string;
      /** Raw lane-event JSONL trace path. */
      traceOutput?: string;
      /** Ecosystem adapters — same semantics as swarm-run. */
      opentasks: boolean;
      opentasksSocket?: string;
      agentInbox: boolean;
      gitCascade: boolean;
      cleanupWorktrees: boolean;
    }
  | { kind: "team-send"; name: string; prompt: string }
  | { kind: "team-list" }
  | { kind: "team-status"; name: string }
  | { kind: "team-stop"; name: string }
  | { kind: "team-kill"; name: string }
  | { kind: "team-logs"; name: string; follow: boolean }
  | { kind: "team-watch"; name: string }
  | {
      // docs/44 P5 — OpenHive-compatible host entrypoint.
      kind: "host";
      port: number;
      host?: string;
      adapter?: string;
      // docs/44 Case 2 — outbound MAP (dial a configured hub).
      mapServer?: string;
      mapScope?: string;
      onboardToken?: string;
      permissionMode: PermissionMode;
      model?: string;
    }
  | { kind: "error"; message: string; showHelp: boolean };

// ---------------------------------------------------------------------------
// Known subcommands
// ---------------------------------------------------------------------------

const SUBCOMMANDS = new Set([
  "prompt",
  "doctor",
  "init",
  "help",
  "version",
  "swarm",
  "plugin",
  "login",
  "logout",
  "team",
  "topology",
  "worktree",
  "acp",
  "host",
]);

const SUPPORTED_TOPOLOGY_KINDS = new Set<string>([
  "fanout",
  "pipeline",
  "coordinator",
  "peer-team",
  "committee",
  "critic-loop",
]);

const VALID_PERMISSION_MODES = new Set<string>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const VALID_OUTPUT_FORMATS = new Set<string>(["text", "json"]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse argv. Pass process.argv.slice(2) — node and script path excluded.
 */
export function parseArgv(args: string[]): ParsedArgs {
  // Expand --flag=value into --flag value pairs.
  const expanded = expandEquals(args);

  let i = 0;

  // Defaults for CommonOpts.
  let model: string | undefined;
  let resume: string | undefined;
  let permissionMode: PermissionMode = "workspace-write";
  let outputFormat: "text" | "json" = "text";
  let headless = false;
  let plugins = true;
  let skills = true;
  let mcp = true;
  let hooks = true;
  let dumpTools = false;
  let enableWebSearch = false;
  let plan = false;
  // acp subcommand mode selectors (docs/archive/33). Default resolves in runAcp.
  let acpSingle = false;
  let acpTeam = false;
  let framework: FrameworkChoice = "auto";
  let codexTransport: "sse" | "websocket" | "auto" | undefined;
  let dumpEngine = false;
  // `--device` selects the headless device-code login flow (login subcommand only).
  let device = false;
  let eagerToolDispatch = false;
  let midTurnCompaction = false;
  let maxTokens: number | undefined;
  let maxCostUsd: number | undefined;
  let maxTurns: number | undefined;

  // Defaults for swarm-run (consumed when subcommand === "swarm").
  let swarmConcurrency = 3;
  let swarmOutput = "./results.jsonl";
  let traceOutput: string | undefined;
  let swarmDeadLetter = "./dead-letter.jsonl";
  let swarmAllowDeadLetter = false;
  let swarmRole: string | undefined;

  // --provider flag (used by login / logout subcommands).
  let provider: string | undefined;

  // --map flag (v0.4 stage 4J — team start observability).
  // Optional value: `--map ws://host:port` or `--map` alone (uses MAP_URL env
  // var, falls back to ws://localhost:8080).
  let mapUrl: string | undefined;

  // docs/44 P5 — `host` subcommand state (OpenHive-compatible host).
  let hostPort: number | undefined;
  let hostBindAddr: string | undefined;
  let hostAdapter: string | undefined;
  let hostMapServer: string | undefined;
  let hostMapScope: string | undefined;
  let hostOnboardToken: string | undefined;

  // v0.4 stage 4K — topology subcommand state.
  let specPath: string | undefined;
  // v0.4 stage 4K — `--ecosystem` shorthand. For v0.4 only `--map` is wired;
  // opentasks/agent-inbox/git-cascade land in v0.5+. We track the flag
  // separately from `mapUrl` so an explicit `--map` still wins, and so the
  // dispatch layer can print the v0.4 limitation note exactly once.
  let ecosystem = false;

  // v0.5 stage 5E.3 — --detach flag for `team start`. When set, the parent
  // forks team-daemon-entry and returns 0 once the daemon's socket binds.
  let detach = false;

  // v0.5 stage 5E.5 — --follow flag for `team logs`.
  let follow = false;

  // v0.5 stage 5B — opentasks daemon mirror flags for `swarm run`.
  let opentasks = false;
  let opentasksSocket: string | undefined;

  // v0.6 stage 6A.2 — agent-inbox library backend flag for `swarm run`.
  let agentInbox = false;

  // v0.7 stage 7A.4 — git-cascade BranchPolicy adapter flag for `swarm run`.
  let gitCascade = false;
  // v0.7 stage 7H — auto-cleanup worktrees on exit.
  let cleanupWorktrees = false;

  // First pass: scan for early-exit flags (--help, -h, --version, -V) and
  // collect flags that precede the subcommand / positional.
  // We do a single-pass left-to-right parse so flags can appear anywhere.

  let subcommand: string | undefined;
  const positionals: string[] = [];

  while (i < expanded.length) {
    const tok = expanded[i]!;

    if (tok === "--help" || tok === "-h") {
      return { kind: "help" };
    }

    if (tok === "--version" || tok === "-V") {
      return { kind: "version" };
    }

    // Internal worker flags — not advertised in --help.
    if (tok === "--worker") {
      return { kind: "worker" };
    }
    if (tok === "--team-daemon") {
      // v0.5 stage 5E.3: internal entry for the forked per-team daemon.
      // Reads its spec + paths from OPENSWARM_DAEMON_* env (set by the
      // parent forker in `team start --detach`).
      return { kind: "team-daemon-entry" };
    }

    if (tok === "--agent-id" || tok.startsWith("--agent-id=")) {
      // Accept and ignore — agentId is read from OPENSWARM_AGENT_ID env var.
      // The flag exists only for process-listing clarity.
      if (tok === "--agent-id") {
        i += 2; // skip the value token too
      } else {
        i++;
      }
      continue;
    }

    if (tok === "--headless") {
      headless = true;
      i++;
      continue;
    }

    if (tok === "--no-plugins") {
      plugins = false;
      i++;
      continue;
    }

    if (tok === "--plugins") {
      plugins = true;
      i++;
      continue;
    }

    if (tok === "--no-skills") {
      skills = false;
      i++;
      continue;
    }

    if (tok === "--skills") {
      skills = true;
      i++;
      continue;
    }

    if (tok === "--no-mcp") {
      mcp = false;
      i++;
      continue;
    }

    if (tok === "--mcp") {
      mcp = true;
      i++;
      continue;
    }

    if (tok === "--no-hooks") {
      hooks = false;
      i++;
      continue;
    }

    if (tok === "--hooks") {
      hooks = true;
      i++;
      continue;
    }

    if (tok === "--dump-tools") {
      dumpTools = true;
      i++;
      continue;
    }

    if (tok === "--enable-web-search") {
      enableWebSearch = true;
      i++;
      continue;
    }

    // acp mode selectors (docs/archive/33): --single forces Stage A single-agent;
    // --team forces team mode. Default is resolved in runAcp.
    if (tok === "--single") {
      acpSingle = true;
      i++;
      continue;
    }
    if (tok === "--team") {
      acpTeam = true;
      i++;
      continue;
    }

    if (tok === "--framework") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--framework requires a value",
          showHelp: true,
        };
      }
      if (val !== "native" && val !== "hardened-native" && val !== "claude-agent-sdk" && val !== "codex-chatgpt" && val !== "codex-native" && val !== "auto") {
        return {
          kind: "error",
          message: `invalid --framework "${val}". Valid values: native, hardened-native, claude-agent-sdk, codex-chatgpt, codex-native, auto`,
          showHelp: true,
        };
      }
      framework = val as FrameworkChoice;
      i += 2;
      continue;
    }

    // Internal debug flag — not advertised in --help.
    if (tok === "--dump-engine") {
      dumpEngine = true;
      i++;
      continue;
    }

    // Headless device-code login (login subcommand).
    if (tok === "--device") {
      device = true;
      i++;
      continue;
    }

    if (tok === "--eager-tool-dispatch") {
      eagerToolDispatch = true;
      i++;
      continue;
    }

    if (tok === "--mid-turn-compaction") {
      midTurnCompaction = true;
      i++;
      continue;
    }

    if (tok === "--model") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--model requires a value",
          showHelp: true,
        };
      }
      model = val;
      i += 2;
      continue;
    }

    if (tok === "--codex-transport") {
      const val = expanded[i + 1];
      if (val !== "sse" && val !== "websocket" && val !== "auto") {
        return {
          kind: "error",
          message: `--codex-transport requires one of: sse, websocket, auto`,
          showHelp: true,
        };
      }
      codexTransport = val;
      i += 2;
      continue;
    }

    if (tok === "--resume") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--resume requires a value",
          showHelp: true,
        };
      }
      resume = val;
      i += 2;
      continue;
    }

    if (tok === "--plan") {
      plan = true;
      i += 1;
      continue;
    }

    if (tok === "--permission-mode") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--permission-mode requires a value",
          showHelp: true,
        };
      }
      if (!VALID_PERMISSION_MODES.has(val)) {
        return {
          kind: "error",
          message: `invalid --permission-mode "${val}". Valid values: read-only, workspace-write, danger-full-access`,
          showHelp: true,
        };
      }
      permissionMode = val as PermissionMode;
      i += 2;
      continue;
    }

    if (tok === "--output-format") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--output-format requires a value",
          showHelp: true,
        };
      }
      if (!VALID_OUTPUT_FORMATS.has(val)) {
        return {
          kind: "error",
          message: `invalid --output-format "${val}". Valid values: text, json`,
          showHelp: true,
        };
      }
      outputFormat = val as "text" | "json";
      i += 2;
      continue;
    }

    // Swarm-specific flags: accepted by the main loop so they don't trip the
    // unknown-flag guard. The swarm-run dispatch branch re-reads them from
    // the captured values below.
    if (tok === "--concurrency") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--concurrency requires a value",
          showHelp: true,
        };
      }
      const n = Number.parseInt(val, 10);
      if (Number.isNaN(n) || n < 1) {
        return {
          kind: "error",
          message: `--concurrency must be a positive integer, got "${val}"`,
          showHelp: true,
        };
      }
      swarmConcurrency = n;
      i += 2;
      continue;
    }

    if (tok === "--output") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--output requires a value",
          showHelp: true,
        };
      }
      swarmOutput = val;
      i += 2;
      continue;
    }

    if (tok === "--trace-output") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--trace-output requires a value",
          showHelp: true,
        };
      }
      traceOutput = val;
      i += 2;
      continue;
    }

    // docs/44 P5 — `host` subcommand flags.
    if (tok === "--port") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--port requires a value", showHelp: true };
      }
      const n = Number.parseInt(val, 10);
      if (Number.isNaN(n) || n < 1 || n > 65_533) {
        return {
          kind: "error",
          message: `--port must be a port number (1..65533, leaves room for the +2 stride), got "${val}"`,
          showHelp: true,
        };
      }
      hostPort = n;
      i += 2;
      continue;
    }

    if (tok === "--host") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--host requires a value", showHelp: true };
      }
      hostBindAddr = val;
      i += 2;
      continue;
    }

    if (tok === "--adapter") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--adapter requires a value", showHelp: true };
      }
      hostAdapter = val;
      i += 2;
      continue;
    }

    // docs/44 Case 2 — outbound MAP flags.
    if (tok === "--map-server") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--map-server requires a value", showHelp: true };
      }
      hostMapServer = val;
      i += 2;
      continue;
    }

    if (tok === "--map-scope") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--map-scope requires a value", showHelp: true };
      }
      hostMapScope = val;
      i += 2;
      continue;
    }

    if (tok === "--onboard-token") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return { kind: "error", message: "--onboard-token requires a value", showHelp: true };
      }
      hostOnboardToken = val;
      i += 2;
      continue;
    }

    if (tok === "--dead-letter") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--dead-letter requires a value",
          showHelp: true,
        };
      }
      swarmDeadLetter = val;
      i += 2;
      continue;
    }

    if (tok === "--allow-dead-letter") {
      swarmAllowDeadLetter = true;
      i++;
      continue;
    }

    // v0.4 stage 4J: --map [URL] enables the MAP adapter for `team start`.
    // Value is optional — when omitted, falls back to MAP_URL env var, then
    // ws://localhost:8080. A bare `--map` followed by a flag (or end-of-args)
    // is treated as "no value supplied".
    if (tok === "--map") {
      const next = expanded[i + 1];
      if (next === undefined || next.startsWith("-")) {
        mapUrl = process.env.MAP_URL ?? "ws://localhost:8080";
        i++;
      } else {
        mapUrl = next;
        i += 2;
      }
      continue;
    }

    // --ecosystem shorthand. Enables --map only (when not already set).
    // opentasks/agent-inbox/git-cascade have their own explicit flags on
    // `swarm run` / `topology` / `team start`; print a one-line note so
    // operators don't quietly miss that --ecosystem does not turn those
    // adapters on.
    if (tok === "--ecosystem") {
      ecosystem = true;
      process.stderr.write(
        "[openswarm] --ecosystem enables MAP only; pass --opentasks/--agent-inbox/--git-cascade explicitly.\n",
      );
      i++;
      continue;
    }

    // v0.5 stage 5E.3: --detach for `team start`. Boolean; no value.
    if (tok === "--detach") {
      detach = true;
      i++;
      continue;
    }

    // v0.5 stage 5E.5: --follow for `team logs`. Boolean; no value.
    if (tok === "--follow" || tok === "-f") {
      follow = true;
      i++;
      continue;
    }

    // --opentasks for `swarm run` / `topology` / `team start`. Boolean.
    if (tok === "--opentasks") {
      opentasks = true;
      i++;
      continue;
    }
    if (tok === "--opentasks-socket") {
      const next = expanded[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          kind: "error",
          message: "--opentasks-socket requires a path argument",
          showHelp: true,
        };
      }
      opentasksSocket = next;
      // Setting an explicit socket implies --opentasks.
      opentasks = true;
      i += 2;
      continue;
    }

    // v0.6 stage 6A.2: --agent-inbox enables the library-backed InboxBackend.
    if (tok === "--agent-inbox") {
      agentInbox = true;
      i++;
      continue;
    }

    // v0.7 stage 7A.4: --git-cascade enables the worktree-per-member adapter.
    if (tok === "--git-cascade") {
      gitCascade = true;
      i++;
      continue;
    }

    // v0.7 stage 7H: --cleanup-worktrees opts into worktree cleanup at exit.
    if (tok === "--cleanup-worktrees") {
      cleanupWorktrees = true;
      i++;
      continue;
    }

    // v0.4 stage 4K: --spec <path> for the `topology` subcommand. Required
    // when topology is invoked; ignored otherwise (the topology dispatch is
    // the only consumer).
    if (tok === "--spec") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--spec requires a value",
          showHelp: true,
        };
      }
      specPath = val;
      i += 2;
      continue;
    }

    if (tok === "--role") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--role requires a value",
          showHelp: true,
        };
      }
      swarmRole = val;
      i += 2;
      continue;
    }

    if (tok === "--provider") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--provider requires a value",
          showHelp: true,
        };
      }
      provider = val;
      i += 2;
      continue;
    }

    if (tok === "--max-tokens") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--max-tokens requires a value",
          showHelp: true,
        };
      }
      const n = Number.parseInt(val, 10);
      if (Number.isNaN(n) || n < 1) {
        return {
          kind: "error",
          message: `--max-tokens must be a positive integer, got "${val}"`,
          showHelp: true,
        };
      }
      maxTokens = n;
      i += 2;
      continue;
    }

    if (tok === "--max-cost-usd") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--max-cost-usd requires a value",
          showHelp: true,
        };
      }
      const n = Number.parseFloat(val);
      if (Number.isNaN(n) || n <= 0) {
        return {
          kind: "error",
          message: `--max-cost-usd must be a positive number, got "${val}"`,
          showHelp: true,
        };
      }
      maxCostUsd = n;
      i += 2;
      continue;
    }

    if (tok === "--max-turns") {
      const val = expanded[i + 1];
      if (val === undefined || val.startsWith("-")) {
        return {
          kind: "error",
          message: "--max-turns requires a value",
          showHelp: true,
        };
      }
      const n = Number.parseInt(val, 10);
      if (Number.isNaN(n) || n < 1) {
        return {
          kind: "error",
          message: `--max-turns must be a positive integer, got "${val}"`,
          showHelp: true,
        };
      }
      maxTurns = n;
      i += 2;
      continue;
    }

    // v0.7 stage 7D — pass-through subcommands (worktree, plugin) own their
    // own flag parsing. Once we've identified one, capture all remaining
    // tokens (including --flags) as positionals so the sub-CLI can interpret
    // them. Without this, the global unknown-flag check below rejects things
    // like `worktree clean --dry-run`.
    if (
      subcommand !== undefined &&
      (subcommand === "worktree" || subcommand === "plugin")
    ) {
      positionals.push(tok);
      i++;
      continue;
    }

    // Unknown flag.
    if (tok.startsWith("-")) {
      return {
        kind: "error",
        message: `unknown flag: ${tok}`,
        showHelp: true,
      };
    }

    // Non-flag token — subcommand or positional.
    if (subcommand === undefined && SUBCOMMANDS.has(tok)) {
      subcommand = tok;
    } else {
      positionals.push(tok);
    }
    i++;
  }

  // ---------------------------------------------------------------------------
  // --ecosystem post-processing. v0.4: only --map is wired. If the operator
  // also passed an explicit --map URL we keep that; otherwise default the
  // MAP url to MAP_URL env or ws://localhost:8080.
  // ---------------------------------------------------------------------------
  if (ecosystem && mapUrl === undefined) {
    mapUrl = process.env.MAP_URL ?? "ws://localhost:8080";
  }

  // ---------------------------------------------------------------------------
  // Dispatch on resolved subcommand.
  // ---------------------------------------------------------------------------

  const opts: CommonOpts = {
    model,
    resume,
    // `permissionMode` stays the user's intended ceiling; plan mode narrows the
    // *effective* mode to read-only downstream (runtime + REPL) so `/plan off`
    // can restore write access up to this ceiling.
    permissionMode,
    outputFormat,
    headless,
    plugins,
    skills,
    mcp,
    hooks,
    dumpTools,
    enableWebSearch,
    plan,
    framework,
    codexTransport,
    dumpEngine,
    ...(acpSingle ? { single: true } : {}),
    ...(acpTeam ? { team: true } : {}),
    ...(eagerToolDispatch ? { eagerToolDispatch: true } : {}),
    ...(midTurnCompaction ? { midTurnCompaction: true } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };

  switch (subcommand) {
    case "help":
      return { kind: "help" };

    case "version":
      return { kind: "version" };

    case "doctor":
      return { kind: "doctor", outputFormat };

    case "init": {
      // Optional positional after init is the cwd.
      const cwd = positionals[0];
      return { kind: "init", cwd };
    }

    case "prompt": {
      const text = positionals.join(" ").trim();
      if (text.length === 0) {
        return {
          kind: "error",
          message: 'prompt requires text, e.g. openswarm prompt "say hi"',
          showHelp: true,
        };
      }
      return { kind: "prompt", text, opts };
    }

    case "swarm": {
      // swarm run <tasks-file> [--concurrency N] [--output <path>]
      const subSub = positionals[0];
      if (subSub !== "run") {
        return {
          kind: "error",
          message:
            subSub === undefined
              ? 'swarm requires a sub-subcommand, e.g. swarm run <tasks-file>'
              : `unknown swarm sub-subcommand: ${subSub}`,
          showHelp: true,
        };
      }
      const tasksFile = positionals[1];
      if (tasksFile === undefined) {
        return {
          kind: "error",
          message: "swarm run requires a tasks file path",
          showHelp: true,
        };
      }
      // --concurrency / --output / --permission-mode were consumed by the
      // main flag loop into swarmConcurrency / swarmOutput / permissionMode.
      // positionals[2..] should be empty; surface anything unexpected.
      if (positionals.length > 2) {
        return {
          kind: "error",
          message: `unexpected extra positional for swarm run: ${positionals[2]}`,
          showHelp: true,
        };
      }
      const concurrency = swarmConcurrency;
      const output = swarmOutput;
      const swarmPermissionMode: PermissionMode = permissionMode;

      return {
        kind: "swarm-run",
        tasksFile,
        concurrency,
        output,
        permissionMode: swarmPermissionMode,
        deadLetter: swarmDeadLetter,
        allowDeadLetter: swarmAllowDeadLetter,
        ...(swarmRole !== undefined && { role: swarmRole }),
        opentasks,
        ...(opentasksSocket !== undefined && { opentasksSocket }),
        agentInbox,
        gitCascade,
        cleanupWorktrees,
        ...(model !== undefined && { model }),
        ...(traceOutput !== undefined && { traceOutput }),
      };
    }

    case "plugin": {
      // Pass all remaining positionals (sub-subcommand + args) to pluginMain.
      return { kind: "plugin", pluginArgv: positionals };
    }

    case "worktree": {
      // v0.7 stage 7D — `worktree list|clean` for git-cascade-managed worktrees.
      return { kind: "worktree", worktreeArgv: positionals };
    }

    case "team": {
      // team start <template> [--concurrency N] [--output <path>] [--permission-mode <mode>]
      // `send/list/stop/kill` are daemon RPC clients (see cli/team.ts) that
      // talk to detached team daemons over their Unix sockets.
      const subSub = positionals[0];
      if (subSub === undefined) {
        return {
          kind: "error",
          message:
            "team requires a sub-subcommand, e.g. team start <template>",
          showHelp: true,
        };
      }
      if (subSub === "start") {
        const template = positionals[1];
        if (template === undefined) {
          return {
            kind: "error",
            message: "team start requires a template name",
            showHelp: true,
          };
        }
        if (positionals.length > 2) {
          return {
            kind: "error",
            message: `unexpected extra positional for team start: ${positionals[2]}`,
            showHelp: true,
          };
        }
        return {
          kind: "team-start",
          template,
          concurrency: swarmConcurrency,
          output: swarmOutput,
          permissionMode,
          ...(mapUrl !== undefined && { mapUrl }),
          detach,
          opentasks,
          ...(opentasksSocket !== undefined && { opentasksSocket }),
          agentInbox,
          gitCascade,
          cleanupWorktrees,
        };
      }
      if (subSub === "send") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team send requires a team name",
            showHelp: true,
          };
        }
        // The remaining positionals form the prompt text.
        const promptText = positionals.slice(2).join(" ").trim();
        if (promptText.length === 0) {
          return {
            kind: "error",
            message: "team send requires a prompt, e.g. team send <name> \"hi\"",
            showHelp: true,
          };
        }
        return { kind: "team-send", name, prompt: promptText };
      }
      if (subSub === "list") {
        if (positionals.length > 1) {
          return {
            kind: "error",
            message: `unexpected extra positional for team list: ${positionals[1]}`,
            showHelp: true,
          };
        }
        return { kind: "team-list" };
      }
      if (subSub === "stop") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team stop requires a team name",
            showHelp: true,
          };
        }
        return { kind: "team-stop", name };
      }
      if (subSub === "kill") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team kill requires a team name",
            showHelp: true,
          };
        }
        return { kind: "team-kill", name };
      }
      if (subSub === "status") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team status requires a team name",
            showHelp: true,
          };
        }
        if (positionals.length > 2) {
          return {
            kind: "error",
            message: `unexpected extra positional for team status: ${positionals[2]}`,
            showHelp: true,
          };
        }
        return { kind: "team-status", name };
      }
      if (subSub === "logs") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team logs requires a team name",
            showHelp: true,
          };
        }
        return { kind: "team-logs", name, follow };
      }
      if (subSub === "watch") {
        const name = positionals[1];
        if (name === undefined) {
          return {
            kind: "error",
            message: "team watch requires a team name",
            showHelp: true,
          };
        }
        return { kind: "team-watch", name };
      }
      return {
        kind: "error",
        message: `unknown team sub-subcommand: ${subSub}`,
        showHelp: true,
      };
    }

    case "topology": {
      // topology <kind> --spec <path-to-spec.json>
      const kindStr = positionals[0];
      if (kindStr === undefined) {
        return {
          kind: "error",
          message:
            "topology requires a kind, e.g. topology fanout --spec ./spec.json",
          showHelp: true,
        };
      }
      if (!SUPPORTED_TOPOLOGY_KINDS.has(kindStr)) {
        return {
          kind: "error",
          message: `unknown topology kind: ${kindStr}. Valid: fanout, pipeline, coordinator, peer-team, committee, critic-loop`,
          showHelp: true,
        };
      }
      if (specPath === undefined) {
        return {
          kind: "error",
          message: "topology requires --spec <path-to-spec.json>",
          showHelp: true,
        };
      }
      if (positionals.length > 1) {
        return {
          kind: "error",
          message: `unexpected extra positional for topology: ${positionals[1]}`,
          showHelp: true,
        };
      }
      return {
        kind: "topology",
        topologyKind: kindStr as TopologyKind,
        specPath,
        concurrency: swarmConcurrency,
        output: swarmOutput,
        permissionMode,
        ...(mapUrl !== undefined && { mapUrl }),
        ...(maxTokens !== undefined && { maxTokens }),
        ...(maxCostUsd !== undefined && { maxCostUsd }),
        ...(model !== undefined && { model }),
        ...(traceOutput !== undefined && { traceOutput }),
        opentasks,
        ...(opentasksSocket !== undefined && { opentasksSocket }),
        agentInbox,
        gitCascade,
        cleanupWorktrees,
      };
    }

    case "acp": {
      // `acp` serves over the Agent Client Protocol on stdio. It reads the
      // shared CommonOpts (model, permission-mode, --no-mcp, …); any positional
      // is ignored (the editor/client drives prompts over the wire).
      return { kind: "acp", opts };
    }

    case "host": {
      // docs/44 P5 — OpenHive-compatible host. Binds base/base+1/base+2.
      if (hostPort === undefined) {
        return {
          kind: "error",
          message: "host requires --port <N>, e.g. openswarm host --port 9000",
          showHelp: true,
        };
      }
      // OPENSWARM_MAP_SERVER env is an alias for --map-server (matches cc-swarm).
      const mapServer = hostMapServer ?? process.env.OPENSWARM_MAP_SERVER;
      return {
        kind: "host",
        port: hostPort,
        ...(hostBindAddr !== undefined && { host: hostBindAddr }),
        ...(hostAdapter !== undefined && { adapter: hostAdapter }),
        ...(mapServer !== undefined && mapServer !== "" && { mapServer }),
        ...(hostMapScope !== undefined && { mapScope: hostMapScope }),
        ...(hostOnboardToken !== undefined && { onboardToken: hostOnboardToken }),
        permissionMode,
        ...(model !== undefined && { model }),
      };
    }

    case "login": {
      // --provider was consumed by the main flag loop.
      // Default to claude-agent-sdk when omitted.
      return { kind: "login", provider: provider ?? "claude-agent-sdk", device };
    }

    case "logout": {
      if (!provider) {
        return {
          kind: "error",
          message: "logout requires --provider <name>",
          showHelp: true,
        };
      }
      return { kind: "logout", provider };
    }

    case undefined: {
      // No subcommand — if there are positionals, treat as bare prompt.
      if (positionals.length > 0) {
        const text = positionals.join(" ").trim();
        return { kind: "prompt", text, opts };
      }
      // Nothing at all — show help.
      return { kind: "help" };
    }

    default:
      // Should never reach here since we gate on SUBCOMMANDS.has().
      return {
        kind: "error",
        message: `unknown subcommand: ${subcommand}`,
        showHelp: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Expand --flag=value tokens into ["--flag", "value"] pairs.
 * Short flags (-h, -V) are left as-is.
 */
function expandEquals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const eqIdx = arg.indexOf("=");
      out.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      out.push(arg);
    }
  }
  return out;
}
