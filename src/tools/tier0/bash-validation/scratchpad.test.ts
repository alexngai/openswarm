/**
 * Tests for the scratchpad exemption in bash validation.
 *
 * The strip helper itself plus its effect on the path and mode submodules:
 * commands touching the session scratchpad must not trigger warn prompts,
 * while identical commands touching other system paths still do.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scratchpadRoot, stripScratchpadPaths } from "./scratchpad.js";
import { validatePath } from "./path.js";
import { validateMode } from "./mode.js";

const CWD = "/workspace/project";
const ROOT = "/var/folders/xg/T/openswarm-501/-workspace-project/sess-1/scratchpad";

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.OPENSWARM_SCRATCHPAD_DIR;
  process.env.OPENSWARM_SCRATCHPAD_DIR = ROOT;
});

afterEach(() => {
  if (saved !== undefined) process.env.OPENSWARM_SCRATCHPAD_DIR = saved;
  else delete process.env.OPENSWARM_SCRATCHPAD_DIR;
});

describe("stripScratchpadPaths", () => {
  it("removes the root and any subpath tail", () => {
    expect(stripScratchpadPaths(`cat ${ROOT}/notes.txt`)).toBe("cat ");
    expect(stripScratchpadPaths(`cp a ${ROOT}/agents/w1/out.json && echo ok`)).toBe(
      "cp a  && echo ok",
    );
  });

  it("leaves non-scratchpad paths untouched", () => {
    expect(stripScratchpadPaths("cat /etc/hosts")).toBe("cat /etc/hosts");
  });

  it("is a no-op when no scratchpad is active", () => {
    delete process.env.OPENSWARM_SCRATCHPAD_DIR;
    expect(scratchpadRoot()).toBeUndefined();
    expect(stripScratchpadPaths(`cat ${ROOT}/x`)).toBe(`cat ${ROOT}/x`);
  });

  it("handles regex metacharacters in the root", () => {
    process.env.OPENSWARM_SCRATCHPAD_DIR = "/tmp/open(swarm)+/scratchpad";
    expect(stripScratchpadPaths("ls /tmp/open(swarm)+/scratchpad/x")).toBe("ls ");
  });
});

describe("validatePath with an active scratchpad", () => {
  it("allows system-temp scratchpad references", () => {
    expect(validatePath(`cat ${ROOT}/notes.txt`, CWD).kind).toBe("allow");
  });

  it("still warns on non-scratchpad system paths in the same command", () => {
    const result = validatePath(`cp /usr/local/bin/tool ${ROOT}/tool`, CWD);
    expect(result.kind).toBe("warn");
  });

  it("still blocks hot files even alongside scratchpad paths", () => {
    const result = validatePath(`cp /etc/passwd ${ROOT}/pw`, CWD);
    expect(result.kind).toBe("block");
  });

  it("exempts scratchpad roots under warn-listed system paths", () => {
    process.env.OPENSWARM_SCRATCHPAD_DIR = "/usr/scratch/sess/scratchpad";
    expect(validatePath("cat /usr/scratch/sess/scratchpad/a.txt", CWD).kind).toBe(
      "allow",
    );
  });
});

describe("validateMode (workspace-write) with an active scratchpad", () => {
  it("allows write commands targeting the scratchpad", () => {
    expect(validateMode(`cp build.log ${ROOT}/build.log`, "workspace-write").kind).toBe(
      "allow",
    );
    expect(validateMode(`mkdir -p ${ROOT}/run1`, "workspace-write").kind).toBe(
      "allow",
    );
  });

  it("still warns on write commands targeting other system paths", () => {
    expect(validateMode("cp build.log /var/log/build.log", "workspace-write").kind).toBe(
      "warn",
    );
  });

  it("warns on scratchpad-like paths when no scratchpad is active", () => {
    delete process.env.OPENSWARM_SCRATCHPAD_DIR;
    expect(validateMode(`cp build.log ${ROOT}/build.log`, "workspace-write").kind).toBe(
      "warn",
    );
  });
});
