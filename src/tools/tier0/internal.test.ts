import { describe, it, expect } from "vitest";
import { truncateUtf8, headTailTruncate } from "./internal.js";

describe("truncateUtf8", () => {
  it("returns full string when under limit", () => {
    const buf = Buffer.from("hello");
    expect(truncateUtf8(buf)).toBe("hello");
  });

  it("truncates at UTF-8 boundary and appends marker", () => {
    const euro = "€"; // 3 bytes
    const count = Math.ceil((16 * 1024 + 2) / 3);
    const buf = Buffer.from(euro.repeat(count));
    const result = truncateUtf8(buf);
    expect(result).toContain("[truncated]");
    const before = result.split("[truncated]")[0]!;
    expect(before).not.toContain("�");
  });
});

describe("headTailTruncate", () => {
  it("returns full string when under head+tail budget", () => {
    const buf = Buffer.from("short output");
    expect(headTailTruncate(buf)).toBe("short output");
  });

  it("preserves head and tail for large buffers", () => {
    const headSize = 100;
    const tailSize = 100;
    const head = "H".repeat(headSize);
    const middle = "M".repeat(500);
    const tail = "T".repeat(tailSize);
    const buf = Buffer.from(head + middle + tail);

    const result = headTailTruncate(buf, {
      headBytes: headSize,
      tailBytes: tailSize,
    });

    expect(result).toContain("H".repeat(headSize));
    expect(result).toContain("T".repeat(tailSize));
    expect(result).toContain("[... truncated");
    expect(result).toContain("bytes ...]");
    expect(result).not.toContain("M".repeat(10));
  });

  it("reports correct number of omitted bytes", () => {
    const buf = Buffer.from("A".repeat(100) + "B".repeat(300) + "C".repeat(100));
    const result = headTailTruncate(buf, { headBytes: 100, tailBytes: 100 });
    expect(result).toContain("[... truncated 300 bytes ...]");
  });

  it("handles UTF-8 multibyte at head boundary", () => {
    const head = "a".repeat(98) + "€"; // 98 + 3 = 101 bytes
    const tail = "z".repeat(100);
    const middle = "x".repeat(200);
    const buf = Buffer.from(head + middle + tail);

    const result = headTailTruncate(buf, { headBytes: 100, tailBytes: 100 });
    expect(result).not.toContain("�");
    expect(result).toContain("[... truncated");
  });

  it("handles UTF-8 multibyte at tail boundary", () => {
    const head = "a".repeat(100);
    const middle = "x".repeat(200);
    const tail = "€" + "z".repeat(97); // 3 + 97 = 100 bytes
    const buf = Buffer.from(head + middle + tail);

    const result = headTailTruncate(buf, { headBytes: 100, tailBytes: 100 });
    expect(result).not.toContain("�");
    expect(result).toContain("z".repeat(97));
  });

  it("uses defaults of 20 KiB each", () => {
    const size = 20 * 1024;
    const buf = Buffer.alloc(size * 2 + 1000, 0x41); // 41 KiB of 'A'
    const result = headTailTruncate(buf);
    expect(result).toContain("[... truncated 1000 bytes ...]");
  });
});
