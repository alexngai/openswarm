/**
 * streaming.ts — Partial JSON field extraction for streaming tool args.
 *
 * Phase 4: tool args arrive as incremental JSON fragments via tool-args-delta.
 * This module extracts named fields from possibly-incomplete JSON so the chip
 * header can show the file path, command, etc. before the tool call finishes.
 */

/**
 * Extracts a string-valued field from a possibly incomplete JSON string.
 * Returns the field value (possibly truncated if the JSON is cut mid-value),
 * or undefined if the field hasn't appeared yet.
 *
 * Handles:
 * - Complete field: `{"file_path": "src/main.ts", ...}` → "src/main.ts"
 * - Truncated value: `{"file_path": "src/ma` → "src/ma"
 * - Escaped quotes: `{"cmd": "echo \"hi\""}` → `echo "hi"`
 * - Field not yet seen: `{"com` → undefined
 */
export function extractPartialJsonField(
  json: string,
  fieldName: string,
): string | undefined {
  // Match `"fieldName"` followed by `:` and then a string value.
  // The value may be complete ("value") or truncated ("val without closing quote).
  const pattern = new RegExp(
    `"${escapeRegex(fieldName)}"\\s*:\\s*"`,
  );
  const match = pattern.exec(json);
  if (match === null) return undefined;

  const startIndex = match.index + match[0].length;
  let result = "";
  let escaped = false;

  for (let i = startIndex; i < json.length; i++) {
    const ch = json[i];
    if (escaped) {
      if (ch === "n") result += "\n";
      else if (ch === "t") result += "\t";
      else if (ch === "r") result += "\r";
      else if (ch === "\\") result += "\\";
      else if (ch === '"') result += '"';
      else if (ch === "/") result += "/";
      else result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return result;
    }
    result += ch;
  }

  // Truncated — return what we have.
  return result.length > 0 ? result : undefined;
}

/**
 * Try to parse streaming args as partial JSON, extracting a specific field.
 * Falls back to `extractPartialJsonField` when `JSON.parse` fails.
 */
export function getStreamingArg(
  streamingArgs: string,
  fieldName: string,
): string | undefined {
  if (streamingArgs.length === 0) return undefined;

  // Fast path: try full parse first.
  try {
    const parsed = JSON.parse(streamingArgs);
    if (parsed !== null && typeof parsed === "object") {
      const val = (parsed as Record<string, unknown>)[fieldName];
      if (typeof val === "string") return val;
    }
  } catch {
    // Incomplete JSON — fall through to partial extraction.
  }

  return extractPartialJsonField(streamingArgs, fieldName);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
