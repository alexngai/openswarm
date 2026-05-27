/**
 * spinner.tsx — animated braille spinner (OpenTUI/Solid port).
 *
 * Renders a single rotating braille character that cycles through 10 frames
 * while `active` is true. Uses Solid's createSignal + setInterval; the
 * interval is cleared via onCleanup so it never outlives the component.
 *
 * v0.2 Stage 2F (T8): success/failure transition — when `active` transitions
 * to false, the spinner briefly shows ✔ (success) or ✘ (failure) for
 * `transitionMs` milliseconds before disappearing. Matches claw-code's
 * terminal spinner polish.
 */

import { createSignal, onCleanup, Show, createEffect } from "solid-js";
import { theme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Which outcome glyph to show on stop. */
export type SpinnerOutcome = "success" | "failure";

export interface SpinnerProps {
  readonly active?: boolean;
  readonly intervalMs?: number;
  /** Outcome shown when `active` transitions false → ✔ or ✘. Default: "success". */
  readonly outcome?: SpinnerOutcome;
  /** How long (ms) to show the outcome glyph before hiding. Default: 500. */
  readonly transitionMs?: number;
}

type SpinnerPhase = "spinning" | "success" | "failure" | "done";

export function Spinner(props: SpinnerProps) {
  const active = () => props.active ?? true;
  const intervalMs = () => props.intervalMs ?? 80;
  const outcome = () => props.outcome ?? "success";
  const transitionMs = () => props.transitionMs ?? 500;

  const [frame, setFrame] = createSignal(0);
  const [phase, setPhase] = createSignal<SpinnerPhase>("done");

  // Track the previous active value so we can detect the falling edge.
  let prevActive = active();

  createEffect(() => {
    const isActive = active();

    if (isActive) {
      // Start spinning.
      setPhase("spinning");
      const id = setInterval(() => {
        setFrame((f) => (f + 1) % FRAMES.length);
      }, intervalMs());
      onCleanup(() => clearInterval(id));
    } else if (prevActive && !isActive) {
      // Falling edge: show outcome glyph briefly.
      const outcomePhase: SpinnerPhase = outcome() === "failure" ? "failure" : "success";
      setPhase(outcomePhase);
      const tid = setTimeout(() => setPhase("done"), transitionMs());
      onCleanup(() => clearTimeout(tid));
    }

    prevActive = isActive;
  });

  return (
    <Show when={phase() !== "done"}>
      {phase() === "spinning" ? (
        <text fg={theme.streamingIndicator}>{FRAMES[frame()]}</text>
      ) : phase() === "success" ? (
        <text fg={theme.success}>{"✔"}</text>
      ) : (
        <text fg={theme.error}>{"✘"}</text>
      )}
    </Show>
  );
}
