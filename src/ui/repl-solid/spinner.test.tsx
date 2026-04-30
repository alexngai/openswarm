/**
 * spinner.test.tsx — Bun-native smoke test for the Solid Spinner component.
 *
 * The Solid JSX transform plugin is registered via bunfig.toml's [test]
 * preload entry — not via an import here.
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
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

  it("renders nothing when active=false", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Spinner active={false} intervalMs={10} />,
      { width: 10, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    const hasFrame = BRAILLE_FRAMES.some((ch) => frame.includes(ch));
    expect(hasFrame).toBe(false);
  });
});
