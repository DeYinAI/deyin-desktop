import { readFile } from "node:fs/promises";
import type { ToolDefinition } from "../types.js";
import { asOptionalString, asString } from "./util.js";

export const skillTool: ToolDefinition = {
  name: "skill",
  description:
    "Invoke a discovered skill by name. Returns the skill instructions for you to follow. Use when a skill matches the task.",
  tier: "read",
  parameters: {
    type: "object",
    properties: {
      skill_name: { type: "string", description: "Name of the skill to invoke." },
      context: { type: "string", description: "Optional extra context for this invocation." },
    },
    required: ["skill_name"],
  },
  summarize: (args) => String(args.skill_name ?? "skill"),
  async execute(args, ctx): Promise<string> {
    const skillName = asString(args.skill_name, "skill_name").toLowerCase();
    const extra = asOptionalString(args.context);
    const skills = ctx.skills ?? [];
    const match = skills.find((s) => s.name.toLowerCase() === skillName);
    if (!match) {
      const available = skills.map((s) => s.name).join(", ") || "(none)";
      return `Skill "${skillName}" not found. Available skills: ${available}`;
    }
    try {
      const content = await readFile(match.path, "utf8");
      const header = `## Skill: ${match.name}\n\n${match.description ? `${match.description}\n\n` : ""}`;
      const body = extra ? `${content.trim()}\n\n### Context\n${extra}` : content.trim();
      return `${header}${body}`;
    } catch (err) {
      return `ERROR reading skill "${match.name}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
