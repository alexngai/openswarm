/**
 * opentui.test.tsx — Bun-native smoke test for the OpenTUI + Solid render chain.
 *
 * Uses `bun:test` (not vitest) because vitest's workers use Node, which can't
 * resolve @opentui/core's `bun:ffi` imports. Run via `bun test src/ui/repl-solid/`.
 */

// The Solid JSX transform plugin is registered via bunfig.toml's `[test]
// preload` entry — not via an import here, because imports resolve after this
// file's own JSX has already been transformed.
import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";

describe("@opentui/solid render smoke", () => {
  it("renders <box><text> and captures 'hello opentui' in the frame", async () => {
    const { captureCharFrame, renderOnce } = await testRender(
      () => (
        <box>
          <text>hello opentui</text>
        </box>
      ),
      { width: 40, height: 3 },
    );
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("hello opentui");
  });
});
