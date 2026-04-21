/**
 * spinner.tsx — small rotating braille spinner.
 *
 * Renders only while the REPL is in `streaming` or `compact`. Uses a local
 * setInterval with unref() so the timer can't keep the Node process alive
 * after the app exits.
 */

import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"] as const;
const FRAME_MS = 80;

export interface SpinnerProps {
  readonly active: boolean;
  readonly label?: string;
  readonly color?: string;
}

export function Spinner(props: SpinnerProps): React.ReactElement | null {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!props.active) return;
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, FRAME_MS);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, [props.active]);

  if (!props.active) return null;
  const ch = FRAMES[frame] ?? FRAMES[0];
  return (
    <Text color={props.color ?? "cyan"}>
      {ch}
      {props.label !== undefined ? ` ${props.label}` : ""}
    </Text>
  );
}
