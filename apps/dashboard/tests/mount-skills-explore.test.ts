/**
 * Skills' Explore tab, drawn against the daemon's recorded answers: Nouverse's list of public skills before a word is
 * typed and after a search, and the public lists themselves when Nouverse's does not answer. Installing by a
 * repository's address stays above it.
 */

import { describe, expect, test } from "bun:test";
import { answer, errors, renderPage, useMountHarness } from "./mount-harness.ts";
import { sleep } from "./wait.ts";

useMountHarness();

describe("Skills Explore", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await sleep(10);
  };
  const clickText = async (host: HTMLElement, selector: string, text: string) => {
    const target = [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)) as HTMLElement | undefined;
    if (!target) throw new Error(`nothing matching ${selector} with "${text}"`);
    target.click();
    await settle();
  };

  const search = async (host: HTMLElement, words: string) => {
    await clickText(host, '[role="tab"]', "Explore");
    const input = host.querySelector('input[aria-label="Search skills"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, words);
    input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
    await settle();
    await clickText(host, 'button[type="submit"]', "Search");
  };

  test("the tab says what install means, opens on Nouverse's picks, and offers one search and a repository field", async () => {
    const html = await renderPage("/skills", (host) => clickText(host, '[role="tab"]', "Explore"));
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Find a skill");
    expect(html).toContain("nothing runs until you do");
    expect(html).toContain("Install from a repository or URL");
    // One list, as Connectors' Explore is: no hub to pick, and nothing of a hub's name over the search.
    expect(html).not.toContain("All hubs");
    expect(html).toContain("Nouverse's list of public skills");
    // Before a word is typed: Nouverse's own list, said as that, with which of it Nouverse picked.
    expect(html).toContain('data-explore-list="catalog"');
    expect(html).toContain("Nouverse's picks</p>");
    expect(html).toContain("Nouverse's picks first, from Nouverse's list of public skills, updated");
    expect(html).not.toContain("Most used on ClawHub");
    expect(html.match(/title="Picked by Nouverse"/g)).toHaveLength(1);
    // Installing by repository comes first: it is the one that needs no searching.
    expect(html.indexOf("Install from a repository or URL")).toBeLessThan(html.indexOf("Find a skill"));
  });

  test("a search lists Nouverse's matches with Install: what each is called, who made it, how much it is used, how many match", async () => {
    const html = await renderPage("/skills", (host) => search(host, "pdf"));
    expect(html).toContain("Matching “pdf”");
    expect(html).toContain("4,012 matches in Nouverse's list of public skills, updated");
    expect(html).toContain("github:anthropics/skills/skills/pdf");
    // A repository's skill has no installs to count: its repository's stars are said, never "0 installs".
    expect(html).toContain("51,234 stars");
    expect(html).not.toContain(">0 installs<");
    expect(html).toContain("492,992 installs");
    // ClawHub's is called what its maker called it, with its own name in the reference under it.
    expect(html).toContain(">self improving agent</span>");
    expect(html).toContain("by pskoett");
    expect(html).toMatch(/<\/svg> Install<\/button>/);
    expect(html).not.toContain("did not answer");
    // The page scrolls, not the list.
    expect(html).not.toMatch(/data-explore-hits[^>]*overflow-y-auto/);
  });

  test("when Nouverse's list does not answer, the public lists are shown as themselves, and the page says so", async () => {
    answer({
      "/skills/hub/popular": { status: 200, body: { hits: [{ ref: "clawhub:p/most-used", source: "clawhub", name: "most-used", description: "Used a lot", url: "https://clawhub.ai/p/most-used", installs: 9 }], from: "hubs" } },
      "/skills/hub/search": {
        status: 200,
        body: {
          hits: [{ ref: "skills.sh:anthropics/skills/pdf", source: "skills.sh", name: "pdf", description: "from anthropics/skills", url: "https://skills.sh/anthropics/skills/pdf", installs: 205751 }],
          errors: [{ source: "Nouverse's catalog", error: "service.nouverse.tech did not answer in time" }, { source: "clawhub", error: "HTTP 503 from clawhub.ai" }],
          from: "hubs",
          sources: ["skills.sh", "clawhub", "well-known", "github"],
        },
      },
    });
    const before = await renderPage("/skills", (host) => clickText(host, '[role="tab"]', "Explore"));
    expect(before).toContain("Most used on ClawHub");
    expect(before).toContain('data-explore-list="hubs"');
    expect(before).not.toContain("Nouverse's picks first");
    const html = await renderPage("/skills", (host) => search(host, "pdf"));
    expect(html).toContain("skills.sh:anthropics/skills/pdf");
    expect(html).toContain("205,751 installs");
    expect(html).toContain("Nouverse's catalog did not answer: service.nouverse.tech did not answer in time");
    expect(html).toContain("clawhub did not answer");
    // No count of a whole list: the public lists each answered a page.
    expect(html).not.toContain("matches in Nouverse's list");
  });
});
