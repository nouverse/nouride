/**
 * Whose an automation is, handed over on the automation's own page (`automations/components/WhoseItIs.tsx`), from the
 * menu at its head. Through the whole app.
 *
 * An automation made from the command line, or from before automations were a person's, is nobody's: only an admin
 * sees it, and this is where one gives it to a person. Its own person hands theirs to somebody else, asked first.
 * Each case is a way the page would say or do something else than the server does: the wrong person shown, a
 * hand-over sent as another, one not shown once made, a refusal swallowed, or a choice offered that the server
 * refuses.
 */

import { describe, expect, test } from "bun:test";
import { answer, dom, dropdown, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { automation, detail, flowDrawn, labelled, ok, openWhose } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const LABEL = "Whose it is";
const PAGE = "/automations/cron_e";
const OWNER = "/cron/cron_e/owner";
const SAM = { key: "sam", name: "Kak Sam" };
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const PEOPLE = WIRE["/people"] as { people: { key: string; name: string; ids?: string[] }[] };
const card = (host: HTMLElement) => host.querySelector<HTMLElement>('main section[aria-label="Whose it is"]');
const toasts = (host: HTMLElement) => host.ownerDocument.body.textContent ?? "";

describe("an automation's page, as an admin", () => {
  test("one that is nobody's says so, and offers Nobody and each person in People by name", async () => {
    answer({ [PAGE]: detail(automation()) });
    const seen = { before: true, holds: "" as string | null, options: [] as string[], hint: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      // Not on the page until it is asked for: it was a card every admin scrolled past.
      seen.before = card(host) !== null;
      await openWhose(host);
      const pick = dropdown(card(host)!, LABEL);
      seen.holds = pick.holds();
      seen.hint = card(host)!.textContent ?? "";
      seen.options = await pick.open();
    });
    expect(seen.before).toBe(false);
    expect(seen.holds).toBe("Nobody");
    expect(seen.options).toEqual(["Nobody", "Gading", "Kak Sam", "Raka"]);
    expect(seen.hint).toContain("Only an admin can change it. Pick a person to make it theirs.");
  });

  test("a person picked is sent by their key, the page is read again and shows them, and says what was done", async () => {
    answer({ [PAGE]: detail(automation()) });
    const posted = recordPosts({ [OWNER]: ok({ job: automation({ person: SAM }) }) });
    const seen = { hint: "", said: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await openWhose(host);
        // What the daemon says of it once it is handed over.
        answer({ [PAGE]: detail(automation({ person: SAM })) });
        await dropdown(card(host)!, LABEL).pick("Kak Sam");
        await eventually(() => dropdown(card(host)!, LABEL).holds() === "Kak Sam", 4_000, "the page showing her");
        seen.hint = card(host)!.textContent ?? "";
        seen.said = toasts(host);
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts).toEqual([{ path: OWNER, body: { person: "sam" } }]);
    expect(seen.hint).toContain("Kak Sam finds it on their own list and can change it, as an admin can.");
    expect(seen.said).toContain("Applied");
    expect(seen.said).toContain("Shop check is Kak Sam's now");
  });

  test("back to nobody is sent as nobody, and the same choice picked again sends nothing", async () => {
    answer({ [PAGE]: detail(automation({ person: SAM })) });
    const posted = recordPosts({ [OWNER]: ok({ job: automation() }) });
    let said = "";
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await openWhose(host);
        const pick = dropdown(card(host)!, LABEL);
        await pick.pick("Kak Sam");
        answer({ [PAGE]: detail(automation()) });
        await pick.pick("Nobody");
        await eventually(() => dropdown(card(host)!, LABEL).holds() === "Nobody", 4_000, "the page showing nobody");
        said = toasts(host);
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts).toEqual([{ path: OWNER, body: { person: null } }]);
    expect(said).toContain("Shop check is nobody's now");
  });

  test("a hand-over the server refuses is said in its words under the choice, and the page keeps what it showed", async () => {
    answer({ [PAGE]: detail(automation()) });
    const posted = recordPosts({ [OWNER]: { status: 400, body: { error: "Kak Sam has no account or chat id in People to hold it by", plain: "Nothing was changed. Reload the page, and try again." } } });
    const seen = { text: "", holds: "" as string | null, said: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await openWhose(host);
        await dropdown(card(host)!, LABEL).pick("Kak Sam");
        await eventually(() => card(host)!.querySelector('[role="alert"]') !== null, 4_000, "the refusal");
        seen.text = card(host)!.querySelector('[role="alert"]')?.textContent ?? "";
        seen.holds = dropdown(card(host)!, LABEL).holds();
        seen.said = toasts(host);
      });
    } finally {
      posted.restore();
    }
    expect(seen.text).toContain("Nothing was changed. Reload the page, and try again.");
    // The server's own words, for whoever runs it.
    expect(seen.text).toContain("Kak Sam has no account or chat id in People to hold it by");
    expect(seen.holds).toBe("Nobody");
    expect(seen.said).not.toContain("Applied");
  });

  test("someone in People with no account and no chat address is not offered, and the card says who and why", async () => {
    answer({ [PAGE]: detail(automation()), "/people": ok({ people: [...PEOPLE.people, { key: "budi", name: "Budi" }, { key: "ani", name: "Ani", ids: [] }] }) });
    const seen = { options: [] as string[], text: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await openWhose(host);
      await eventually(() => card(host)!.textContent?.includes("Not listed") === true, 3_000, "who is left out");
      seen.text = card(host)!.textContent ?? "";
      seen.options = await dropdown(card(host)!, LABEL).open();
    });
    expect(seen.options).toEqual(["Nobody", "Gading", "Kak Sam", "Raka"]);
    expect(seen.text).toContain("Not listed: Budi, Ani. Each has no account or chat address in People yet.");

    // With everyone reachable the card says nothing of it.
    answer({ [PAGE]: detail(automation()) });
    let plain = "";
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await openWhose(host);
      await eventually(() => dropdown(card(host)!, LABEL).button() !== undefined, 3_000, "the choice");
      plain = card(host)!.textContent ?? "";
    });
    expect(plain).not.toContain("Not listed");
  });

  test("its person is shown from the first paint, before People has answered", async () => {
    answer({ [PAGE]: detail(automation({ person: SAM })), "/people": { status: 200, body: {}, hold: true } });
    let holds = "" as string | null;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await openWhose(host);
      holds = dropdown(card(host)!, LABEL).holds();
    });
    expect(holds).toBe("Kak Sam");
  });

  test("one an agent proposed has no such choice: it is theirs who turns it on; and the page that makes a new one has none", async () => {
    answer({ [PAGE]: detail(automation({ enabled: false, proposal: { by: "nouva", at: 1 } })) });
    const seen = { proposed: true, fresh: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.proposed = host.querySelector('[aria-label^="More for"]') !== null || card(host) !== null;
    });
    await renderPage("/automations/new", async (host) => {
      await eventually(() => host.querySelector('main [aria-label="Start"]') !== null, 3_000, "the new automation");
      seen.fresh = host.querySelector('[aria-label^="More for"]') !== null || card(host) !== null;
    });
    expect(seen).toEqual({ proposed: false, fresh: false });
  });
});

const AS = (role: string) => ({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }) });
const GADING = { key: "gading", name: "Gading" };
const asked = () => dom.document.body.querySelector("dialog[open]");
const answerWith = (label: string) => [...(asked()?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === label)!.click();

describe("an automation's page, as its own person who is not an admin", () => {
  test("their own is theirs to hand to somebody else and never to nobody: asked first, sent by the key, and the page is left", async () => {
    answer({ ...AS("operator"), [PAGE]: detail(automation({ person: GADING, changeable: true })) });
    const posted = recordPosts({ [OWNER]: ok({ job: automation({ person: SAM, changeable: false }) }) });
    const seen = { holds: "" as string | null, options: [] as string[], hint: "", question: "", afterNo: 0, at: "", said: "" };
    try {
      await renderPage(PAGE, async (host, app) => {
        await flowDrawn(host);
        await openWhose(host);
        const pick = dropdown(card(host)!, LABEL);
        seen.holds = pick.holds();
        seen.hint = card(host)!.textContent ?? "";
        seen.options = await pick.open();
        await pick.pick("Kak Sam");
        await eventually(() => asked() !== null, 2_000, "the question");
        seen.question = asked()?.textContent ?? "";
        // No is no: nothing is sent, and it is still theirs.
        answerWith("Cancel");
        await eventually(() => asked() === null, 2_000, "the question closed");
        seen.afterNo = posted.posts.length;
        await dropdown(card(host)!, LABEL).pick("Kak Sam");
        await eventually(() => asked() !== null, 2_000, "the question again");
        answerWith("Hand it over");
        await eventually(() => app.location() === "/automations", 4_000, "the list");
        seen.at = app.location();
        seen.said = toasts(host);
      });
    } finally {
      posted.restore();
    }
    expect(seen.holds).toBe("Gading");
    expect(seen.options).toEqual(["Gading", "Kak Sam", "Raka"]);
    expect(seen.hint).toContain("It is yours. Pick somebody else to hand it over: it is then theirs to change, and no longer yours.");
    expect(seen.question).toContain('Hand "Shop check" to Kak Sam?');
    expect(seen.question).toContain("It becomes Kak Sam's to change, and is no longer yours.");
    expect(seen.afterNo).toBe(0);
    expect(posted.posts).toEqual([{ path: OWNER, body: { person: "sam" } }]);
    expect(seen.at).toBe("/automations");
    expect(seen.said).toContain("Shop check is Kak Sam's now");
  });

  test("one kept under an account People does not name is shown as theirs, and a refusal is said in the server's words with the page kept", async () => {
    answer({ ...AS("operator"), [PAGE]: detail(automation({ changeable: true })) });
    const posted = recordPosts({ [OWNER]: { status: 403, body: { error: "only its owner or an admin hands an automation to somebody", plain: "Only the person it belongs to, or an admin, can hand this automation to somebody. Leaving it with nobody is an admin's." } } });
    const seen = { holds: "" as string | null, options: [] as string[], text: "", at: "" };
    try {
      await renderPage(PAGE, async (host, app) => {
        await flowDrawn(host);
        await openWhose(host);
        seen.holds = dropdown(card(host)!, LABEL).holds();
        seen.options = await dropdown(card(host)!, LABEL).open();
        await dropdown(card(host)!, LABEL).pick("Raka");
        await eventually(() => asked() !== null, 2_000, "the question");
        answerWith("Hand it over");
        await eventually(() => card(host)?.querySelector('[role="alert"]') != null, 4_000, "the refusal");
        seen.text = card(host)!.querySelector('[role="alert"]')?.textContent ?? "";
        seen.at = app.location();
      });
    } finally {
      posted.restore();
    }
    expect(seen.holds).toBe("You");
    expect(seen.options).toEqual(["You", "Gading", "Kak Sam", "Raka"]);
    expect(seen.text).toContain("Only the person it belongs to, or an admin, can hand this automation to somebody.");
    expect(seen.at).toBe("/automations/cron_e");
  });
});

describe("an automation's page, as someone who may not change it", () => {
  test("has no such choice: an account that only looks, and a reader of another person's; People is not asked for it", async () => {
    const calls: string[] = [];
    const harness = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(typeof input === "string" ? input : input instanceof URL ? input : input.url), "http://localhost");
      calls.push(pathname.replace(/^\/api\/control/, ""));
      return harness(input, init);
    }) as typeof fetch;
    const seen: Record<string, boolean> = {};
    try {
      for (const [who, role, changeable] of [["looks", "viewer", true], ["reads", "operator", false]] as const) {
        answer({ ...AS(role), [PAGE]: detail(automation({ person: SAM, changeable })) });
        await renderPage(PAGE, async (host) => {
          await flowDrawn(host);
          seen[who] = labelled(host, "More for Shop check") !== null || card(host) !== null;
        });
      }
    } finally {
      globalThis.fetch = harness;
    }
    expect(seen).toEqual({ looks: false, reads: false });
    expect(calls).toContain(PAGE);
    expect(calls).not.toContain("/people");
  });
});
