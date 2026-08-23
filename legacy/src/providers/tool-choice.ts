/**
 * tool-choice — map `ProviderRequest.toolChoice` to the Vercel AI SDK shape.
 *
 * `ProviderRequest` has carried a `toolChoice` field since M4a, but until
 * docs/63 F2 nothing ever wrote it and only the Codex Responses builder read
 * it — so every AI-SDK-backed transport silently ran on the SDK default
 * (`auto`). That left no lever for the one case where it matters: an
 * open-weight model that keeps answering in prose instead of emitting a tool
 * call. Forcing `required` for a turn is the standard fix, and it was
 * unreachable.
 *
 * Kept in its own module because all seven AI-SDK transports need the identical
 * mapping and the union shapes differ (`{name}` here, `{type:"tool",toolName}`
 * there).
 */

import type { ProviderRequest } from "./index.js";

/** The Vercel AI SDK v6 `toolChoice` union, structurally. */
export type VercelToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "tool"; readonly toolName: string };

/**
 * Convert our `toolChoice` to the SDK's. Returns `undefined` when unset (the
 * SDK then applies its own default) or when the request advertises no tools —
 * `required` against an empty tool set is a provider-side error, and silently
 * dropping it is friendlier than failing a turn over a config that cannot be
 * satisfied.
 */
export function toVercelToolChoice(
  req: Pick<ProviderRequest, "toolChoice" | "tools">,
): VercelToolChoice | undefined {
  const choice = req.toolChoice;
  if (choice === undefined) return undefined;

  const hasTools = (req.tools?.length ?? 0) > 0;
  if (!hasTools) return undefined;

  if (choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  // Named tool — only honoured when that tool is actually advertised.
  const named = req.tools?.some((t) => t.name === choice.name) ?? false;
  return named ? { type: "tool", toolName: choice.name } : undefined;
}

/**
 * Spreadable form for the `streamText({ ... })` call sites, so a transport can
 * write `...toolChoiceOption(req)` without an intermediate binding.
 */
export function toolChoiceOption(
  req: Pick<ProviderRequest, "toolChoice" | "tools">,
): { toolChoice?: VercelToolChoice } {
  const choice = toVercelToolChoice(req);
  return choice === undefined ? {} : { toolChoice: choice };
}
