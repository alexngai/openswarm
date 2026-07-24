/**
 * runAcp — serve OpenSwarm over the Agent Client Protocol on stdio.
 *
 * Builds the shared agent runtime, wraps stdin/stdout as an
 * ndjson JSON-RPC stream, and hands an AcpAgent to the SDK's
 * AgentSideConnection. stdout is reserved exclusively for protocol frames —
 * `redirectConsoleToStderr()` keeps stray logging off the wire.
 */

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { buildAgentRuntime } from "../cli/runtime.js";
import { AcpAgent } from "./agent.js";
import {
  createTeamConnection,
  type TeamConnection,
} from "./team-connection.js";
import type { CommonOpts } from "../cli/argv.js";

/**
 * Default ACP mode (B0.6): `acp` serves a coordinator team. `--single` opts
 * back into the Stage A single agent; `--team` is the explicit opposite.
 */
const TEAM_DEFAULT = true;

function wantsTeam(opts: CommonOpts): boolean {
  if (opts.single) return false;
  if (opts.team) return true;
  return TEAM_DEFAULT;
}

function stdioStream(): ReturnType<typeof ndJsonStream> {
  const output = Writable.toWeb(
    process.stdout,
  ) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(
    process.stdin,
  ) as unknown as ReadableStream<Uint8Array>;
  return ndJsonStream(output, input);
}

/**
 * Reserve stdout for JSON-RPC: route all console.* to stderr. The runtime's
 * own progress lines already write to stderr; this guards library code that
 * might `console.log`.
 */
function redirectConsoleToStderr(): void {
  /* eslint-disable no-console */
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
  /* eslint-enable no-console */
}

export async function runAcp(opts: CommonOpts): Promise<number> {
  redirectConsoleToStderr();
  return wantsTeam(opts) ? runAcpTeam(opts) : runAcpSingle(opts);
}

/** Stage A: serve one agent over ACP. */
async function runAcpSingle(opts: CommonOpts): Promise<number> {
  // ACP is a non-TTY JSONL-style surface: force headless so the runtime never
  // mounts the REPL or writes UI chrome to stdout.
  const built = await buildAgentRuntime({ ...opts, headless: true });
  if (built.kind === "exit") return built.code;
  const rt = built.runtime;

  const connection = new AgentSideConnection(
    (conn) => new AcpAgent(conn, rt, opts),
    stdioStream(),
  );

  // Block until the client disconnects (stdin EOF or stream error).
  await connection.closed;

  // Best-effort MCP shutdown (the runtime also registers a process exit hook).
  for (const c of rt.mcpClients) {
    try {
      await c.close();
    } catch {
      // best effort
    }
  }
  return 0;
}

/** Stage B: serve a coordinator team over ACP. */
async function runAcpTeam(opts: CommonOpts): Promise<number> {
  // Per-connection team wiring (router + runner + spine) lives in
  // createTeamConnection, shared with the host ACP-WS path (docs/44 P6).
  // Permission escalation for spawned workers is enabled because the runner
  // holds the router as its interactionHandler.
  let teamConn: TeamConnection | undefined;
  const connection = new AgentSideConnection((conn) => {
    teamConn = createTeamConnection(conn, opts);
    return teamConn.agent;
  }, stdioStream());
  await connection.closed;

  // Flush the spine + tear down the persistent root the team kept alive across
  // prompts (B0.5).
  try {
    await teamConn?.close();
  } catch {
    // best effort
  }
  return 0;
}
