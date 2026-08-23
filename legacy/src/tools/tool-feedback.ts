import type { ToolSpec } from "../core/types.js";
import {
  boundedEditDistance,
  TOOL_NAME_ALIASES,
} from "../providers/tool-call-repair.js";

function sortedToolNames(specs: readonly ToolSpec[]): readonly string[] {
  return specs.map((s) => s.name).sort((a, b) => a.localeCompare(b));
}

/**
 * Closest registered names to a rejected one, for a "did you mean" hint. The
 * repair layer (docs/63) resolves unambiguous cases before dispatch, so by the
 * time this runs the name was either ambiguous or genuinely invented — naming
 * the near misses is the most useful thing left to tell the model.
 */
function nearestToolNames(
  requested: string,
  available: readonly string[],
  limit = 3,
): readonly string[] {
  const normalized = requested.toLowerCase().replace(/[^a-z0-9]/g, "");
  return available
    .map((name) => ({
      name,
      distance: boundedEditDistance(
        normalized,
        name.toLowerCase().replace(/[^a-z0-9]/g, ""),
        4,
      ),
    }))
    .filter((entry) => entry.distance <= 4)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.name);
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function correctionForUnknownTool(
  requestedName: string,
  available: ReadonlySet<string>,
): string {
  // Single source of truth with the repair layer's alias table, so a name that
  // repair would have resolved is described the same way here.
  const canonical = TOOL_NAME_ALIASES[requestedName.toLowerCase()];
  if (canonical === "bash" && available.has("bash")) {
    return 'Use tool `bash` with arguments like {"command":"pwd"}.';
  }
  if (canonical === "edit_file") {
    if (available.has("edit_file")) {
      return "Use tool `edit_file` for exact-string replacements, or `bash` with a concrete shell command when shell editing is required.";
    }
    if (available.has("bash")) {
      return "Use tool `bash` with a concrete shell command, for example {\"command\":\"python - <<'PY'\\nfrom pathlib import Path\\n...\\nPY\"}.";
    }
  }
  if (canonical !== undefined && available.has(canonical)) {
    return `Use tool \`${canonical}\` instead of \`${requestedName}\`.`;
  }
  return "Retry using one of the exact tool names listed above; do not invent aliases or pseudo-tools.";
}

export function formatUnknownToolFeedback(
  requestedName: string,
  specs: readonly ToolSpec[],
): string {
  const names = sortedToolNames(specs);
  const available = new Set(names);
  const nearest = nearestToolNames(requestedName, names);
  return [
    `invalid_tool_name: \`${requestedName}\` is not an available tool.`,
    `Available tools: ${names.map((n) => `\`${n}\``).join(", ")}.`,
    ...(nearest.length > 0
      ? [`Closest matches: ${nearest.map((n) => `\`${n}\``).join(", ")}.`]
      : []),
    correctionForUnknownTool(requestedName, available),
  ].join("\n");
}

function requiredKeysFromSchema(schema: unknown): readonly string[] {
  if (
    schema !== null &&
    typeof schema === "object" &&
    Array.isArray((schema as { required?: unknown }).required)
  ) {
    return (schema as { required: unknown[] }).required.filter(
      (v): v is string => typeof v === "string",
    );
  }
  return [];
}

function correctionForSchemaError(
  toolName: string,
  input: unknown,
): string | undefined {
  if (
    toolName === "bash" &&
    input !== null &&
    typeof input === "object" &&
    "cmd" in input &&
    !("command" in input)
  ) {
    return 'Use {"command":"..."} rather than {"cmd":"..."}.';
  }
  if (
    toolName === "read_file" &&
    input !== null &&
    typeof input === "object" &&
    "file" in input &&
    !("path" in input)
  ) {
    return 'Use {"path":"..."} rather than {"file":"..."}.';
  }
  return undefined;
}

export function formatToolSchemaFeedback(args: {
  readonly toolName: string;
  readonly input: unknown;
  readonly inputSchema: unknown;
  readonly validationMessage: string;
}): string {
  const required = requiredKeysFromSchema(args.inputSchema);
  const correction = correctionForSchemaError(args.toolName, args.input);
  return [
    `invalid_tool_arguments for \`${args.toolName}\`.`,
    required.length > 0
      ? `Required keys: ${required.map((k) => `\`${k}\``).join(", ")}.`
      : "Check the advertised JSON schema for this tool.",
    `Received: ${compactJson(args.input)}.`,
    `Validation error: ${args.validationMessage}`,
    correction ?? "Retry with arguments that match the tool's JSON schema exactly.",
  ].join("\n");
}

export function buildToolUseWarmupPrompt(
  specs: readonly ToolSpec[],
): string {
  const names = sortedToolNames(specs);
  const hasBash = names.includes("bash");
  const lines = [
    "## Tool Interface Warmup",
    "",
    `Available tool names are exact strings: ${names.map((n) => `\`${n}\``).join(", ")}.`,
    "Do not invent aliases such as `shell`, `terminal`, `exec`, `run_command`, `edit`, `apply_patch`, or `python`.",
    "If a tool result reports `invalid_tool_name` or `invalid_tool_arguments`, correct the next call using the exact tool name and schema from that result.",
  ];
  if (hasBash) {
    lines.push(
      'Before solving the task, make one lightweight warmup call to `bash` with {"command":"pwd"}, then continue with the real task.',
      'For shell commands, always use `bash` with a JSON object containing `command`, for example {"command":"python -m unittest discover -s tests"}.',
    );
  }
  return lines.join("\n");
}
