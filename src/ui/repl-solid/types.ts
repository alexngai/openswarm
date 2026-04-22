/**
 * types.ts — plain-TS types shared between the JSX components and the
 * non-JSX entry points (index.ts). Kept JSX-free so main tsc can resolve
 * these types without being pulled into Solid's JSX world.
 */

import type { NormalizedEvent, PermissionMode } from "../../core/types.js";
import type { SlashCommandRegistry } from "../repl/state.js";
import type { BuildDefaultRegistryDeps } from "../../cli/slash/index.js";

export interface AppProps {
  readonly events: AsyncIterable<NormalizedEvent>;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly getTokens?: () => number;
  /** Called when the REPL transitions to shutdown (e.g. SIGINT, /exit). */
  readonly onExit?: () => void;
  /** Called when the user submits a non-slash prompt. */
  readonly onSubmit?: (line: string) => void;
  /** Slash command registry. If omitted, slash input is treated as a normal prompt. */
  readonly registry?: SlashCommandRegistry;
  /** Deps threaded into every SlashCommandContext. */
  readonly slashDeps?: BuildDefaultRegistryDeps;
  /** Called when /resume dispatches a session-id event. */
  readonly onSessionId?: (sessionId: string) => void;
}
