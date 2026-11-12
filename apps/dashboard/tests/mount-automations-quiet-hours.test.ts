/**
 * The quiet hours on the Automations page (`automations/components/QuietHours.tsx`): one setting for every automation
 * on the server, read by anyone while hours are set and set by an admin. Through the whole app.
 *
 * Each case is a way the page would say or do something else than the server does: hours shown that are not in force,
 * a save sent as other times or as half of them, a refusal swallowed, the setting offered to someone the server
 * refuses, or a line of hours read against the wrong clock.
 */

import { describe, expect, test } from "bun:test";
import { otherClock } from "@/modules/automations/lib/watch";
import { answer, recordPosts, renderPage, type, useMountHarness, WIRE, type MountedApp } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations";
const HOURS = "/policy/quiet-hours";
const ok = (body: unknown) => ({ status: 200, body });
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const signedIn = (role: string) => ({ "/auth/me": ok({ ...ME, role, user: { ...ME.user, role } }) });
/** This machine's own zone, and one whose clock reads another time wherever the suite runs. */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const FAR = otherClock("Pacific/Kiritimati") ? "Pacific/Kiritimati" : "Pacific/Pago_Pago";
const policy = (more: Record<string, unknown> = {}) => ({ [HOURS]: ok({ timeZone: HERE, editable: true, ...more }) });
const AT_NIGHT = { from: "22:00", to: "07:00" };

const control = (host: HTMLElement) => host.querySelector<HTMLElement>('main section[aria-label="Quiet hours"]');
const line = (host: HTMLElement) => control(host)?.querySelector("[data-quiet-hours]")?.textContent ?? null;
const offered = (host: HTMLElement) => [...(control(host)?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim() ?? "");
const button = (host: HTMLElement, label: string) => [...(control(host)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((one) => one.textContent?.trim() === label);
const times = (host: HTMLElement) => [...(control(host)?.querySelectorAll<HTMLInputElement>('input[type="time"]') ?? [])];
const rows = (host: HTMLElement) => host.querySelectorAll("[data-automation]").length;
/** The page drawn, and the hours answered one way or the other: what is not on the page then was not left out by a wait. */
async function settled(host: HTMLElement, app: MountedApp): Promise<void> {
  await eventually(() => rows(host) > 0, 3_000, "the rows");
  await eventually(() => ["success", "error"].includes(app.queryClient.getQueryState(["quiet-hours"])?.status ?? ""), 3_000, "the hours answered");
}
/** The two fields opened by the line's button. */
async function open(host: HTMLElement, label: string): Promise<void> {
  button(host, label)!.click();
  await eventually(() => times(host).length === 2, 2_000, "the two times");
}

describe("the quiet hours, as an admin", () => {
  test("with none set the line says so and offers to set them; the two times are not on the page until asked for", async () => {
    answer(policy());
    const seen = { line: "" as string | null, offered: [] as string[], fields: -1, opened: [] as string[], labels: [] as string[], says: "" };
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.line = line(host);
      seen.offered = offered(host);
      seen.fields = times(host).length;
      await open(host, "Set");
      seen.opened = times(host).map((field) => field.value);
      seen.labels = [...control(host)!.querySelectorAll("label > span")].map((label) => label.textContent ?? "");
      seen.says = control(host)!.textContent ?? "";
    });
    expect(seen).toMatchObject({ line: "Quiet hours are not set.", offered: ["Set"], fields: 0, opened: ["", ""], labels: ["From", "To"] });
    expect(seen.says).toContain("No quiet hours: automations tell their chats at any hour.");
  });

  test("with hours set the line says them, and Change opens the two times it holds", async () => {
    answer(policy(AT_NIGHT));
    const seen = { line: "" as string | null, offered: [] as string[], opened: [] as string[], save: false, says: "" };
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.line = line(host);
      seen.offered = offered(host);
      await open(host, "Change");
      seen.opened = times(host).map((field) => field.value);
      // Nothing changed yet: nothing to save.
      seen.save = button(host, "Save")!.disabled;
      seen.says = control(host)!.textContent ?? "";
    });
    expect(seen).toMatchObject({ line: "Quiet hours: 22:00 to 07:00", offered: ["Change"], opened: ["22:00", "07:00"], save: true });
    expect(seen.says).toContain("Between these times, in this server's time, what automations would say to a chat is kept, and sent as one message when they end.");
  });

  test("two times typed are sent as they are, and the line then says what the server answered is in force", async () => {
    answer(policy(AT_NIGHT));
    const posted = recordPosts({ [HOURS]: ok({ ok: true, from: "23:00", to: "06:30", timeZone: HERE, editable: true }) });
    const seen = { line: "" as string | null, fields: -1, said: "" };
    try {
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        await open(host, "Change");
        type(times(host)[0]!, "23:00");
        type(times(host)[1]!, "06:30");
        await eventually(() => button(host, "Save")?.disabled === false, 2_000, "Save offered");
        button(host, "Save")!.click();
        await eventually(() => line(host) === "Quiet hours: 23:00 to 06:30", 3_000, "the new hours");
        seen.line = line(host);
        seen.fields = times(host).length;
        seen.said = host.ownerDocument.body.textContent ?? "";
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts).toEqual([{ path: HOURS, body: { from: "23:00", to: "06:30" } }]);
    expect(seen).toMatchObject({ line: "Quiet hours: 23:00 to 06:30", fields: 0 });
    expect(seen.said).toContain("Applied");
    expect(seen.said).toContain("Quiet hours are 23:00 to 06:30");
  });

  test("Clear empties both, and saved so they are sent as none: the line says none are set", async () => {
    answer(policy(AT_NIGHT));
    const posted = recordPosts({ [HOURS]: ok({ ok: true, timeZone: HERE, editable: true }) });
    const seen = { cleared: [] as string[], says: "", line: "" as string | null, offered: [] as string[], said: "" };
    try {
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        await open(host, "Change");
        button(host, "Clear")!.click();
        await eventually(() => times(host).every((field) => field.value === ""), 2_000, "both empty");
        seen.cleared = times(host).map((field) => field.value);
        seen.says = control(host)!.textContent ?? "";
        button(host, "Save")!.click();
        await eventually(() => line(host) === "Quiet hours are not set.", 3_000, "none set");
        seen.line = line(host);
        seen.offered = offered(host);
        seen.said = host.ownerDocument.body.textContent ?? "";
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts).toEqual([{ path: HOURS, body: { from: null, to: null } }]);
    expect(seen).toMatchObject({ cleared: ["", ""], line: "Quiet hours are not set.", offered: ["Set"] });
    expect(seen.says).toContain("No quiet hours: automations tell their chats at any hour.");
    expect(seen.said).toContain("Quiet hours are off");
  });

  test("half of them, or the same time twice, is said and cannot be saved; Cancel sends nothing and leaves the line as it was", async () => {
    answer(policy(AT_NIGHT));
    const posted = recordPosts({ [HOURS]: ok({ ok: true, timeZone: HERE, editable: true }) });
    const seen = { half: "", halfSave: false, same: "", sameSave: false, line: "" as string | null, fields: -1 };
    try {
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        await open(host, "Change");
        const alert = () => control(host)!.querySelector('[role="alert"]')?.textContent ?? "";
        type(times(host)[1]!, "");
        await eventually(() => alert() !== "", 2_000, "what it lacks");
        seen.half = alert();
        seen.halfSave = button(host, "Save")!.disabled;
        type(times(host)[1]!, "22:00");
        await eventually(() => alert().includes("different"), 2_000, "the same twice");
        seen.same = alert();
        seen.sameSave = button(host, "Save")!.disabled;
        button(host, "Cancel")!.click();
        await eventually(() => times(host).length === 0, 2_000, "the fields closed");
        seen.line = line(host);
        seen.fields = times(host).length;
      });
    } finally {
      posted.restore();
    }
    expect(seen).toEqual({ half: "Set both times, or leave both empty for no quiet hours.", halfSave: true, same: "The two times must be different.", sameSave: true, line: "Quiet hours: 22:00 to 07:00", fields: 0 });
    expect(posted.posts).toEqual([]);
  });

  test("a save the server refuses is said under the control in its words, with what was typed kept and the line as it was", async () => {
    answer(policy(AT_NIGHT));
    const posted = recordPosts({ [HOURS]: { status: 400, body: { error: "the two times are the same", plain: "Nothing was saved. Check the two times: they must be different, and try again." } } });
    const seen = { alert: "", typed: [] as string[], line: "" as string | null, said: "" };
    try {
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        await open(host, "Change");
        type(times(host)[0]!, "21:00");
        await eventually(() => button(host, "Save")?.disabled === false, 2_000, "Save offered");
        button(host, "Save")!.click();
        await eventually(() => control(host)!.querySelector('[role="alert"]') !== null, 3_000, "the refusal");
        seen.alert = control(host)!.querySelector('[role="alert"]')?.textContent ?? "";
        seen.typed = times(host).map((field) => field.value);
        seen.line = line(host);
        seen.said = host.ownerDocument.body.textContent ?? "";
      });
    } finally {
      posted.restore();
    }
    expect(posted.posts).toEqual([{ path: HOURS, body: { from: "21:00", to: "07:00" } }]);
    expect(seen.alert).toContain("Nothing was saved. Check the two times: they must be different, and try again.");
    expect(seen).toMatchObject({ typed: ["21:00", "07:00"], line: "Quiet hours: 22:00 to 07:00" });
    expect(seen.said).not.toContain("Applied");
  });

  test("the line says whose clock the hours are in only where the server's reads another time, and never the zone's name", async () => {
    const seen: Record<string, { line: string | null; named: boolean }> = {};
    for (const [name, timeZone] of [["same", HERE], ["other", FAR]] as const) {
      answer(policy({ ...AT_NIGHT, timeZone }));
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        seen[name] = { line: line(host), named: host.querySelector("main")?.textContent?.includes(timeZone) === true };
      });
    }
    expect(seen).toEqual({ same: { line: "Quiet hours: 22:00 to 07:00", named: false }, other: { line: "Quiet hours: 22:00 to 07:00, in this server's time", named: false } });
  });

  test("where the server's settings cannot be changed from here, an admin reads the line and is offered nothing", async () => {
    answer(policy({ ...AT_NIGHT, editable: false }));
    const seen = { line: "" as string | null, offered: ["?"], none: true };
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.line = line(host);
      seen.offered = offered(host);
    });
    answer(policy({ editable: false }));
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.none = control(host) === null;
    });
    expect(seen).toEqual({ line: "Quiet hours: 22:00 to 07:00", offered: [], none: true });
  });

  test("it is the server's, not the list's: there with no automation to list, and holding none of the list's filters", async () => {
    answer({ ...policy(AT_NIGHT), "/automations": ok({ automations: [], timezone: "UTC" }) });
    const seen = { line: "" as string | null, filters: -1 };
    await renderPage(PAGE, async (host) => {
      await eventually(() => control(host) !== null, 3_000, "the hours");
      seen.line = line(host);
      seen.filters = control(host)!.querySelectorAll('input[type="search"], [aria-haspopup="listbox"]').length;
    });
    expect(seen).toEqual({ line: "Quiet hours: 22:00 to 07:00", filters: 0 });
  });

  test("a server that does not know the setting leaves the page as it was, with nothing said of hours", async () => {
    answer({ [HOURS]: { status: 404, body: { error: "not found" } } });
    const seen = { control: true, rows: 0 };
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.control = control(host) !== null;
      seen.rows = rows(host);
    });
    expect(seen.control).toBe(false);
    expect(seen.rows).toBeGreaterThan(0);
  });
});

describe("what the quiet hours keep now", () => {
  const kept = (host: HTMLElement) => control(host)?.querySelector("[data-quiet-kept]")?.textContent ?? null;

  test("is said after the hours, with when they end: how many, as the server counted them for whoever reads", async () => {
    answer(policy({ ...AT_NIGHT, kept: { count: 3, until: Date.now() + 3_600_000 } }));
    const seen = { kept: "" as string | null, line: "" as string | null };
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      seen.kept = kept(host);
      seen.line = line(host);
    });
    expect(seen).toEqual({ kept: "3 messages kept until 07:00", line: "Quiet hours: 22:00 to 07:00" });
  });

  test("one is one message; nothing kept is nothing said, and so is a count with no hours to end", async () => {
    answer(policy({ ...AT_NIGHT, kept: { count: 1, until: Date.now() + 3_600_000 } }));
    let one: string | null = "";
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      one = kept(host);
    });
    expect(one).toBe("1 message kept until 07:00");

    for (const answered of [policy(AT_NIGHT), policy({ ...AT_NIGHT, kept: { count: 0, until: 0 } }), policy({ kept: { count: 2, until: 0 } })]) {
      answer(answered);
      let none: string | null = "";
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        none = kept(host);
      });
      expect(none).toBeNull();
    }
  });

  test("someone who is not an admin reads it too: it is why their automation's words have not come", async () => {
    answer({ ...signedIn("operator"), ...policy({ ...AT_NIGHT, kept: { count: 2, until: Date.now() + 3_600_000 } }) });
    let said: string | null = "";
    await renderPage(PAGE, async (host, app) => {
      await settled(host, app);
      said = kept(host);
    });
    expect(said).toBe("2 messages kept until 07:00");
  });
});

describe("the quiet hours, as someone who is not an admin", () => {
  test("hours that are set are read in a line, with no way to change them; none set is nothing on the page", async () => {
    const seen: Record<string, { line: string | null; offered: string[]; fields: number; none: boolean }> = {};
    for (const role of ["operator", "viewer"]) {
      answer({ ...signedIn(role), ...policy(AT_NIGHT) });
      const one = { line: null as string | null, offered: ["?"], fields: -1, none: false };
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        one.line = line(host);
        one.offered = offered(host);
        one.fields = times(host).length;
      });
      answer({ ...signedIn(role), ...policy() });
      await renderPage(PAGE, async (host, app) => {
        await settled(host, app);
        one.none = control(host) === null;
      });
      seen[role] = one;
    }
    const read = { line: "Quiet hours: 22:00 to 07:00", offered: [], fields: 0, none: true };
    expect(seen).toEqual({ operator: read, viewer: read });
  });
});
