/**
 * `lint:domains` checks itself: which imports are links between the engine's domains, the table from both sides, and
 * the whole check over this tree with a recorded link taken away.
 *
 * Nothing held the imports between `modules/` folders, and 134 links had grown, 24 of them both ways. A check that read
 * no import would pass for ever, so each spelling of one is planted here rather than trusted from the tree's clean run.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkDomains, domainLinks, linkFindings } from "../../../../scripts/check-domains.ts";
import { LINKS_ADDED, LINKS_AT_START } from "../../../../scripts/domain-links.ts";

const ROOT = join(import.meta.dir, "../../../..");
const FILE = "apps/engine/src/modules/cron/sub/planted.ts";

/** The domains `text`, planted in `cron`, reaches. */
const reaches = (text: string) => domainLinks(FILE, text).map((link) => link.to);

describe("this tree", () => {
  test("holds: every link between domains is recorded, and every recorded one is made", async () => {
    const { findings, links } = await checkDomains(ROOT);
    expect(findings).toEqual([]);
    expect(links).toBe(Object.values(LINKS_AT_START).flat().length + Object.keys(LINKS_ADDED).length);
  });

  test("and the lint says so the way lint:check runs it", () => {
    const run = spawnSync("bun", ["run", "scripts/check-domains.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("links between the engine's domains, every one recorded");
    expect(run.status).toBe(0);
  }, 60_000);
});

describe("the whole check refuses", () => {
  test("a link nobody recorded, at each import that makes it, with what to do", async () => {
    const { cron, ...rest } = LINKS_AT_START;
    const { findings } = await checkDomains(ROOT, { ...rest, cron: cron!.filter((to) => to !== "missions") });
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding).toMatchObject({ rule: "domain-link-new" });
      expect(finding.file).toStartWith("apps/engine/src/modules/cron/");
      expect(finding.line).toBeGreaterThan(0);
      expect(finding.detail).toContain("`cron` importing `missions` is a link the domains did not have");
      expect(finding.detail).toContain('add "cron → missions" to `LINKS_ADDED`');
    }
  });

  test("and passes it once it is added with its reason", async () => {
    const { cron, ...rest } = LINKS_AT_START;
    const added = { "cron → missions": "planted: the reason cron needs missions" };
    expect((await checkDomains(ROOT, { ...rest, cron: cron!.filter((to) => to !== "missions") }, added)).findings).toEqual([]);
  });
});

describe("what is a link", () => {
  test("an import of another domain, by the alias or by a path that climbs into its folder", () => {
    expect(reaches(`import { a } from "@/modules/missions/missions.ts";`)).toEqual(["missions"]);
    expect(reaches(`import { a } from "../../tools/registry.ts";`)).toEqual(["tools"]);
    expect(reaches(`import { a } from "@/modules/memory";`)).toEqual(["memory"]);
  });

  test("every spelling: a type, a re-export, a side effect, a dynamic import, one over several lines", () => {
    const text = [
      `import type { A } from "@/modules/llm/types.ts";`,
      `export { b } from "@/modules/people/index.ts";`,
      `import "@/modules/hooks/register.ts";`,
      `const c = await import("@/modules/turns/turns.store.ts");`,
      `import {\n  d,\n  e,\n} from "@/modules/notes/notes.ts";`,
    ].join("\n");
    expect(domainLinks(FILE, text).map(({ to, line }) => ({ to, line }))).toEqual([
      { to: "llm", line: 1 },
      { to: "people", line: 2 },
      { to: "hooks", line: 3 },
      { to: "turns", line: 4 },
      { to: "notes", line: 8 },
    ]);
  });

  test("not its own domain, nor a folder outside the domains, nor a package, nor a comment or a string", () => {
    const text = [
      `import { a } from "@/modules/cron/cron.store.ts";`,
      `import { b } from "../validate.ts";`,
      `import { c } from "@/commons/clock.ts";`,
      `import { d } from "@/boot/stores.ts";`,
      `import { e } from "../../../commons/text.ts";`,
      `import { f } from "@nouride/shared";`,
      `// import { g } from "@/modules/tools/registry.ts";`,
      `const h = 'import { i } from "@/modules/web/index.ts"';`,
    ].join("\n");
    expect(reaches(text)).toEqual([]);
  });
});

describe("the table, both ways", () => {
  const found = (links: { to: string; line: number }[]) => new Map([[FILE, links.map((link) => ({ ...link, specifier: `@/modules/${link.to}` }))]]);

  test("a link made and recorded passes; one made and not recorded is refused", () => {
    expect(linkFindings(found([{ to: "tools", line: 3 }]), { cron: ["tools"] }, {})).toEqual([]);
    expect(linkFindings(found([{ to: "web", line: 3 }]), { cron: ["web"] }, {})).toEqual([]);
    const [refused] = linkFindings(found([{ to: "web", line: 3 }]), {}, {});
    expect(refused).toMatchObject({ file: FILE, line: 3, rule: "domain-link-new" });
  });

  test("a recorded link nothing makes any more is refused, so it leaves the list", () => {
    expect(linkFindings(found([]), { cron: ["tools"] }, {}).map(({ rule, detail }) => ({ rule, detail }))).toEqual([
      { rule: "domain-link-gone", detail: expect.stringContaining('"cron → tools" is recorded and nothing makes it any more') },
    ]);
    expect(linkFindings(found([]), {}, { "cron → tools": "planted" }).map(({ rule }) => rule)).toEqual(["domain-link-gone"]);
  });

  test("an added link carries its reason, at most 200 characters", () => {
    const made = found([{ to: "tools", line: 3 }]);
    expect(linkFindings(made, {}, { "cron → tools": "x".repeat(200) })).toEqual([]);
    expect(linkFindings(made, {}, { "cron → tools": "x".repeat(201) }).map(({ rule }) => rule)).toEqual(["domain-link-why"]);
    expect(linkFindings(made, {}, { "cron → tools": " " }).map(({ rule }) => rule)).toEqual(["domain-link-why"]);
  });
});
