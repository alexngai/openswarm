/**
 * FX-JOURNAL-005..012 — a snapshot is either the document that was written or
 * visibly not (docs/63 `WP-07`).
 *
 * The failure mode a snapshot has to defend against is not throwing. It is
 * resuming from a state that never existed: a document truncated at an arbitrary
 * byte, a file half-replaced by a concurrent write, a backup restored from the
 * middle. All of those read back as plausible data, and none of them are what
 * anybody saved.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { writeSnapshot, readSnapshot } from "./atomic-snapshot.js";

let dir: string;
const dirs: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-"));
  dirs.push(dir);
});

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

const file = (): string => path.join(dir, "state.json");

interface State {
  readonly units: readonly string[];
  readonly at: number;
}

const isState = (v: unknown): v is State =>
  typeof v === "object" && v !== null && Array.isArray((v as State).units);

describe("FX-JOURNAL-005 round trip", () => {
  it("reads back exactly what was written", async () => {
    const state: State = { units: ["a", "b"], at: 7 };
    await writeSnapshot(file(), state);

    const read = await readSnapshot<State>(file(), isState);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") {
      expect(read.data).toEqual(state);
      expect(read.writtenAt).toBeGreaterThan(0);
    }
  });

  it("distinguishes a missing snapshot from a broken one", async () => {
    // Opposite responses: absent means start fresh, corrupt means something went
    // wrong that someone should hear about. Reporting the second as the first is
    // how a data loss becomes a clean-looking start.
    expect((await readSnapshot(file())).kind).toBe("absent");
  });
});

describe("FX-JOURNAL-006 corruption is detected rather than parsed", () => {
  it("rejects a snapshot whose contents were altered", async () => {
    await writeSnapshot(file(), { units: ["a"], at: 1 });

    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as { data: State };
    raw.data = { units: ["a", "smuggled"], at: 1 };
    fs.writeFileSync(file(), JSON.stringify(raw));

    const read = await readSnapshot<State>(file(), isState);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.reason).toBe("checksum mismatch");
  });

  it("rejects a snapshot truncated part way through", async () => {
    await writeSnapshot(file(), { units: ["a", "b", "c"], at: 1 });
    const raw = fs.readFileSync(file(), "utf8");
    fs.writeFileSync(file(), raw.slice(0, Math.floor(raw.length / 2)));

    expect((await readSnapshot(file())).kind).toBe("corrupt");
  });

  it("rejects a file that is valid JSON but not a snapshot", async () => {
    // The shape this catches: a hand-edited file, or one written by the older
    // uncheckummed path. Accepting it would silently resume from unverified data.
    fs.writeFileSync(file(), JSON.stringify({ units: ["a"], at: 1 }));
    const read = await readSnapshot(file());
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.reason).toBe("not a checksummed snapshot");
  });

  it("rejects an intact snapshot of the wrong shape", async () => {
    await writeSnapshot(file(), { somethingElse: true });
    const read = await readSnapshot<State>(file(), isState);
    expect(read.kind).toBe("corrupt");
    if (read.kind === "corrupt") expect(read.reason).toBe("payload failed validation");
  });
});

describe("FX-JOURNAL-007 a reader never sees a half-replaced snapshot", () => {
  it("leaves the previous snapshot readable until the new one is complete", async () => {
    await writeSnapshot(file(), { units: ["first"], at: 1 });

    // Read continuously while a rewrite is in flight. Every read must land on one
    // of the two documents; a mixture would mean the file was edited in place.
    const rewrite = writeSnapshot(file(), { units: ["second"], at: 2 });
    const observed: string[][] = [];
    for (let i = 0; i < 40; i++) {
      const read = await readSnapshot<State>(file(), isState);
      if (read.kind === "ok") observed.push([...read.data.units]);
    }
    await rewrite;

    expect(observed.length).toBeGreaterThan(0);
    for (const units of observed) {
      expect(["first", "second"]).toContain(units[0]);
      expect(units).toHaveLength(1);
    }
  });

  it("does not leave its temp files behind", async () => {
    await writeSnapshot(file(), { units: [], at: 0 });
    await writeSnapshot(file(), { units: ["x"], at: 1 });

    const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("FX-JOURNAL-008 concurrent writers do not produce a mixture", () => {
  it("ends on one of the written documents, intact", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => writeSnapshot(file(), { units: [`w${i}`], at: i })),
    );

    const read = await readSnapshot<State>(file(), isState);
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.data.units).toHaveLength(1);
  });
});
