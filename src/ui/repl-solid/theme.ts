/**
 * theme.ts — shared color and style constants for the OpenTUI/Solid REPL.
 *
 * Phase 0b components (transcript, input, status, dropdown, spinner) should
 * import colors and semantic tokens from this file so the TUI stays coherent
 * across independent ports. Keep this file small — opaque strings, no logic.
 */

/**
 * Semantic color tokens. Values are crossterm-compatible color names or hex.
 * Adjust in one place; all components update.
 */
export const theme = {
  text: "#e5e7eb",
  muted: "#9ca3af",
  subtle: "#6b7280",
  border: "#4b5563",
  accent: "#60a5fa",
  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",
  streamingIndicator: "#a78bfa",

  // Tool chip bullets (Phase 1a)
  bulletPending: "#a78bfa",
  bulletSuccess: "#4ade80",
  bulletError: "#f87171",

  // Diff colors (Phase 1b)
  diffAdd: "#4ade80",
  diffRemove: "#f87171",
  diffGutter: "#6b7280",

  // Code syntax tokens (doc 49 Phase A4) — used by codeSyntaxStyle() for
  // highlighting tool output bodies (<code>) and diff hunks (<diff>). Kept
  // coherent with the markdown palette in syntax.ts.
  codeKeyword: "#c084fc",
  codeString: "#4ade80",
  codeComment: "#6b7280",
  codeNumber: "#fbbf24",
  codeFunction: "#60a5fa",
  codeType: "#5eead4",
  codeConstant: "#fbbf24",
  codePunctuation: "#9ca3af",
  codeVariable: "#e5e7eb",
  // Background is terminal default; components should generally not set bg.
} as const;

export type ThemeColor = keyof typeof theme;

/**
 * Transcript entry-kind → color mapping. Components rendering transcript
 * entries should look up `entryColor(kind)` rather than hardcoding.
 */
export const entryColor: Record<
  "user" | "assistant" | "tool" | "system",
  string
> = {
  user: theme.text,
  assistant: theme.text,
  tool: theme.muted,
  system: theme.subtle,
};

/**
 * State-name → status-bar color mapping. `awaiting-permission` gets warning;
 * `compact` gets accent; others fall back to muted.
 */
export const stateColor: Record<
  "idle" | "streaming" | "awaiting-permission" | "compact" | "shutdown",
  string
> = {
  idle: theme.muted,
  streaming: theme.streamingIndicator,
  "awaiting-permission": theme.warning,
  compact: theme.accent,
  shutdown: theme.subtle,
};
