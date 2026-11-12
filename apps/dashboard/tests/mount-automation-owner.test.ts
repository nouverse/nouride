/**
 * Whose an automation is, handed over by an admin on the automation's own page (`automations/components/WhoseItIs.tsx`).
 * Through the whole app.
 *
 * An automation made from the command line, or from before automations were a person's, is nobody's: only an admin
 * sees it, and this is where one gives it to a person. Each case is a way the page would say or do something else
 * than the server does: the wrong person shown, a hand-over sent as another, one not shown once made, a refusal
 * swallowed, or the choice offered to someone the server refuses.
 */

import { describe, expect, test } from "bun:test";
import { answer, dropdown, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { automation, detail, flowDrawn, ok } from "./automation-fixtures.ts";
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
    const seen = { holds: "" as string | null, options: [] as string[], hint: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const pick = dropdown(card(host)!, LABEL);
      seen.holds = pick.holds();
      seen.hint = card(host)!.textContent ?? "";
      seen.options = await pick.open();
    });
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
      holds = dropdown(card(host)!, LABEL).holds();
    });
    expect(holds).toBe("Kak Sam");
  });

  test("one an agent proposed has no such choice: it is theirs who turns it on; and the page that makes a new one has none", async () => {
    answer({ [PAGE]: detail(automation({ enabled: false, proposal: { by: "nouva", at: 1 } })) });
    const seen = { proposed: true, fresh: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.proposed = card(host) !== null;
    });
    await renderPage("/automations/new", async (host) => {
      await eventually(() => host.querySelector('main [aria-label="Start"]') !== null, 3_000, "the new automation");
      seen.fresh = card(host) !== null;
    });
    expect(seen).toEqual({ proposed: false, fresh: false });
  });
});

describe("an automation's page, as someone who is not an admin", () => {
  test("has no such choice, on their own automation or any other, and People is not asked for it", async () => {
    const asked: string[] = [];
    const harness = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(typeof input === "string" ? input : input instanceof URL ? input : input.url), "http://localhost");
      asked.push(pathname.replace(/^\/api\/control/, ""));
      return harness(input, init);
    }) as typeof fetch;
    const seen: Record<string, boolean> = {};
    try {
      for (const role of ["operator", "viewer"]) {
        answer({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }), [PAGE]: detail(automation({ person: SAM, changeable: true })) });
        await renderPage(PAGE, async (host) => {
          await flowDrawn(host);
          seen[role] = card(host) !== null;
        });
      }
    } finally {
      globalThis.fetch = harness;
    }
    expect(seen).toEqual({ operator: false, viewer: false });
    expect(asked).toContain(PAGE);
    expect(asked).not.toContain("/people");
  });
});
