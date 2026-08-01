/**
 * bedrock-toolcheck.ts — does a Bedrock model actually STREAM tool-use in our stack?
 *
 * The docs/62 Phase-2 gate: agentic SWE needs the cheap tier to drive tool calls, and
 * Llama-3.1-8B silently does NOT stream tool-use on Bedrock in our stack (commit
 * 239cb4e), which would disqualify it as an agentic cheap tier. This sends one tool
 * request and reports whether a `tool-call` event with parseable input streams back.
 * Reusable for vetting any future Bedrock candidate before an expensive agentic run.
 *
 * Run: AWS_REGION=us-west-2 TC_MODEL=awsbedrock/qwen.qwen3-coder-30b-a3b-v1:0 \
 *      npx tsx eval/scripts/bedrock-toolcheck.ts
 */
import { resolveProvider } from "../../src/providers/routing.js";
import type { ProviderRequest } from "../../src/providers/index.js";
import type { ToolSpec } from "../../src/core/types.js";

const MODEL = process.env.TC_MODEL ?? "awsbedrock/qwen.qwen3-coder-30b-a3b-v1:0";
const CHOICE = (process.env.TC_CHOICE ?? "auto") as "auto" | "required";

const tool: ToolSpec = {
  name: "get_weather",
  description: "Get the current weather for a given city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
  },
  requiredPermission: "none",
  tier: 0,
};

async function main(): Promise<number> {
  const r = resolveProvider(MODEL);
  if (r.kind !== "native" || !r.providerFactory) throw new Error(`not a native transport for "${MODEL}" (kind=${r.kind})`);
  const auth = r.authFactory ? await r.authFactory() : (undefined as never);
  const provider = await r.providerFactory(auth, r.modelId ?? MODEL);

  const req: ProviderRequest = {
    model: r.modelId ?? MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "What is the weather in Paris right now? Call the get_weather tool to find out." }] }],
    tools: [tool],
    toolChoice: CHOICE,
    maxOutputTokens: 512,
  };

  const events: string[] = [];
  let toolCall: { name: string; input: unknown } | null = null;
  let text = "";
  for await (const ev of provider.stream(req)) {
    events.push(ev.type);
    if (ev.type === "tool-call") toolCall = { name: ev.name, input: ev.input };
    else if (ev.type === "text-delta") text += ev.text;
    else if (ev.type === "error") { console.error(`ERROR event: ${ev.message}`); return 2; }
  }

  console.log(`model:       ${MODEL}  (toolChoice=${CHOICE})`);
  console.log(`event types: ${[...new Set(events)].join(", ")}`);
  if (toolCall) {
    console.log(`✓ TOOL-USE STREAMS — tool-call ${toolCall.name}(${JSON.stringify(toolCall.input)})`);
    return 0;
  }
  console.log(`✗ NO tool-call streamed (text-only: ${JSON.stringify(text.slice(0, 140))})`);
  return 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("FAILED:", e); process.exit(3); });
