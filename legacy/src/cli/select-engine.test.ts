import { describe, it, expect } from "vitest";
import { planEngine, CODEX_NATIVE_DEFAULT_MODEL } from "./select-engine.js";

describe("planEngine — codex frameworks precede scripted", () => {
  it("plans codex-chatgpt even under scripted mode", () => {
    const r = planEngine({ framework: "codex-chatgpt", resolvedModelId: "claude-sonnet-4-6", scripted: true });
    expect(r.ok && r.plan.kind).toBe("codex-chatgpt");
  });

  it("plans codex-native under scripted mode and defaults a non-gpt model", () => {
    const r = planEngine({ framework: "codex-native", resolvedModelId: "claude-sonnet-4-6", scripted: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kind).toBe("codex-native");
    if (r.plan.kind !== "codex-native") return;
    expect(r.plan.codexModelId).toBe(CODEX_NATIVE_DEFAULT_MODEL);
    expect(r.effectiveModelId).toBe(CODEX_NATIVE_DEFAULT_MODEL);
  });

  it("passes an explicit gpt model through codex-native unchanged", () => {
    const r = planEngine({ framework: "codex-native", resolvedModelId: "gpt-5.5" });
    expect(r.ok && r.effectiveModelId).toBe("gpt-5.5");
  });
});

describe("planEngine — scripted", () => {
  it("plans scripted when scripted mode is on for non-codex frameworks", () => {
    const r = planEngine({ framework: "auto", resolvedModelId: "claude-sonnet-4-6", scripted: true });
    expect(r.ok && r.plan.kind).toBe("scripted");
  });
});

describe("planEngine — auto (2.1: non-Claude → hardened)", () => {
  it("routes Claude through the SDK", () => {
    const r = planEngine({ framework: "auto", resolvedModelId: "claude-sonnet-4-6" });
    expect(r.ok && r.plan.kind).toBe("claude-sdk");
  });

  it("routes a non-Claude native model to a HARDENED native engine", () => {
    const r = planEngine({ framework: "auto", resolvedModelId: "gpt-5.5" });
    expect(r.ok).toBe(true);
    if (!r.ok || r.plan.kind !== "native") throw new Error("expected native plan");
    expect(r.plan.hardened).toBe(true);
  });

  it("errors on an unknown model prefix", () => {
    const r = planEngine({ framework: "auto", resolvedModelId: "totally-unknown-model" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/unknown model/i);
  });
});

describe("planEngine — explicit frameworks", () => {
  it("native + non-Claude → non-hardened native", () => {
    const r = planEngine({ framework: "native", resolvedModelId: "gpt-5.5" });
    if (!r.ok || r.plan.kind !== "native") throw new Error("expected native plan");
    expect(r.plan.hardened).toBe(false);
  });

  it("hardened-native + non-Claude → hardened native", () => {
    const r = planEngine({ framework: "hardened-native", resolvedModelId: "gpt-5.5" });
    if (!r.ok || r.plan.kind !== "native") throw new Error("expected native plan");
    expect(r.plan.hardened).toBe(true);
  });

  it("native + Claude is a hard error (no silent SDK fallback)", () => {
    const r = planEngine({ framework: "native", resolvedModelId: "claude-sonnet-4-6" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/does not support Claude/i);
  });

  it("claude-agent-sdk + Claude → sdk plan", () => {
    const r = planEngine({ framework: "claude-agent-sdk", resolvedModelId: "claude-sonnet-4-6" });
    expect(r.ok && r.plan.kind).toBe("claude-sdk");
  });

  it("claude-agent-sdk + non-Claude is a hard error", () => {
    const r = planEngine({ framework: "claude-agent-sdk", resolvedModelId: "gpt-5.5" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/requires an Anthropic model/i);
  });
});
