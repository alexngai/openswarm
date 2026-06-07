/**
 * group.ts — Pure function that groups consecutive same-name tool entries
 * into ToolGroups for collapsed rendering. Phase 3.
 *
 * Non-tool entries and single tool entries pass through ungrouped.
 */

import type { TranscriptEntry, ToolCallState } from "../../repl/state.js";

export interface SingleItem {
  readonly type: "single";
  readonly entry: TranscriptEntry;
}

export interface GroupItem {
  readonly type: "group";
  readonly toolName: string;
  readonly entryIds: readonly string[];
}

export type TranscriptItem = SingleItem | GroupItem;

export function groupTranscriptEntries(
  entries: readonly TranscriptEntry[],
  toolCalls: Readonly<Record<string, ToolCallState>>,
): TranscriptItem[] {
  const result: TranscriptItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];
    if (entry.kind !== "tool" || entry.toolCallId === undefined) {
      result.push({ type: "single", entry });
      i++;
      continue;
    }

    const tc = toolCalls[entry.toolCallId];
    if (tc === undefined) {
      result.push({ type: "single", entry });
      i++;
      continue;
    }

    const toolName = tc.name;
    const groupEntryIds: string[] = [entry.id];
    let j = i + 1;

    while (j < entries.length) {
      const next = entries[j];
      if (next.kind !== "tool" || next.toolCallId === undefined) break;
      const nextTc = toolCalls[next.toolCallId];
      if (nextTc === undefined || nextTc.name !== toolName) break;
      groupEntryIds.push(next.id);
      j++;
    }

    if (groupEntryIds.length >= 2) {
      result.push({ type: "group", toolName, entryIds: groupEntryIds });
    } else {
      result.push({ type: "single", entry });
    }

    i = j;
  }

  return result;
}
