/**
 * The property under test is a high-water mark, not a return value: what
 * matters is that a process writing without end cannot make us hold it all.
 * Asserting on the retained bytes is how that is observed, since the array
 * that used to grow is now the thing being bounded.
 */

import { describe, it, expect } from "vitest";
import { BoundedOutput, DEFAULT_RETAIN_BYTES } from "./bounded-output.js";

function chunk(byte: string, length: number): Buffer {
  return Buffer.alloc(length, byte);
}

describe("output that fits is untouched", () => {
  it("returns the exact stream when nothing overflows", () => {
    const out = new BoundedOutput({ headBytes: 100, tailBytes: 100 });
    out.push(Buffer.from("hello "));
    out.push(Buffer.from("world"));

    expect(out.text()).toBe("hello world");
    expect(out.truncated).toBe(false);
    expect(out.droppedBytes).toBe(0);
    expect(out.totalBytes).toBe(11);
  });

  it("keeps a stream that exactly fills the head", () => {
    const out = new BoundedOutput({ headBytes: 10, tailBytes: 10 });
    out.push(chunk("a", 10));

    expect(out.text()).toBe("a".repeat(10));
    expect(out.truncated).toBe(false);
  });

  it("keeps a stream filling head and tail with nothing between", () => {
    const out = new BoundedOutput({ headBytes: 4, tailBytes: 4 });
    out.push(Buffer.from("abcdefgh"));

    expect(out.text()).toBe("abcdefgh");
    expect(out.truncated).toBe(false);
    expect(out.droppedBytes).toBe(0);
  });
});

describe("output that overflows keeps both ends", () => {
  it("drops the middle and keeps head and tail", () => {
    const out = new BoundedOutput({ headBytes: 3, tailBytes: 3 });
    out.push(Buffer.from("HHHmmmmmmmmTTT"));

    expect(out.text()).toBe("HHHTTT");
    expect(out.droppedBytes).toBe(8);
    expect(out.totalBytes).toBe(14);
    expect(out.truncated).toBe(true);
  });

  it("keeps the earliest bytes as the head, not the latest", () => {
    const out = new BoundedOutput({ headBytes: 5, tailBytes: 5 });
    for (let i = 0; i < 10; i += 1) out.push(Buffer.from(`${i}`.repeat(5)));

    const { head, tail } = out.parts();
    expect(head.toString()).toBe("00000");
    expect(tail.toString()).toBe("99999");
  });

  it("splits a chunk that straddles the head boundary", () => {
    // A chunk arriving across the boundary must not push the head past its
    // limit, or the bound depends on how the OS happened to frame the pipe.
    const out = new BoundedOutput({ headBytes: 4, tailBytes: 2 });
    out.push(Buffer.from("aaaaaaaaaa"));

    const { head } = out.parts();
    expect(head.length).toBe(4);
    expect(out.text()).toBe("aaaaaa");
  });
});

describe("memory stays bounded under a stream that does not stop", () => {
  it("holds no more than head + tail across many megabytes", () => {
    const out = new BoundedOutput({ headBytes: 1024, tailBytes: 1024 });

    // 8 MiB in 8 KiB writes. The old array would retain all of it.
    for (let i = 0; i < 1024; i += 1) out.push(chunk("x", 8 * 1024));

    expect(out.totalBytes).toBe(8 * 1024 * 1024);
    expect(out.bytes().length).toBe(2048);
    expect(out.droppedBytes).toBe(8 * 1024 * 1024 - 2048);
  });

  it("bounds retention at the default window too", () => {
    const out = new BoundedOutput();
    for (let i = 0; i < 200; i += 1) out.push(chunk("y", 64 * 1024));

    expect(out.bytes().length).toBe(2 * DEFAULT_RETAIN_BYTES);
    expect(out.totalBytes).toBe(200 * 64 * 1024);
  });

  it("does not accumulate chunk objects while trimming", () => {
    // Trimming must discard whole chunks rather than only counting bytes;
    // retaining 1-byte chunks forever is its own leak.
    const out = new BoundedOutput({ headBytes: 0, tailBytes: 8 });
    for (let i = 0; i < 100_000; i += 1) out.push(Buffer.from("z"));

    expect(out.bytes().length).toBe(8);
    expect(out.totalBytes).toBe(100_000);
  });
});

describe("reset", () => {
  it("clears counters and retained bytes", () => {
    const out = new BoundedOutput({ headBytes: 2, tailBytes: 2 });
    out.push(Buffer.from("abcdef"));
    out.reset();

    expect(out.text()).toBe("");
    expect(out.totalBytes).toBe(0);
    expect(out.droppedBytes).toBe(0);
    expect(out.truncated).toBe(false);
  });
});
