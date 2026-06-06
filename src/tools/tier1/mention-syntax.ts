/**
 * Mention syntax parser (F8): extract @-references from text.
 *
 * Parses text for @tool and @plugin mentions, returning structured
 * references that can be resolved against the tool registry.
 *
 * Syntax:
 *   @tool_name           — reference a tool by name
 *   @plugin:tool_name    — reference a namespaced tool
 *   @agent_name          — reference an agent
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MentionType = "tool" | "plugin" | "agent";

export interface Mention {
  readonly type: MentionType;
  readonly name: string;
  readonly namespace?: string;
  readonly raw: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const MENTION_RE = /(?:^|(?<=\s))@([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)(?=\s|$|[.,;!?)])/g;

export function parseMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  let match: RegExpExecArray | null;

  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const raw = match[0]!;
    const body = match[1]!;
    const startIndex = match.index;
    const endIndex = startIndex + raw.length;

    if (body.includes(":")) {
      const [namespace, name] = body.split(":", 2);
      mentions.push({
        type: "plugin",
        name: name!,
        namespace: namespace!,
        raw,
        startIndex,
        endIndex,
      });
    } else {
      mentions.push({
        type: "tool",
        name: body,
        raw,
        startIndex,
        endIndex,
      });
    }
  }

  return mentions;
}

export function resolveMentions(
  text: string,
  availableTools: readonly string[],
  availableAgents?: readonly string[],
): Mention[] {
  const mentions = parseMentions(text);
  const toolSet = new Set(availableTools);
  const agentSet = new Set(availableAgents ?? []);

  return mentions.map((m) => {
    if (m.type === "plugin") return m;
    if (agentSet.has(m.name)) return { ...m, type: "agent" as const };
    if (toolSet.has(m.name)) return m;
    return m;
  });
}

export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, "").replace(/\s{2,}/g, " ").trim();
}
