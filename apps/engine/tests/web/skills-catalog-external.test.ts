/**
 * The Skills page's per-agent row for an agent a coding CLI answers (0.8.1): a skill that needs `exec` is one its CLI
 * runs with its own shell, not one it lacks. Counted against its Nouride toolset, every such skill was marked yellow —
 * "has this skill but not exec" — for Kuro, a Codex agent, on the live box. And (0.8.13) one needing a tool no coding
 * CLI is ever given is not "missing" it either: no pack edit clears that, so it is said apart — the yellow "!" on the
 * `nouride` skill for Kuro, Nix and Nox, which told the person to add a tool that could never be added.
 */

import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerSkillRoutes } from "@/modules/web/control/routes/skills.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-skills-external-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("an external agent's skill needing the shell or a file tool is not missing it; one no CLI is given is said apart", async () => {
  const agentsDir = join(root, "agents");
  for (const [name, needs] of [["deployment", "exec, read"], ["self-update", "exec, nouride"]] as const) {
    mkdirSync(join(agentsDir, "skills", name), { recursive: true });
    writeFileSync(join(agentsDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}.\nneeds_tools: ${needs}\n---\nDo it.\n`);
  }
  const agent = (id: string, external: boolean) => ({ config: { id, displayName: id, skills: {}, tools: { enabled: ["read", "nouride"] }, ...(external ? { external: { cli: "codex" } } : {}) } });
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role: "operator" });
    await next();
  });
  registerSkillRoutes(app as never, {
    ctx: { config: { daemon: { agentsDir }, skills: { off: [] } } },
    registry: { all: () => [agent("nouva", false), agent("kuro", true)] },
    audit: { skillReads: () => new Map() },
  } as never);
  const { skills } = (await (await app.request("/skills/catalog")).json()) as { skills: { name: string; agents: { id: string; missingTools: string[]; notForCli?: string[] }[] }[] };
  const row = (skill: string, id: string) => skills.find((entry) => entry.name === skill)!.agents.find((entry) => entry.id === id)!;
  expect(row("deployment", "nouva").missingTools).toEqual(["exec"]);
  expect(row("deployment", "kuro").missingTools).toEqual([]);
  // `nouride` is not a CLI's own, nor lent: not a gap a pack edit fills for Kuro, but a skill that is not its.
  expect(row("self-update", "kuro")).toMatchObject({ missingTools: [], notForCli: ["nouride"] });
  // For an agent Nouride runs itself, a tool it holds is just held — and one it lacks, missing as before.
  expect(row("self-update", "nouva")).toEqual(expect.objectContaining({ missingTools: ["exec"] }));
  expect(row("self-update", "nouva").notForCli).toBeUndefined();
});
