/**
 * spinner.tsx — animated braille spinner (OpenTUI/Solid port).
 *
 * Renders a single rotating braille character that cycles through 10 frames
 * while `active` is true. Uses Solid's createSignal + setInterval; the
 * interval is cleared via onCleanup so it never outlives the component.
 */

import { createSignal, onCleanup, Show, createEffect } from "solid-js";
import { theme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface SpinnerProps {
  readonly active?: boolean;
  readonly intervalMs?: number;
}

export function Spinner(props: SpinnerProps) {
  const active = () => props.active ?? true;
  const intervalMs = () => props.intervalMs ?? 80;

  const [frame, setFrame] = createSignal(0);

  createEffect(() => {
    if (!active()) return;
    const id = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, intervalMs());
    onCleanup(() => clearInterval(id));
  });

  return (
    <Show when={active()}>
      <text fg={theme.streamingIndicator}>{FRAMES[frame()]}</text>
    </Show>
  );
}
