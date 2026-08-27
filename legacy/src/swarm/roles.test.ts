/**
 * roles.test.ts — unit tests for RoleRegistry + built-ins + loadCustomRoles.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  RoleRegistry,
  BUILTIN_ROLES,
  loadCustomRoles,
  type Role,
} from "./roles.js";

describe("RoleRegistry", () => {
  it("register + get round-trip a role by name", () => {
    const reg = new RoleRegistry();
    const role: Role = {
      name: "docs",
      systemPromptSuffix: "You write docs.",
      allowedTools: ["read_file", "grep"],
    };
    reg.register(role);
    expect(reg.get("docs")).toEqual(role);
  });

  it("get returns undefined for unknown role names", () => {
    const reg = new RoleRegistry();
    expect(reg.get("nobody")).toBeUndefined();
  });

  it("list returns every registered role", () => {
    const reg = new RoleRegistry();
    for (const r of BUILTIN_ROLES) reg.register(r);
    const names = reg.list().map((r) => r.name);
    expect(names).toEqual([
      "architect",
      "executor",
      "reviewer",
      "resolver",
      "integrator",
    ]);
  });

  it("register overwrites a role with the same name", () => {
    const reg = new RoleRegistry();
    reg.register({
      name: "x",
      systemPromptSuffix: "old",
      allowedTools: ["bash"],
    });
    reg.register({
      name: "x",
      systemPromptSuffix: "new",
      allowedTools: ["read_file"],
    });
    expect(reg.get("x")?.systemPromptSuffix).toBe("new");
    expect(reg.get("x")?.allowedTools).toEqual(["read_file"]);
    expect(reg.list()).toHaveLength(1);
  });
});

describe("BUILTIN_ROLES", () => {
  it("ships the expected built-ins", () => {
    const names = BUILTIN_ROLES.map((r) => r.name).sort();
    expect(names).toEqual([
      "architect",
      "executor",
      "integrator",
      "resolver",
      "reviewer",
    ]);
  });

  it("architect excludes write tools and includes agent/task_* + messaging", () => {
    const arch = BUILTIN_ROLES.find((r) => r.name === "architect")!;
    expect(arch.allowedTools).not.toContain("bash");
    expect(arch.allowedTools).not.toContain("write_file");
    expect(arch.allowedTools).not.toContain("edit_file");
    expect(arch.allowedTools).not.toContain("multi_edit");
    expect(arch.allowedTools).toContain("read_file");
    expect(arch.allowedTools).toContain("agent");
    expect(arch.allowedTools).toContain("task_create");
    expect(arch.allowedTools).toContain("send_message");
    expect(arch.systemPromptSuffix).toContain("architect");
  });

  it("executor has full Tier 0 write surface + Tier 1 but not agent", () => {
    const exec = BUILTIN_ROLES.find((r) => r.name === "executor")!;
    expect(exec.allowedTools).toContain("bash");
    expect(exec.allowedTools).toContain("write_file");
    expect(exec.allowedTools).toContain("edit_file");
    expect(exec.allowedTools).toContain("multi_edit");
    expect(exec.allowedTools).toContain("web_fetch");
    expect(exec.allowedTools).toContain("structured_output");
    // no recursive spawn
    expect(exec.allowedTools).not.toContain("agent");
    // no task_create (executors don't dispatch new tasks)
    expect(exec.allowedTools).not.toContain("task_create");
    expect(exec.systemPromptSuffix).toContain("executor");
  });

  it("reviewer is read-only: no bash/write_file/edit_file/multi_edit/agent", () => {
    const rev = BUILTIN_ROLES.find((r) => r.name === "reviewer")!;
    expect(rev.allowedTools).not.toContain("bash");
    expect(rev.allowedTools).not.toContain("write_file");
    expect(rev.allowedTools).not.toContain("edit_file");
    expect(rev.allowedTools).not.toContain("multi_edit");
    expect(rev.allowedTools).not.toContain("agent");
    expect(rev.allowedTools).toContain("read_file");
    expect(rev.allowedTools).toContain("structured_output");
    expect(rev.systemPromptSuffix).toContain("reviewer");
  });
});

describe("loadCustomRoles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns [] when the config file is missing", async () => {
    const result = await loadCustomRoles(
      "/definitely/does/not/exist/roles.json",
    );
    expect(result).toEqual([]);
  });

  it("loads valid roles from a JSON file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-"));
    const cfgPath = path.join(tmpDir, "roles.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        roles: [
          {
            name: "docs",
            systemPromptSuffix: "You write docs.",
            allowedTools: ["read_file", "grep"],
          },
          {
            name: "analyst",
            systemPromptSuffix: "Analyze.",
            allowedTools: ["read_file", "web_fetch"],
          },
        ],
      }),
    );
    const out = await loadCustomRoles(cfgPath);
    expect(out).toHaveLength(2);
    expect(out[0]!.name).toBe("docs");
    expect(out[0]!.allowedTools).toEqual(["read_file", "grep"]);
    expect(out[1]!.name).toBe("analyst");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips invalid entries with a stderr warning and keeps the valid ones", async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderrLines.push(String(c));
      return true;
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-bad-"));
    const cfgPath = path.join(tmpDir, "roles.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        roles: [
          // valid
          {
            name: "docs",
            systemPromptSuffix: "Docs.",
            allowedTools: ["read_file"],
          },
          // invalid — missing allowedTools
          { name: "broken", systemPromptSuffix: "x" },
          // invalid — empty name
          {
            name: "",
            systemPromptSuffix: "x",
            allowedTools: [],
          },
        ],
      }),
    );
    const out = await loadCustomRoles(cfgPath);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("docs");
    const combined = stderrLines.join("");
    expect(combined).toContain("skipping invalid role at index 1");
    expect(combined).toContain("skipping invalid role at index 2");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] and warns when the file is malformed JSON", async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderrLines.push(String(c));
      return true;
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-mal-"));
    const cfgPath = path.join(tmpDir, "roles.json");
    fs.writeFileSync(cfgPath, "{ this is not json }");
    const out = await loadCustomRoles(cfgPath);
    expect(out).toEqual([]);
    expect(stderrLines.join("")).toContain("malformed JSON");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns [] and warns when the top-level shape is wrong", async () => {
    const stderrLines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
      stderrLines.push(String(c));
      return true;
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roles-shape-"));
    const cfgPath = path.join(tmpDir, "roles.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ rolez: [] }));
    const out = await loadCustomRoles(cfgPath);
    expect(out).toEqual([]);
    expect(stderrLines.join("")).toContain("invalid shape");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
