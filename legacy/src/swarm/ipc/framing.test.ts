import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrame,
  LineSplitter,
  MAX_FRAME_SIZE_BYTES,
} from "./framing.js";
import type { IpcFrame } from "./protocol.js";
import {
  isRequest,
  isResponse,
  isNotification,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// encodeFrame
// ---------------------------------------------------------------------------

describe("encodeFrame", () => {
  it("produces JSON.stringify(frame) + newline", () => {
    const frame: IpcFrame = {
      kind: "request",
      id: "abc-123",
      method: "run",
      params: { foo: 1 },
    };
    expect(encodeFrame(frame)).toBe(JSON.stringify(frame) + "\n");
  });

  it("encodes a notification frame correctly", () => {
    const frame: IpcFrame = {
      kind: "notification",
      method: "heartbeat",
      params: { agentId: "a1", ts: 1000 },
    };
    expect(encodeFrame(frame)).toBe(JSON.stringify(frame) + "\n");
  });

  it("encodes an ok response frame correctly", () => {
    const frame: IpcFrame = {
      kind: "response",
      id: "r1",
      ok: true,
      result: { accepted: true },
    };
    expect(encodeFrame(frame)).toBe(JSON.stringify(frame) + "\n");
  });
});

// ---------------------------------------------------------------------------
// decodeFrame — happy paths
// ---------------------------------------------------------------------------

describe("decodeFrame — happy paths", () => {
  it("decodes a request frame", () => {
    const frame: IpcFrame = {
      kind: "request",
      id: "req-1",
      method: "shutdown",
      params: {},
    };
    const result = decodeFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.kind).toBe("request");
    }
  });

  it("decodes an ok response frame", () => {
    const frame: IpcFrame = {
      kind: "response",
      id: "res-1",
      ok: true,
      result: null,
    };
    const result = decodeFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.kind).toBe("response");
    }
  });

  it("decodes an err response frame", () => {
    const frame: IpcFrame = {
      kind: "response",
      id: "res-2",
      ok: false,
      error: { code: "internal_error", message: "oops" },
    };
    const result = decodeFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.kind).toBe("response");
    }
  });

  it("decodes a notification frame", () => {
    const frame: IpcFrame = {
      kind: "notification",
      method: "worker_ready",
      params: { agentId: "w1", depth: 0, pid: 1234 },
    };
    const result = decodeFrame(JSON.stringify(frame));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.kind).toBe("notification");
    }
  });
});

// ---------------------------------------------------------------------------
// decodeFrame — error paths
// ---------------------------------------------------------------------------

describe("decodeFrame — error paths", () => {
  it("rejects malformed JSON", () => {
    const result = decodeFrame("{not valid json}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON parse error/);
    }
  });

  it("rejects non-object input (null JSON)", () => {
    const result = decodeFrame("null");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/frame missing required fields/);
    }
  });

  it("rejects array input", () => {
    const result = decodeFrame("[1,2,3]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/frame missing required fields/);
    }
  });

  it("rejects object missing kind field", () => {
    const result = decodeFrame(JSON.stringify({ id: "x", method: "run" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/frame missing required fields/);
    }
  });

  it("rejects object with unrecognized kind value", () => {
    const result = decodeFrame(JSON.stringify({ kind: "unknown", id: "x" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/frame missing required fields/);
    }
  });

  it("rejects a line exceeding the 10 MiB cap", () => {
    // Build a line just over MAX_FRAME_SIZE_BYTES characters.
    const oversized = "x".repeat(MAX_FRAME_SIZE_BYTES + 1);
    const result = decodeFrame(oversized);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/frame exceeds/);
    }
  });
});

// ---------------------------------------------------------------------------
// LineSplitter
// ---------------------------------------------------------------------------

describe("LineSplitter", () => {
  it("splits multiple complete lines in one push", () => {
    const splitter = new LineSplitter();
    const lines = splitter.push('{"kind":"request"}\n{"kind":"notification"}\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{"kind":"request"}');
    expect(lines[1]).toBe('{"kind":"notification"}');
  });

  it("holds a partial trailing line across pushes", () => {
    const splitter = new LineSplitter();
    const first = splitter.push('{"kind":"re');
    expect(first).toHaveLength(0);
    const second = splitter.push('quest","id":"1"}\n');
    expect(second).toHaveLength(1);
    expect(second[0]).toBe('{"kind":"request","id":"1"}');
  });

  it("correctly tracks bufferedBytes between pushes", () => {
    const splitter = new LineSplitter();
    splitter.push("partial");
    expect(splitter.bufferedBytes).toBe(7);
    splitter.push("\n");
    expect(splitter.bufferedBytes).toBe(0);
  });

  it("flush returns buffered content and clears the buffer", () => {
    const splitter = new LineSplitter();
    splitter.push("incomplete line without newline");
    const trailing = splitter.flush();
    expect(trailing).toBe("incomplete line without newline");
    expect(splitter.bufferedBytes).toBe(0);
    // Second flush should be empty.
    expect(splitter.flush()).toBe("");
  });

  it("throws when a single chunk without newline exceeds the cap", () => {
    const splitter = new LineSplitter();
    const oversized = "x".repeat(MAX_FRAME_SIZE_BYTES + 1);
    expect(() => splitter.push(oversized)).toThrow(/buffered bytes exceeded/);
    // Buffer is cleared after the throw.
    expect(splitter.bufferedBytes).toBe(0);
  });

  it("filters out empty strings from split results", () => {
    const splitter = new LineSplitter();
    // Two consecutive newlines should not produce empty-string entries.
    const lines = splitter.push("line1\n\nline2\n");
    expect(lines).toEqual(["line1", "line2"]);
  });
});

// ---------------------------------------------------------------------------
// Protocol type guards
// ---------------------------------------------------------------------------

describe("isRequest / isResponse / isNotification type guards", () => {
  const req: IpcFrame = { kind: "request", id: "1", method: "run", params: {} };
  const okRes: IpcFrame = { kind: "response", id: "1", ok: true, result: null };
  const errRes: IpcFrame = {
    kind: "response",
    id: "1",
    ok: false,
    error: { code: "internal_error", message: "x" },
  };
  const notif: IpcFrame = { kind: "notification", method: "heartbeat", params: {} };

  it("isRequest narrows request frames", () => {
    expect(isRequest(req)).toBe(true);
    expect(isRequest(okRes)).toBe(false);
    expect(isRequest(notif)).toBe(false);
  });

  it("isResponse narrows both ok and err response frames", () => {
    expect(isResponse(okRes)).toBe(true);
    expect(isResponse(errRes)).toBe(true);
    expect(isResponse(req)).toBe(false);
    expect(isResponse(notif)).toBe(false);
  });

  it("isNotification narrows notification frames", () => {
    expect(isNotification(notif)).toBe(true);
    expect(isNotification(req)).toBe(false);
    expect(isNotification(okRes)).toBe(false);
  });
});
