/**
 * FX-AUDIT-012..014 — both dispatch paths resolve what the gate prepared
 * (docs/67 `WP-00a` remainder).
 *
 * The gate records an `AttemptPrepared` for every authorized call, and the
 * ledger that brackets execution records the terminal fact. Only one of the two
 * dispatch paths goes through that ledger. Eager dispatch does; the batch path,
 * which is the default because `eagerToolDispatch` defaults to false, does not —
 * so when the gate started recording, the default path began writing a prepare
 * with no resolve for every tool call the product made.
 *
 * That is not a missing record, it is a wrong one. A prepare with no resolve is
 * the signature recovery reads as "this process died before the effect
 * finished", so the shape of the bug was an audit trail that reported a crash
 * per tool call and would have had recovery reconciling effects that completed
 * normally. Nothing existing caught it: the correlation fixtures drive the
 * ledger directly, and every engine test asserts results rather than records.
 *
 * These drive the real engine on each path and assert the same property, since
 * the two paths agreeing is the actual requirement — a fixture per path would
 * still pass while they disagreed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { HardenedNativeEngine } from "./hardened-native.js";
import type { RunConfig, PermissionDecision } from "./index.js";
import type {
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "../providers/index.js";
import type { NormalizedEvent } from "../core/types.js";
import type { ToolDispatcher, ToolRequest } from "../tools/dispatcher.js";
import type { ToolImpl, ToolResult } from "../tools/types.js";
import { ToolAccesses } from "../tools/access.js";
import { openAuditJournal, AUDIT_DIR, type AuditJournal } from "../kernel/audit-journal.js";
import type { AttemptResolver } from "./operation-ledger.js";
import type { EffectOutcome } from "../kernel/contracts.js";

const SESSION = "s-dispatch";
let workspace: string;
let journal: AuditJournal;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-dispatch-"));
  journal = openAuditJournal(workspace);
});

afterEach(async () => {
  await journal.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

class OneTurnProvider implements Provider {
  readonly id = "mock";
  readonly model = "mock-model" as never;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    promptCache: false,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 16_000,
  };

  private idx = 0;

  constructor(private readonly calls: readonly ProviderEvent[]) {}

  async *stream(_req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // First stream announces the tools; the second ends the turn, so the engine
    // gets all the way through dispatch and result handling.
    if (this.idx++ === 0) {
      for (const ev of this.calls) yield ev;
      return;
    }
    yield { type: "text", text: "done" };
  }
}

class Dispatcher {
  readonly dispatched: string[] = [];

  constructor(private readonly registry: ReadonlyMap<string, ToolImpl>) {}

  get(name: string): ToolImpl | undefined {
    return this.registry.get(name);
  }

  async dispatch(name: string, _input: unknown): Promise<ToolResult> {
    this.dispatched.push(name);
    return { status: "ok", output: `did ${name}` };
  }

  async dispatchBatch(requests: readonly ToolRequest[]): Promise<readonly ToolResult[]> {
    const out: ToolResult[] = [];
    for (const req of requests) out.push(await this.dispatch(req.name, req.input));
    return out;
  }
}

const WRITE: ToolImpl = {
  spec: {
    name: "write",
    description: "write",
    inputSchema: { type: "object" },
    requiredPermission: "write",
    tier: 0,
  },
  execute: async () => ({ status: "ok" as const, output: "write" }),
  accesses: (i) => ToolAccesses.writeFile((i as { path?: string }).path ?? "/tmp/x"),
};

/** The gate's half, standing in for `makeCanUseTool` with an `attempts` sink. */
function gateThatPrepares(ids: readonly string[]): RunConfig["canUseTool"] {
  return async (_name, _input) => {
    for (const operationId of ids) {
      await journal.append({
        sessionId: SESSION,
        type: "AttemptPrepared",
        payload: { operationId },
        causationId: operationId,
      });
    }
    return { allow: true, preparedOperationIds: ids } as PermissionDecision;
  };
}

const resolver: AttemptResolver = {
  resolve: async (outcome: EffectOutcome) => {
    await journal.append({
      sessionId: SESSION,
      type: "AttemptResolved",
      payload: { outcome },
      causationId: outcome.operationId,
    });
  },
};

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    systemPrompt: "sys",
    prompt: "hi",
    model: "mock-model",
    auth: { kind: "api-key" as const, providerId: "mock", isAuthenticated: async () => true },
    tools: [],
    canUseTool: async () => ({ allow: true }) as PermissionDecision,
    permissionMode: "workspace-write",
    maxTurns: 4,
    ...overrides,
  };
}

async function drain(events: AsyncIterable<NormalizedEvent>): Promise<void> {
  for await (const _ of events) void _;
}

/** Reads the journal off disk, so nothing in-memory can vouch for durability. */
function recorded(): Array<{ type: string; payload: Record<string, unknown> }> {
  const file = path.join(workspace, AUDIT_DIR, SESSION, "journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
}

/** Operation ids prepared and never resolved — the crash signature. */
function dangling(): string[] {
  const prepared = new Set<string>();
  for (const r of recorded()) {
    const id =
      r.type === "AttemptPrepared"
        ? (r.payload as { operationId?: string }).operationId
        : (r.payload as { outcome?: { operationId?: string } }).outcome?.operationId;
    if (id === undefined) continue;
    if (r.type === "AttemptPrepared") prepared.add(id);
    else prepared.delete(id);
  }
  return [...prepared];
}

async function runTurn(eager: boolean, dispatcher: Dispatcher, ids: readonly string[]) {
  const provider = new OneTurnProvider([
    { type: "tool-call", id: "t1", name: "write", input: { path: "/tmp/a" } },
  ]);
  const engine = new HardenedNativeEngine({
    provider,
    audit: resolver,
    ...(eager ? { eagerToolDispatch: true } : {}),
  });
  await drain(
    engine.run(
      config({
        dispatcher: dispatcher as unknown as ToolDispatcher,
        canUseTool: gateThatPrepares(ids),
      }),
    ),
  );
}

describe("attempt records across both dispatch paths", () => {
  it("FX-AUDIT-012 the default batch path resolves the attempt the gate prepared", async () => {
    const dispatcher = new Dispatcher(new Map([[WRITE.spec.name, WRITE]]));
    await runTurn(false, dispatcher, ["op-1"]);

    expect(dispatcher.dispatched).toEqual(["write"]);
    expect(recorded().map((r) => r.type)).toEqual(["AttemptPrepared", "AttemptResolved"]);
    // The assertion that fails when this path forgets: a dispatch that
    // completed must not be recorded as one that may not have.
    expect(dangling()).toEqual([]);
  });

  it("FX-AUDIT-013 the eager path resolves it too, and agrees with the default", async () => {
    const dispatcher = new Dispatcher(new Map([[WRITE.spec.name, WRITE]]));
    await runTurn(true, dispatcher, ["op-1"]);

    expect(recorded().map((r) => r.type)).toEqual(["AttemptPrepared", "AttemptResolved"]);
    expect(dangling()).toEqual([]);
  });

  it("FX-AUDIT-014 every prepared id is resolved, not just the first", async () => {
    // A call can name more than one resource, and the gate prepares one record
    // per authorized request. Resolving only the first would leave the rest
    // looking like a crash.
    const dispatcher = new Dispatcher(new Map([[WRITE.spec.name, WRITE]]));
    await runTurn(false, dispatcher, ["op-1", "op-2", "op-3"]);

    const resolved = recorded()
      .filter((r) => r.type === "AttemptResolved")
      .map((r) => (r.payload as { outcome: { operationId: string } }).outcome.operationId);
    expect(resolved.sort()).toEqual(["op-1", "op-2", "op-3"]);
    expect(dangling()).toEqual([]);
  });
});
