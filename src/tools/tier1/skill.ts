import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import type { SkillRegistry } from "../../skills/index.js";

const inputSchema = z.object({
  id: z.string(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "skill",
  description:
    "Load a skill by id and return its prompt body. " +
    "The model reads the skill body as its next context injection. " +
    "Use `list_skills` (when available) to enumerate available skill ids.",
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
  requiredPermission: "none",
  tier: 1,
};

/**
 * Build the skill ToolImpl, closed over an optional SkillRegistry.
 * If the registry is not provided (Phase 7 not yet wired), every call
 * returns a "skills not configured" error.
 */
export function buildSkillTool(registry: SkillRegistry | undefined): ToolImpl {
  return {
    spec,
    zodSchema: inputSchema,
    async execute(raw: unknown, _ctx: ToolExecutionContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) {
        return { status: "error", message: parsed.error.message };
      }
      const input: Input = parsed.data;

      if (!registry) {
        return {
          status: "error",
          message: "skills not configured (SkillRegistry unavailable)",
        };
      }

      let loaded;
      try {
        loaded = await registry.load(input.id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { status: "error", message: `skill load failed: ${msg}` };
      }

      if (!loaded) {
        return { status: "error", message: `skill '${input.id}' not found` };
      }

      return { status: "ok", output: loaded.body };
    },
  };
}
