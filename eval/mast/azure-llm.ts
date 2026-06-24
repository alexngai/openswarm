/**
 * azure-llm.ts — an `LlmComplete` seam for the MAST judge backed by Azure OpenAI chat-completions.
 * Used as an alternative judge backend when the Bedrock daily quota is exhausted (and a cross-family
 * judge — GPT grading Claude runs — reduces self-judging bias). Self-contained: just fetch.
 *
 * Env: AZURE_API_BASE (or AZURE_OPENAI_ENDPOINT), AZURE_OPENAI_API_KEY, AZURE_DEPLOYMENT (deployment
 * name), AZURE_OPENAI_API_VERSION (default 2024-08-01-preview).
 */
import type { LlmComplete } from "./judge.js";

export function azureLlm(opts: { deployment?: string; apiVersion?: string; maxTokens?: number } = {}): LlmComplete {
  const base = (process.env.AZURE_API_BASE ?? process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/$/, "");
  const key = process.env.AZURE_OPENAI_API_KEY;
  const deployment = opts.deployment ?? process.env.AZURE_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o";
  const apiVersion = opts.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview";
  if (!base || !key) throw new Error("azureLlm: set AZURE_API_BASE + AZURE_OPENAI_API_KEY (source ~/.zshrc)");
  const url = `${base}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  const maxTokens = opts.maxTokens ?? 4096;

  const call = async (tokenParam: "max_completion_tokens" | "max_tokens", system: string, prompt: string) =>
    fetch(url, {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        [tokenParam]: maxTokens,
      }),
    });

  return async ({ system, prompt }) => {
    // Newer models (o-series / gpt-5) require max_completion_tokens; older deployments only accept
    // max_tokens. Try the modern param, fall back on the specific 400.
    let res = await call("max_completion_tokens", system, prompt);
    if (res.status === 400) {
      const t = await res.text();
      if (/max_completion_tokens|unsupported|unknown.*param|max_tokens/i.test(t)) {
        res = await call("max_tokens", system, prompt);
      } else {
        throw new Error(`azureLlm: HTTP 400 ${t.slice(0, 400)}`);
      }
    }
    if (!res.ok) throw new Error(`azureLlm: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  };
}
