/**
 * text-tool-call-parser — last-resort extraction of tool calls that arrived as
 * plain assistant text instead of structured `tool_calls`.
 *
 * This is the failure mode that costs the most and diagnoses the worst. When a
 * self-hosted server is started without `--enable-auto-tool-choice` /
 * `--tool-call-parser`, or its parser does not match the model family, the
 * model still emits a perfectly good tool call — in its own native syntax,
 * as ordinary content. Nothing downstream sees a `tool-call` event, the turn
 * buffers zero tool uses, and the engine reads that as a terminal turn. The
 * agent stops after one turn having narrated the call it never made
 * (docs/63-tool-call-repair.md §1).
 *
 * The formats below are the native tool-call syntaxes of the model families
 * commonly self-hosted for coding work. They are all *delimited* — a model does
 * not emit `<|python_tag|>` or `<tool_call>` in prose by accident — which is
 * why extracting them is safe enough to be on by default. Undelimited forms
 * (a bare JSON object that happens to have `name` and `arguments` keys) are
 * gated behind `allowBareJson`, since a model legitimately *discussing* a tool
 * call in its final answer would otherwise be hijacked into making one.
 *
 * Pure and dependency-free. Policy lives in
 * `src/engine/tool-call-recovery.ts`.
 */

import { extractFirstJsonRegion } from "./tool-call-repair.js";

/** Which native syntax an extracted call was written in. */
export type ToolCallTextFormat =
  | "hermes" // <tool_call>{"name":…,"arguments":{…}}</tool_call>  (Qwen, Hermes, many finetunes)
  | "python_tag" // <|python_tag|>{"name":…,"parameters":{…}}          (Llama 3.1 JSON tool format)
  | "function_tag" // <function=name>{…}</function>                      (Llama 3.2 / Groq)
  | "mistral" // [TOOL_CALLS] [{"name":…,"arguments":{…}}]         (Mistral / Mixtral)
  | "deepseek" // <｜tool▁call▁begin｜>…                              (DeepSeek V3/R1)
  | "fenced_json" // ```json {"name":…,"arguments":{…}} ```
  | "bare_json"; // {"name":…,"arguments":{…}}

export interface ExtractedToolCall {
  /** Tool name exactly as written — resolution happens in tool-call-repair. */
  readonly name: string;
  /** Raw argument text; may be malformed, `coerceArgumentJson` handles it. */
  readonly rawArguments: string;
  readonly format: ToolCallTextFormat;
  /** `[start, end)` offsets in the source text, for excision before replay. */
  readonly span: readonly [number, number];
}

export interface ExtractOptions {
  /**
   * Also match undelimited JSON objects carrying `name` + arguments. Off by
   * default: prose that merely describes a tool call would otherwise be
   * executed.
   */
  readonly allowBareJson?: boolean;
}

/**
 * Cheap pre-check: does this text contain anything that looks like a
 * text-format tool call? Lets callers skip the full scan (and, more usefully,
 * lets diagnostics fire on a turn that ended with zero tool calls).
 */
export function looksLikeTextToolCall(text: string): boolean {
  return /<\|?(?:tool_call|python_tag|tool▁call)|<function=|\[TOOL_CALLS\]/i.test(text);
}

/** Pull `{"name": …}` / `{"arguments": …}` out of an already-isolated blob. */
function readNameAndArguments(
  blob: string,
): { name: string; rawArguments: string } | undefined {
  const region = extractFirstJsonRegion(blob) ?? blob;
  const nameMatch = /"(?:name|function|tool|tool_name|recipient_name)"\s*:\s*"([^"]+)"/.exec(
    region,
  );
  if (nameMatch === null) return undefined;
  const name = nameMatch[1]!;

  // Locate the argument object by key, then take the balanced region after it.
  const argKeyMatch =
    /"(?:arguments|parameters|args|input|tool_input|kwargs)"\s*:\s*/.exec(region);
  if (argKeyMatch === null) {
    return { name, rawArguments: "{}" };
  }
  const after = region.slice(argKeyMatch.index + argKeyMatch[0].length);
  // Arguments may themselves be a JSON-encoded string; hand the raw slice to
  // coerceArgumentJson either way.
  const argRegion = extractFirstJsonRegion(after);
  return { name, rawArguments: argRegion ?? after.trim() };
}

interface RawMatch {
  readonly blob: string;
  readonly span: readonly [number, number];
  readonly format: ToolCallTextFormat;
  /** Set when the format encodes the name in the delimiter itself. */
  readonly explicitName?: string;
}

/** Collect delimited candidate regions, in source order. */
function collectDelimited(text: string): RawMatch[] {
  const matches: RawMatch[] = [];

  // 1. Hermes / Qwen — <tool_call> … </tool_call>. Closing tag optional
  //    (truncated streams routinely drop it).
  const hermes = /<\|?tool_call\|?>([\s\S]*?)(?:<\/\|?tool_call\|?>|$)/gi;
  for (let m = hermes.exec(text); m !== null; m = hermes.exec(text)) {
    matches.push({
      blob: m[1]!,
      span: [m.index, m.index + m[0].length],
      format: "hermes",
    });
  }

  // 2. Llama 3.1 — <|python_tag|>{…} terminated by <|eom_id|>/<|eot_id|>.
  const pythonTag = /<\|python_tag\|>([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/gi;
  for (let m = pythonTag.exec(text); m !== null; m = pythonTag.exec(text)) {
    matches.push({
      blob: m[1]!,
      span: [m.index, m.index + m[0].length],
      format: "python_tag",
    });
  }

  // 3. Llama 3.2 / Groq — <function=name>{…}</function>.
  const functionTag = /<function=([A-Za-z0-9_.\-]+)>([\s\S]*?)(?:<\/function>|$)/gi;
  for (let m = functionTag.exec(text); m !== null; m = functionTag.exec(text)) {
    matches.push({
      blob: m[2]!,
      span: [m.index, m.index + m[0].length],
      format: "function_tag",
      explicitName: m[1]!,
    });
  }

  // 4. Mistral — [TOOL_CALLS] [ … ].
  const mistral = /\[TOOL_CALLS\]\s*([\s\S]*)$/i.exec(text);
  if (mistral !== null) {
    matches.push({
      blob: mistral[1]!,
      span: [mistral.index, mistral.index + mistral[0].length],
      format: "mistral",
    });
  }

  // 5. DeepSeek — <｜tool▁call▁begin｜> … <｜tool▁call▁end｜>. The name sits
  //    between the separator and the fenced JSON payload.
  const deepseek =
    /<｜tool▁call▁begin｜>[\s\S]*?<｜tool▁sep｜>\s*([A-Za-z0-9_.\-]+)([\s\S]*?)(?:<｜tool▁call▁end｜>|$)/g;
  for (let m = deepseek.exec(text); m !== null; m = deepseek.exec(text)) {
    matches.push({
      blob: m[2]!,
      span: [m.index, m.index + m[0].length],
      format: "deepseek",
      explicitName: m[1]!,
    });
  }

  return matches;
}

/** Collect undelimited candidates (fenced or bare JSON carrying a name). */
function collectUndelimited(text: string): RawMatch[] {
  const matches: RawMatch[] = [];

  const fenced = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)\n?\s*```/gi;
  for (let m = fenced.exec(text); m !== null; m = fenced.exec(text)) {
    const blob = m[1]!;
    if (!/"(?:name|function|tool|tool_name)"\s*:/.test(blob)) continue;
    matches.push({
      blob,
      span: [m.index, m.index + m[0].length],
      format: "fenced_json",
    });
  }

  // Bare object — require both a name key and an argument key so an arbitrary
  // JSON literal in prose is not mistaken for a call.
  const bare = /\{[\s\S]*?"(?:name|function|tool|tool_name)"\s*:\s*"[^"]+"[\s\S]*?\}/g;
  for (let m = bare.exec(text); m !== null; m = bare.exec(text)) {
    if (!/"(?:arguments|parameters|args|input|tool_input)"\s*:/.test(m[0])) continue;
    // Overlap with a fenced match is resolved later by dropOverlaps.
    const region = extractFirstJsonRegion(text.slice(m.index)) ?? m[0];
    matches.push({
      blob: region,
      span: [m.index, m.index + region.length],
      format: "bare_json",
    });
  }

  return matches;
}

/** Drop candidates whose span is contained in an earlier, higher-confidence one. */
function dropOverlaps(matches: readonly RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => a.span[0] - b.span[0]);
  const kept: RawMatch[] = [];
  for (const candidate of sorted) {
    const covered = kept.some(
      (k) => candidate.span[0] >= k.span[0] && candidate.span[1] <= k.span[1],
    );
    if (!covered) kept.push(candidate);
  }
  return kept;
}

/**
 * Extract every tool call written in a native text format from `text`, in
 * source order. Returns `[]` when there are none — the overwhelmingly common
 * case, and the cheap pre-check keeps it that way.
 */
export function extractToolCallsFromText(
  text: string,
  options: ExtractOptions = {},
): readonly ExtractedToolCall[] {
  if (text.length === 0) return [];

  const candidates = collectDelimited(text);
  if (options.allowBareJson === true) {
    candidates.push(...collectUndelimited(text));
  }
  if (candidates.length === 0) return [];

  const results: ExtractedToolCall[] = [];
  for (const candidate of dropOverlaps(candidates)) {
    if (candidate.explicitName !== undefined) {
      const region = extractFirstJsonRegion(candidate.blob);
      results.push({
        name: candidate.explicitName,
        rawArguments: region ?? candidate.blob.trim(),
        format: candidate.format,
        span: candidate.span,
      });
      continue;
    }

    // Mistral emits an array of calls; take each element.
    if (candidate.format === "mistral") {
      const region = extractFirstJsonRegion(candidate.blob) ?? candidate.blob;
      let parsed: unknown;
      try {
        parsed = JSON.parse(region);
      } catch {
        parsed = undefined;
      }
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry === null || typeof entry !== "object") continue;
          const asRecord = entry as Record<string, unknown>;
          const name = asRecord["name"];
          if (typeof name !== "string") continue;
          const rawArgs =
            asRecord["arguments"] ?? asRecord["parameters"] ?? asRecord["input"] ?? {};
          results.push({
            name,
            rawArguments:
              typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs),
            format: "mistral",
            span: candidate.span,
          });
        }
        continue;
      }
    }

    const read = readNameAndArguments(candidate.blob);
    if (read === undefined) continue;
    results.push({
      name: read.name,
      rawArguments: read.rawArguments,
      format: candidate.format,
      span: candidate.span,
    });
  }

  return results;
}

/**
 * Remove the extracted spans from `text` so the assistant message replayed to
 * the provider carries the model's prose but not the malformed call it is
 * about to see answered by a real `tool_result`. Leaving both in place teaches
 * the model that its broken syntax worked.
 */
export function exciseSpans(
  text: string,
  calls: readonly ExtractedToolCall[],
): string {
  if (calls.length === 0) return text;
  const spans = [...calls.map((c) => c.span)].sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [start, end] of spans) {
    out = out.slice(0, start) + out.slice(end);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
