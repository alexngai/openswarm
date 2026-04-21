/**
 * Tier 2 — swarm primitives.
 *
 * Tools that coordinate multiple agents: task registry access (create /
 * update / get / list) and sub-agent spawning (agent).
 *
 * Each tool requires a SwarmHost via ctx.host. See
 * docs/04-tool-tiers.md §Tier 2 for the tier catalog.
 */

import type { ToolImpl } from "../types.js";

import { agentTool } from "./agent.js";
import { taskCreateTool } from "./task_create.js";
import { taskGetTool } from "./task_get.js";
import { taskListTool } from "./task_list.js";
import { taskUpdateTool } from "./task_update.js";
import { sendMessageTool } from "./send_message.js";
import { checkInboxTool } from "./check_inbox.js";
import { taskStopTool } from "./task_stop.js";
import { taskOutputTool } from "./task_output.js";

/** All Tier 2 tools in a stable order. */
export function buildTier2Tools(): readonly ToolImpl[] {
  return [
    taskCreateTool,
    taskUpdateTool,
    taskGetTool,
    taskListTool,
    agentTool,
    sendMessageTool,
    checkInboxTool,
    taskStopTool,
    taskOutputTool,
  ] as const;
}

export {
  agentTool,
  taskCreateTool,
  taskGetTool,
  taskListTool,
  taskUpdateTool,
  sendMessageTool,
  checkInboxTool,
  taskStopTool,
  taskOutputTool,
};
