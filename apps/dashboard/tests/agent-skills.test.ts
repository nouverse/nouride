/**
 * An agent's Skills tab filters as the workshop does: forty rows were one long scroll, and finding one meant
 * reading every row. The filter reads a row's name, what it is for, where it comes from and what it still needs.
 */

import { describe, expect, test } from "bun:test";
import { agentSkillText } from "@/modules/agents/skills.page";
import type { AgentSkill } from "@nouride/wire";

const skill = (over: Partial<AgentSkill>): AgentSkill =>
  ({ name: "x", description: "", scope: "shared", enabled: true, offGlobally: false, toggleable: true, missing: [], ...over }) as AgentSkill;

describe("what an agent's skill filter reads", () => {
  test("the name, the description, where it comes from, and what the host is missing", () => {
    const text = agentSkillText(skill({ name: "motion-graphics", description: "Render a video", scope: "builtin", missing: ["ffmpeg"] })).join(" ").toLowerCase();
    for (const word of ["motion", "video", "built in", "ffmpeg"]) expect(text).toContain(word);
  });
});
