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
