/**
 * bedrock-llm.ts — an `LlmComplete` seam for the MAST judge backed by Amazon Bedrock's InvokeModel
 * (Anthropic messages API) using bearer-token auth (AWS_BEARER_TOKEN_BEDROCK). Self-contained: no AWS
 * SDK, just fetch. Run under node (tsx), with `source ~/.zshrc` for the token.
 */
import type { LlmComplete } from "./judge.js";

export function bedrockLlm(opts: { model?: string; region?: string; maxTokens?: number } = {}): LlmComplete {
  const model = opts.model ?? process.env.H1_MODEL ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
  const region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error("bedrockLlm: AWS_BEARER_TOKEN_BEDROCK not set (source ~/.zshrc)");
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
  const maxTokens = opts.maxTokens ?? 4096;
  return async ({ system, prompt }) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`bedrockLlm: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return (data.content ?? []).map((c) => c.text ?? "").join("");
  };
}
