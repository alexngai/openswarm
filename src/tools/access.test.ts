import { describe, it, expect } from "vitest";
import { ToolAccesses } from "./access.js";

describe("ToolAccesses.conflict", () => {
  it("no accesses on either side never conflict", () => {
    expect(ToolAccesses.conflict(ToolAccesses.none(), ToolAccesses.none())).toBe(false);
    expect(ToolAccesses.conflict(ToolAccesses.none(), ToolAccesses.readFile("/a"))).toBe(false);
    expect(ToolAccesses.conflict(ToolAccesses.writeFile("/a"), ToolAccesses.none())).toBe(false);
  });

  it("`all` conflicts with everything (including other `all`)", () => {
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.all())).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.readFile("/a"))).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.writeFile("/b"))).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.searchTree("/c"))).toBe(true);
    expect(ToolAccesses.conflict(ToolAccesses.all(), ToolAccesses.none())).toBe(false);
  });

  it("two reads of the same file never conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.readFile("/a")),
    ).toBe(false);
  });

  it("two reads of different files never conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.readFile("/b")),
    ).toBe(false);
  });

  it("read + write same file conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.writeFile("/a")),
    ).toBe(true);
  });

  it("read + write different files do NOT conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.readFile("/a"), ToolAccesses.writeFile("/b")),
    ).toBe(false);
  });

  it("two writes to different files do NOT conflict (the main win)", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.writeFile("/a"), ToolAccesses.writeFile("/b")),
    ).toBe(false);
  });

  it("two writes to the same file conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.writeFile("/a"), ToolAccesses.writeFile("/a")),
    ).toBe(true);
  });

  it("search and read on overlapping subtrees do NOT conflict", () => {
    expect(
      ToolAccesses.conflict(ToolAccesses.searchTree("/src"), ToolAccesses.readFile("/src/a.ts")),
    ).toBe(false);
  });

  it("search on subtree conflicts with write inside that subtree", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.searchTree("/src"),
        ToolAccesses.writeFile("/src/a.ts"),
      ),
    ).toBe(true);
  });

  it("search on subtree does NOT conflict with write elsewhere", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.searchTree("/src"),
        ToolAccesses.writeFile("/other/a.ts"),
      ),
    ).toBe(false);
  });

  it("readwrite conflicts with any other operation on the same file", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readWriteFile("/a"),
        ToolAccesses.readFile("/a"),
      ),
    ).toBe(true);
    expect(
      ToolAccesses.conflict(
        ToolAccesses.readWriteFile("/a"),
        ToolAccesses.writeFile("/a"),
      ),
    ).toBe(true);
  });

  it("paths are normalized: forward and back slashes match", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.writeFile("/src/a.ts"),
        ToolAccesses.writeFile("\\src\\a.ts"),
      ),
    ).toBe(true);
  });

  it("paths are normalized: trailing slash on directory matches", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.searchTree("/src/"),
        ToolAccesses.writeFile("/src/a.ts"),
      ),
    ).toBe(true);
  });

  it("prefix matching is path-component aware (does NOT match /srcX/foo when root is /src)", () => {
    expect(
      ToolAccesses.conflict(
        ToolAccesses.searchTree("/src"),
        ToolAccesses.writeFile("/srcX/foo.ts"),
      ),
    ).toBe(false);
  });
});
