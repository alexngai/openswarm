/**
 * input.test.tsx — Bun-native tests for the Solid/OpenTUI Input component.
 *
 * Uses `bun:test` because vitest's workers use Node which cannot resolve
 * @opentui/core's `bun:ffi` imports. Run via:
 *   bun test src/ui/repl-solid/input.test.tsx
 *
 * The Solid JSX transform is registered via bunfig.toml [test] preload.
 */
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { Input } from "./input.js";

describe("Input component", () => {
  it("renders without crashing", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <Input
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          onKey={() => {}}
          disabled={false}
        />
      ),
      { width: 60, height: 5 },
    );
    await renderOnce();
    // Just verify it renders a frame (no crash).
    const frame = captureCharFrame();
    expect(typeof frame).toBe("string");
  });

  it("calls onChange when the user types a character", async () => {
    const changes: { value: string; cursor: number }[] = [];

    const { mockInput, renderOnce } = await testRender(
      () => (
        <Input
          value=""
          onChange={(value, cursor) => changes.push({ value, cursor })}
          onSubmit={() => {}}
          onKey={() => {}}
          disabled={false}
        />
      ),
      { width: 60, height: 5 },
    );
    await renderOnce();

    // Type 'a' — should trigger onContentChange → onChange.
    await mockInput.typeText("a");
    await renderOnce();

    expect(changes.length).toBeGreaterThan(0);
    const last = changes[changes.length - 1];
    expect(last!.value).toBe("a");
    expect(last!.cursor).toBe(1);
  });

  it("calls onSubmit when Enter is pressed", async () => {
    const submitted: string[] = [];

    const { mockInput, renderOnce } = await testRender(
      () => (
        <Input
          value=""
          onChange={() => {}}
          onSubmit={(v) => submitted.push(v)}
          onKey={() => {}}
          disabled={false}
        />
      ),
      { width: 60, height: 5 },
    );
    await renderOnce();

    await mockInput.typeText("hello");
    await renderOnce();
    mockInput.pressEnter();
    await renderOnce();

    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted[0]).toBe("hello");
  });

  it("suppresses input when disabled=true", async () => {
    const changes: string[] = [];

    const { mockInput, renderOnce } = await testRender(
      () => (
        <Input
          value=""
          onChange={(v) => changes.push(v)}
          onSubmit={() => {}}
          onKey={() => {}}
          disabled={true}
        />
      ),
      { width: 60, height: 5 },
    );
    await renderOnce();

    await mockInput.typeText("x");
    await renderOnce();

    // No onChange should have fired because disabled=true blocks input.
    expect(changes.length).toBe(0);
  });

  it("forwards arrow key events to onKey", async () => {
    const keys: string[] = [];

    const { mockInput, renderOnce } = await testRender(
      () => (
        <Input
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          onKey={(k) => {
            if (k.upArrow) keys.push("up");
            if (k.downArrow) keys.push("down");
          }}
          disabled={false}
        />
      ),
      { width: 60, height: 5 },
    );
    await renderOnce();

    mockInput.pressArrow("up");
    await renderOnce();
    mockInput.pressArrow("down");
    await renderOnce();

    expect(keys).toContain("up");
    expect(keys).toContain("down");
  });
});
