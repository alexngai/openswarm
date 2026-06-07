/**
 * compute.ts — LCS-based line diff algorithm.
 *
 * Inspired by Kimi Code's diff-preview.ts. Pure function: takes old/new text,
 * returns an array of DiffLine entries for rendering.
 *
 * Streaming-aware: when isIncomplete is true, trailing delete lines are
 * suppressed (the new text is still arriving, so trailing deletes are
 * artifacts of partial content).
 */

export type DiffLineKind = "add" | "delete" | "context";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Line number in the original file (for delete/context), or new file (for add). */
  readonly lineNo: number;
  readonly text: string;
}

export interface DiffResult {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
}

export function computeDiff(
  oldText: string,
  newText: string,
  options?: { isIncomplete?: boolean },
): DiffResult {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  const isIncomplete = options?.isIncomplete ?? false;

  const m = oldLines.length;
  const n = newLines.length;

  // LCS via dynamic programming.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diff lines.
  const result: DiffLine[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ kind: "context", lineNo: i, text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ kind: "add", lineNo: j, text: newLines[j - 1]! });
      j--;
    } else {
      result.push({ kind: "delete", lineNo: i, text: oldLines[i - 1]! });
      i--;
    }
  }

  result.reverse();

  let added = 0;
  let removed = 0;
  for (const line of result) {
    if (line.kind === "add") added++;
    if (line.kind === "delete") removed++;
  }

  if (isIncomplete) {
    // Suppress trailing deletes — they're artifacts of partial new content.
    let lastNonDelete = result.length - 1;
    while (lastNonDelete >= 0 && result[lastNonDelete]!.kind === "delete") {
      lastNonDelete--;
    }
    const trimmed = result.slice(0, lastNonDelete + 1);
    let trimmedRemoved = 0;
    for (const line of trimmed) {
      if (line.kind === "delete") trimmedRemoved++;
    }
    return { lines: trimmed, added, removed: trimmedRemoved };
  }

  return { lines: result, added, removed };
}

/**
 * Compact a diff for display: show only changed lines plus context around them.
 * Returns a subset of the full diff lines suitable for collapsed view.
 */
export function compactDiff(
  diff: DiffResult,
  options?: { contextLines?: number; maxChanges?: number },
): { lines: readonly DiffLine[]; hiddenChanges: number } {
  const contextLines = options?.contextLines ?? 3;
  const maxChanges = options?.maxChanges ?? 10;

  const changeIndices: number[] = [];
  for (let i = 0; i < diff.lines.length; i++) {
    if (diff.lines[i]!.kind !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return { lines: [], hiddenChanges: 0 };
  }

  // If total changes fit within max, show all with context.
  const truncateAt = changeIndices.length <= maxChanges
    ? changeIndices.length
    : maxChanges;

  const visibleIndices = new Set<number>();
  for (let ci = 0; ci < truncateAt; ci++) {
    const idx = changeIndices[ci]!;
    for (let offset = -contextLines; offset <= contextLines; offset++) {
      const target = idx + offset;
      if (target >= 0 && target < diff.lines.length) {
        visibleIndices.add(target);
      }
    }
  }

  const compacted: DiffLine[] = [];
  for (let i = 0; i < diff.lines.length; i++) {
    if (visibleIndices.has(i)) {
      compacted.push(diff.lines[i]!);
    }
  }

  const hiddenChanges = changeIndices.length - truncateAt;
  return { lines: compacted, hiddenChanges };
}
