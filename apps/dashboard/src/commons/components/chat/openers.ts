/**
 * The openers of a fresh chat: who the agent is, two kinds of work drawn from the skills it has, and how a chat app is
 * connected. A press puts one in the message box and sends nothing, so one that ends at a colon is for the person to
 * finish, with their own writing pasted in or their own subject named.
 *
 * Each kind of work is the skill's own, and offered only by an agent that carries the skill and whose machine has
 * what it needs, so an opener is never a promise the agent cannot keep. Which two is drawn per chat (`seed`), so a
 * person meets the others over a few chats. Most wanted first: a carousel and a mockup were the two fixed ones.
 *
 * Every one is at most 39 characters, the mockup's: "How do I connect Telegram, Discord or WhatsApp?" was 328 px at an
 * opener's size, where an opener has 303 in the floating panel and 281 on a small phone, and a second line is 20 px
 * the panel does not have.
 *
 * In English, deliberately: a default in the interface language, translated properly if this ever grows one.
 */

/** By skill, the work it does as a person would ask for it. */
export const SKILL_OPENERS: readonly (readonly [skill: string, opener: string])[] = [
  ["carousel", "Make a carousel from this writing: "],
  ["mockup-design", "Design a mockup of a landing page for: "],
  ["diagrams", "Draw a diagram of how this works: "],
  ["slides", "Make a slide deck about: "],
  ["document-authoring", "Write this up as a PDF report: "],
  ["data-sheets", "Chart the numbers in this sheet: "],
  ["motion-graphics", "Make a short animated intro for: "],
  ["research", "Research this, with sources: "],
  ["nouclip", "Summarize this video: "],
];

/** What the agent carries, as `GET /agents/:id/skills` says it: the skills it uses, and what each lacks on this machine. */
export interface CarriedSkill {
  name: string;
  enabled: boolean;
  offGlobally?: boolean;
  missing: string[];
}

/** The openers for `agentName`, two of its work drawn from `skills` from `seed` on. None of work when it has none. */
export function openers(agentName: string, skills: readonly CarriedSkill[], seed: number): string[] {
  const usable = new Set(skills.filter((skill) => skill.enabled && !skill.offGlobally && skill.missing.length === 0).map((skill) => skill.name));
  const work = SKILL_OPENERS.filter(([skill]) => usable.has(skill)).map(([, opener]) => opener);
  const start = work.length === 0 ? 0 : Math.abs(Math.trunc(seed)) % work.length;
  const drawn = [...work.slice(start), ...work.slice(0, start)].slice(0, 2);
  return [`Hi ${agentName}, introduce yourself and tell me what you can do.`, ...drawn, "Connect Telegram, Discord or WhatsApp?"];
}
