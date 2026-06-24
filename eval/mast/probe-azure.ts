/** probe-azure.ts — find a working Azure OpenAI deployment name. Run: tsx eval/mast/probe-azure.ts */
import { azureLlm } from "./azure-llm.js";

const candidates = process.env.AZURE_DEPLOYMENT
  ? [process.env.AZURE_DEPLOYMENT]
  : ["gpt-4o", "gpt-4.1", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-4", "gpt-35-turbo", "o4-mini"];

for (const dep of candidates) {
  try {
    const llm = azureLlm({ deployment: dep, maxTokens: 16 });
    const out = await llm({ system: "Reply with exactly: OK", prompt: "ping" });
    console.log(`✅ ${dep} -> ${JSON.stringify(out.slice(0, 40))}`);
    break;
  } catch (e) {
    console.log(`❌ ${dep} -> ${(e as Error).message.slice(0, 120)}`);
  }
}
