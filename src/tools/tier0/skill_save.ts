import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import {
  getSkillStore,
  formatSkill,
  formatSkillList,
} from "../../memory/skills.js";

const inputSchema = z.object({
  action: z
    .enum(["save", "list", "get", "remove"])
    .describe(
      "Action to perform. 'save' creates or updates a skill. 'list' shows all skills. " +
        "'get' retrieves a specific skill. 'remove' deletes a skill.",
    ),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i)
    .optional()
    .describe("Skill name (kebab-case identifier). Required for save/get/remove."),
  tags: z
    .array(z.string().min(1))
    .optional()
    .describe("Searchable tags for the skill. Used for save action."),
  content: z
    .string()
    .min(1)
    .optional()
    .describe("The procedure/skill content in Markdown. Required for save action."),
});

type Input = z.infer<typeof inputSchema>;

const MAX_SKILL_SIZE = 1000;

const spec: ToolSpec = {
  name: "skill_save",
  description:
    "Manage reusable skills (procedural memory). Skills capture 'how-to' procedures " +
    "like deployment steps, testing workflows, or team conventions. " +
    "Use 'save' to create/update, 'list' to see all, 'get' to retrieve one, 'remove' to delete.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "none",
  tier: 0,
  concurrencySafe: false,
};

async function execute(
  raw: unknown,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;
  const store = getSkillStore();

  switch (input.action) {
    case "save": {
      if (!input.name) {
        return { status: "error", message: "name is required for save action" };
      }
      if (!input.content) {
        return { status: "error", message: "content is required for save action" };
      }
      if (input.content.length > MAX_SKILL_SIZE) {
        return {
          status: "error",
          message: `skill content exceeds ${MAX_SKILL_SIZE} character limit (${input.content.length} chars)`,
        };
      }

      const skill = {
        name: input.name,
        tags: input.tags ?? [],
        content: input.content,
      };
      try {
        await store.save(skill);
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        status: "ok",
        output: `Skill "${input.name}" saved.\n\n${formatSkill(skill)}`,
      };
    }

    case "list": {
      const skills = await store.list();
      return { status: "ok", output: formatSkillList(skills) };
    }

    case "get": {
      if (!input.name) {
        return { status: "error", message: "name is required for get action" };
      }
      const skill = await store.get(input.name);
      if (!skill) {
        return {
          status: "error",
          message: `skill "${input.name}" not found`,
        };
      }
      return { status: "ok", output: formatSkill(skill) };
    }

    case "remove": {
      if (!input.name) {
        return { status: "error", message: "name is required for remove action" };
      }
      const removed = await store.remove(input.name);
      if (!removed) {
        return {
          status: "error",
          message: `skill "${input.name}" not found`,
        };
      }
      return {
        status: "ok",
        output: `Skill "${input.name}" removed.`,
      };
    }

    default:
      return { status: "error", message: `unknown action: ${(input as any).action}` };
  }
}

export const skillSaveTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
