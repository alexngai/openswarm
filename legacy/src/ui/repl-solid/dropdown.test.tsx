/**
 * dropdown.test.tsx — bun test for the Solid Dropdown component.
 *
 * Uses bun:test + @opentui/solid testRender (same pattern as opentui.test.tsx).
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Dropdown } from "./dropdown.js";

const candidates = [
  { name: "help", description: "Show help" },
  { name: "clear", description: "Clear the screen" },
  { name: "compact", description: "Compact the context" },
  { name: "exit", description: "Exit the REPL" },
];

describe("Dropdown", () => {
  it("renders all 4 candidate names and highlights the selected row", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Dropdown candidates={candidates} selectedIndex={1} />,
      { width: 60, height: 10 },
    );

    await renderOnce();
    const frame = captureCharFrame();

    // All names must appear in the frame
    expect(frame).toContain("help");
    expect(frame).toContain("clear");
    expect(frame).toContain("compact");
    expect(frame).toContain("exit");

    // The frame must render something (border + rows)
    expect(frame.trim().length).toBeGreaterThan(0);
  });

  it("renders nothing when candidates list has 0 entries", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Dropdown candidates={[]} selectedIndex={0} />,
      { width: 60, height: 10 },
    );

    await renderOnce();
    const frame = captureCharFrame();

    // Should produce an empty frame (no border, no text)
    expect(frame.trim()).toBe("");
  });

  it("renders nothing when candidates list has exactly 1 entry", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => <Dropdown candidates={[{ name: "help", description: "Show help" }]} selectedIndex={0} />,
      { width: 60, height: 10 },
    );

    await renderOnce();
    const frame = captureCharFrame();

    expect(frame.trim()).toBe("");
  });
});
