/**
 * map-protocol.ts — minimal MAP (Multi-Agent Protocol) shim.
 *
 * Mirrors the wire shape exposed by `@multi-agent-protocol/sdk`'s
 * `AgentConnection`. Used in tests + as the contract our adapter codes against.
 * When the real SDK is installed, the production factory in `src/cli/main.ts`
 * wraps it via duck-typing and adapts to this interface.
 *
 * v0.4 stage 4J: keep the SDK out of the dependency closure unless `--map` is
 * actually used at runtime. Adapter takes a `MapClientFactory` injection so
 * tests can inject fakes without spinning up a real ws:// server.
 */

export interface MapAgentConnection {
  /** Request/response — used for `swarm.*` calls that expect an ack. */
  send(method: string, params: unknown): Promise<void>;
  /** Fire-and-forget notification — used for high-volume lane forwarding. */
  notify(method: string, params: unknown): void;
  /** Close the connection. Best-effort — adapter swallows errors. */
  close(): Promise<void>;
}

export interface MapAgentConnectOptions {
  /** WebSocket URL of the MAP server (e.g. `ws://localhost:8080`). */
  readonly url: string;
  /** Scope identifier, per V0.4.Q7 (e.g. `swarm:<teamName>:<pid>`). */
  readonly scope: string;
  /** Self-identification announced to the MAP server on connect. */
  readonly agentInfo: { readonly name: string; readonly role: string };
  /** Optional capability advertisement. */
  readonly capabilities?: Record<string, unknown>;
}

export interface MapClientFactory {
  connect(opts: MapAgentConnectOptions): Promise<MapAgentConnection>;
}
