/**
 * Flatten an ACP prompt (ContentBlock[]) into the plain-text prompt string the
 * engine expects. Text blocks are concatenated; resource_link becomes an
 * `@<uri>` reference; embedded text resources are inlined. Image/audio blocks
 * are skipped (not advertised in promptCapabilities for Stage A).
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";

export function promptToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push(b.text);
        break;
      case "resource_link":
        parts.push(`@${b.uri}`);
        break;
      case "resource": {
        const r = b.resource as { text?: unknown; uri?: unknown };
        if (typeof r.text === "string") {
          parts.push(r.text);
        } else if (typeof r.uri === "string") {
          parts.push(`@${r.uri}`);
        }
        break;
      }
      default:
        // image / audio — skipped
        break;
    }
  }
  return parts.join("\n");
}
