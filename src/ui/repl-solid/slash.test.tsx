/**
 * slash.test.tsx — tests for Phase 0c.5 slash-command dispatch + dropdown.
 *
 * Exercises the full slash pipeline: user types "/cmd" → App detects the
 * prefix → dispatchSlashLine runs → result applied to store via dispatch.
 * Also verifies the Dropdown component appears when input starts with "/".
 */

import { describe, it, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { App } from "./app.js";
import { buildDefaultRegistry } from "../../cli/slash/index.js";
import type { NormalizedEvent } from "../../core/types.js";

function emptyEvents(): AsyncIterable<NormalizedEvent> {
  return (async function* (): AsyncGenerator<NormalizedEvent> {})();
}

async function flush(ms = 50): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

describe("App — slash command dispatch", () => {
  it("/help prints a message with registered command names", async () => {
    const registry = buildDefaultRegistry({});

    const { captureCharFrame, mockInput, renderOnce } = await testRender(
      () => (
        <App
          events={emptyEvents()}
          model="test-model"
          permissionMode="workspace-write"
          registry={registry}
        />
      ),
      { width: 80, height: 30 },
    );
    await renderOnce();

    await mockInput.typeText("/help");
    mockInput.pressEnter();
    await renderOnce();
    await flush(60);
    await renderOnce();

    const frame = captureCharFrame();
    // /help's message should mention at least one built-in command name.
    expect(frame).toMatch(/help|exit|clear|status/);
  });

  it("/exit transitions to shutdown and fires onExit", async () => {
    const registry = buildDefaultRegistry({});
    let exited = false;

    const { mockInput, renderOnce } = await testRender(
      () => (
        <App
          events={emptyEvents()}
          model="test-model"
          permissionMode="workspace-write"
          registry={registry}
          onExit={() => {
            exited = true;
          }}
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();

    await mockInput.typeText("/exit");
    mockInput.pressEnter();
    await renderOnce();
    await flush(60);

    expect(exited).toBe(true);
  });

  it("dropdown appears when input starts with /", async () => {
    const registry = buildDefaultRegistry({});

    const { captureCharFrame, mockInput, renderOnce } = await testRender(
      () => (
        <App
          events={emptyEvents()}
          model="test-model"
          permissionMode="workspace-write"
          registry={registry}
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();

    // Type "/" — dropdown should show multiple candidate commands.
    await mockInput.typeText("/");
    await renderOnce();
    await flush(30);
    await renderOnce();

    const frame = captureCharFrame();
    // Multiple built-in commands should be visible in the dropdown region.
    // We spot-check a couple that the registry is known to include.
    const visibleCmds = ["help", "exit", "clear", "status"].filter((c) =>
      frame.includes(c),
    );
    expect(visibleCmds.length).toBeGreaterThanOrEqual(2);
  });

  it("unknown slash command produces an error system-entry", async () => {
    const registry = buildDefaultRegistry({});

    const { captureCharFrame, mockInput, renderOnce } = await testRender(
      () => (
        <App
          events={emptyEvents()}
          model="test-model"
          permissionMode="workspace-write"
          registry={registry}
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();

    await mockInput.typeText("/nonsense");
    mockInput.pressEnter();
    await renderOnce();
    await flush(60);
    await renderOnce();

    const frame = captureCharFrame();
    // Expect something like "error:" or "unknown" in the transcript.
    expect(frame.toLowerCase()).toMatch(/error|unknown/);
  });

  it("non-slash submit still goes through onSubmit (not through registry)", async () => {
    const registry = buildDefaultRegistry({});
    const submitted: string[] = [];

    const { mockInput, renderOnce } = await testRender(
      () => (
        <App
          events={emptyEvents()}
          model="test-model"
          permissionMode="workspace-write"
          registry={registry}
          onSubmit={(line) => submitted.push(line)}
        />
      ),
      { width: 80, height: 20 },
    );
    await renderOnce();

    await mockInput.typeText("normal prompt");
    mockInput.pressEnter();
    await renderOnce();
    await flush(30);

    expect(submitted).toEqual(["normal prompt"]);
  });
});
