/**
 * /plugin — read + flip enable bits for installed plugins.
 *
 * Scope (doc 17 Q2): list, enable, disable only. install / update / uninstall
 * stay CLI-only for v0.1 because:
 *   - install runs subprocesses (git clone, bash -c) that interact poorly with
 *     the OpenTUI REPL's stdio ownership.
 *   - enable/disable changes only take effect on next session start (no
 *     runtime tool re-registration in v0.1).
 *
 * Uses ctx.pluginStore if present, otherwise constructs a default store
 * pointing at ~/.swarm-harness/plugins/ (doc 17 Q1).
 */

import type { SlashCommand } from "../index.js";
import { PluginStateStore } from "../../../plugins/state.js";

const USAGE = "usage: /plugin <list|enable|disable> [id]";
const DEFERRED =
  "install, update, and uninstall are CLI-only in v0.1 — run `openswarm plugin <sub>` from a shell.";

export const pluginCommand: SlashCommand = {
  name: "plugin",
  description: "List, enable, or disable installed plugins",

  async execute(ctx) {
    const sub = ctx.args[0];
    if (sub === undefined) {
      return { kind: "error", message: USAGE };
    }

    const store = ctx.pluginStore ?? new PluginStateStore();

    switch (sub) {
      case "list":
        return await runList(store);
      case "enable":
      case "disable":
        return await runSetEnabled(store, sub, ctx.args[1]);
      case "install":
      case "update":
      case "uninstall":
        return { kind: "error", message: DEFERRED };
      default:
        return {
          kind: "error",
          message: `unknown /plugin subcommand: ${sub}. ${USAGE}`,
        };
    }
  },
};

async function runList(
  store: PluginStateStore,
): Promise<{ kind: "message"; text: string }> {
  const state = await store.read();
  const ids = Object.keys(state.versions);
  if (ids.length === 0) {
    return { kind: "message", text: "no plugins installed" };
  }
  const lines = ids.map((id) => {
    const version = state.versions[id] ?? "?";
    const enabled = state.enabled.includes(id) ? "enabled" : "disabled";
    return `  ${id} v${version} (${enabled})`;
  });
  return {
    kind: "message",
    text: `plugins (${ids.length}):\n${lines.join("\n")}`,
  };
}

async function runSetEnabled(
  store: PluginStateStore,
  sub: "enable" | "disable",
  id: string | undefined,
): Promise<
  | { kind: "error"; message: string }
  | { kind: "message"; text: string }
> {
  if (id === undefined || id.length === 0) {
    return { kind: "error", message: `usage: /plugin ${sub} <id>` };
  }
  try {
    await store.setEnabled(id, sub === "enable");
    return {
      kind: "message",
      text: `plugin '${id}' ${sub === "enable" ? "enabled" : "disabled"} (takes effect next session)`,
    };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
