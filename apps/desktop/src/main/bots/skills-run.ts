import { discoverSkills, type SkillDefinition } from "@deyin/agent-core";

/** Where a skill a Bot learned comes from, as the agent lists it. */
export const BOT_SKILL_SOURCE = "bot";

/**
 * A Bot's own skills added to what a run can use. They go first, so a Bot's skill wins over a shared one of the
 * same name: what a Bot was taught is what it follows. A folder that is missing or holds nothing adds nothing.
 */
export async function withBotSkills<T extends { skills: SkillDefinition[] }>(caps: T, root: string | undefined): Promise<T> {
  if (!root) return caps;
  const own = await discoverSkills([{ dir: root, source: BOT_SKILL_SOURCE }]);
  if (own.length === 0) return caps;
  const names = new Set(own.map((skill) => skill.name));
  return { ...caps, skills: [...own, ...caps.skills.filter((skill) => !names.has(skill.name))] };
}
