/**
 * `define_guard` — let the agent synthesize a compliance guard mid-episode.
 *
 * docs/63 P0. When the agent notices it has repeated a *compliance* failure
 * (malformed call, missing precondition, forgotten step) it can install a
 * restrictive predicate that makes the failure structurally impossible for the
 * rest of the episode, rather than relying on remembering not to repeat it.
 *
 * The registry seam mirrors `request_permissions`: a module-level handler set
 * by whichever runtime owns the episode, so the tool degrades cleanly (a clear
 * error, never a throw) where no registry is wired.
 *
 * Deliberately NOT in `buildTier0Tools()` — like `request_permissions`, this
 * mutates the running harness, so it is registered explicitly by runtimes that
 * opt in rather than advertised on every surface (ACP bridges, swarm workers).
 */

import { z } from "zod";
import type { JsonSchema, ToolSpec } from "../../core/types.js";
import type { ToolExecutionContext, ToolImpl, ToolResult } from "../types.js";
import {
  GuardRegistry,
  guardId,
  guardPredicateSchema,
  touchedFields,
  type HarnessGuard,
} from "../../harness/guards.js";

// ---------------------------------------------------------------------------
// Registry seam
// ---------------------------------------------------------------------------

let _registry: GuardRegistry | undefined;

export function setGuardRegistry(registry: GuardRegistry): void {
  _registry = registry;
}

export function clearGuardRegistry(): void {
  _registry = undefined;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// A single top-level object, NOT a discriminated union. OpenAI/Azure function
// calling requires the root `parameters` schema to be `type: "object"`; a Zod
// discriminated union serialises to a root `anyOf` with no `type`, which Azure
// rejects with `invalid_function_parameters` ("got type None"). Per-action
// required fields are therefore validated in `execute` rather than by the
// schema. (Caught only under a live provider — the offline tests parsed the
// union fine.)
const inputSchema = z.object({
  action: z
    .enum(["define", "remove", "list"])
    .describe(
      "define: install a guard · remove: delete one by id · list: show installed guards.",
    ),
  target_tool: z
    .string()
    .min(1)
    .optional()
    .describe("define: the tool whose calls this guard gates, e.g. \"edit_file\"."),
  predicate: guardPredicateSchema
    .optional()
    .describe("define: block the call when this evaluates true. Combine with all/any/not."),
  message: z
    .string()
    .min(1)
    .optional()
    .describe(
      "define: shown to you when the guard blocks a call. State how to comply, not just what went wrong.",
    ),
  failure_signature: z
    .string()
    .min(1)
    .optional()
    .describe(
      "define: short stable slug for the failure this prevents, e.g. \"stale-lockfile\". Used for attribution.",
    ),
  guard_id: z.string().min(1).optional().describe("remove: the id of the guard to remove."),
});

const spec: ToolSpec = {
  name: "define_guard",
  description:
    "Install a restrictive guard on a tool so a compliance failure you have already hit " +
    "cannot recur this session. A guard is a predicate over a tool call's input: when it " +
    "matches, the call is blocked with your message instead of executing. " +
    "Use this after you repeat the same avoidable mistake (malformed argument, missing " +
    "precondition, forgotten step) — it makes the mistake impossible rather than merely " +
    "discouraged. Guards can only BLOCK calls; they can never grant new capability. " +
    "Actions: define | remove | list.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
  concurrencySafe: false,
};

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

async function execute(
  raw: unknown,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input = parsed.data;

  if (_registry === undefined) {
    return {
      status: "error",
      message:
        "Harness guards are not available in this environment. " +
        "This runtime does not support mid-session harness edits.",
    };
  }

  if (input.action === "list") {
    const summary = _registry.summary();
    if (summary.guardCount === 0) {
      return { status: "ok", output: "No guards are installed." };
    }
    const lines = summary.perGuard.map(
      (g) =>
        `${g.id}  tool=${g.targetTool}  signature=${g.failureSignature}  ` +
        `evaluated=${g.evidence.evaluated} fired=${g.evidence.fired}`,
    );
    return {
      status: "ok",
      output: `${summary.guardCount} guard(s) installed; ${summary.totalFired} call(s) blocked.\n${lines.join("\n")}`,
    };
  }

  if (input.action === "remove") {
    if (input.guard_id === undefined) {
      return { status: "error", message: "remove requires guard_id." };
    }
    const removed = _registry.remove(input.guard_id);
    return removed
      ? { status: "ok", output: `Guard ${input.guard_id} removed.` }
      : { status: "error", message: `No guard with id ${input.guard_id}.` };
  }

  // action === "define" — the fields the union used to guarantee are now
  // optional at the schema level, so validate them here.
  if (
    input.target_tool === undefined ||
    input.predicate === undefined ||
    input.message === undefined ||
    input.failure_signature === undefined
  ) {
    return {
      status: "error",
      message:
        "define requires target_tool, predicate, message, and failure_signature.",
    };
  }

  const id = guardId(input.target_tool, input.predicate);
  const guard: HarnessGuard = {
    id,
    targetTool: input.target_tool,
    predicate: input.predicate,
    message: input.message,
    failureSignature: input.failure_signature,
    effect: "restrictive",
  };

  // Validation gate (docs/63 §10.4): reject an over-broad guard BEFORE it can
  // enforce. A guard that would have blocked a call already seen to succeed
  // this session is too broad — installing it would harm legitimate work (the
  // Nova Pro `replace_all`-default pathology). Hand the blocked sample back so
  // the agent can narrow the predicate and retry.
  const verdict = _registry.validate(guard);
  if (!verdict.ok) {
    return {
      status: "error",
      message:
        `Guard rejected: it would block ${verdict.blockedCount} of ` +
        `${verdict.checkedSamples ?? verdict.blockedCount} recent successful ${input.target_tool} ` +
        `call(s) this session — it is too broad and would break legitimate work. ` +
        `Example blocked call: ${JSON.stringify(verdict.sample)}. ` +
        `Narrow the predicate so it matches only the failing case, then retry.`,
    };
  }

  const added = _registry.register(guard);
  const touched = touchedFields(input.predicate);
  const fields = touched.length > 0 ? touched.join(", ") : "(none)";

  return {
    status: "ok",
    output: added
      ? `Guard ${id} installed on ${input.target_tool}. Calls matching the predicate will be ` +
        `blocked for the rest of this session. Fields read: ${fields}.`
      : `Guard ${id} is already installed on ${input.target_tool} (no change). Fields read: ${fields}.`,
  };
}

export const defineGuardTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
