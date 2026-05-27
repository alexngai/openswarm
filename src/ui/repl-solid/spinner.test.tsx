/**
 * spinner.test.tsx — Bun-native smoke test for the Solid Spinner component.
 *
 * The Solid JSX transform plugin is registered via bunfig.toml's [test]
 * preload entry — not via an import here.
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { Spinner } from "./spinner.js";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

describe("Spinner", () => {
  it("renders a braille character when active=true", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={true} intervalMs={10} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const hasFrame = BRAILLE_FRAMES.some((ch) => frame.includes(ch));
    expect(hasFrame).toBe(true);
  });

  it("renders nothing when active=false (cold start, no transition)", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={false} intervalMs={10} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const hasFrame = BRAILLE_FRAMES.some((ch) => frame.includes(ch));
    expect(hasFrame).toBe(false);
  });

  it("shows ✔ immediately after active transitions false with outcome=success", async () => {
    const [active, setActive] = createSignal(true);
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={active()} intervalMs={10} outcome="success" transitionMs={500} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    // Transition active → false
    setActive(false);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame.includes("✔")).toBe(true);
  });

  it("shows ✘ immediately after active transitions false with outcome=failure", async () => {
    const [active, setActive] = createSignal(true);
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={active()} intervalMs={10} outcome="failure" transitionMs={500} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    setActive(false);
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame.includes("✘")).toBe(true);
  });

  it("hides after the transition timer expires", async () => {
    const [active, setActive] = createSignal(true);
    // Use a very short transitionMs so the test doesn't need real timers.
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={active()} intervalMs={10} outcome="success" transitionMs={1} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    setActive(false);
    // Wait longer than transitionMs to let the timer fire.
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();
    const frame = captureCharFrame();
    // After transition, should show neither braille nor ✔.
    const hasSpinner = BRAILLE_FRAMES.some((ch) => frame.includes(ch));
    expect(hasSpinner).toBe(false);
    expect(frame.includes("✔")).toBe(false);
  });
});
