/**
 * A command's answer as each chat app is handed it: Discord the text as written, WhatsApp its own marks, Telegram HTML.
 *
 * The lists were laid out to be read (a title, entries of three short lines, a blank line between) and looked at in a
 * Telegram chat only. The layout is the lines and the blank ones, and each platform's formatter is free to lose them:
 * so the answers the commands really write go through the formatters the adapters really use, and a list is the same
 * list in all three. `/help` is the long one: a few characters short of Discord's limit, and cut in two there once
 * a command more is added.
 */

import { describe, expect, test } from "bun:test";
import { backgroundSaid, type WorkingInBackground } from "@/modules/hooks/builtins/helpers.ts";
import { helpSaid } from "@/modules/hooks/builtins/meta.ts";
import { missionsSaid } from "@/modules/hooks/builtins/mission.ts";
import { HookRegistry } from "@/modules/hooks/registry.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { toTelegramHtml } from "../../../../packages/gateways/src/channels/telegram/html.ts";
import { toWhatsAppText } from "../../../../packages/gateways/src/channels/whatsapp/format.ts";
import { parseMarkdown } from "../../../../packages/gateways/src/commons/markdown.ts";
import { chunk } from "../../../../packages/gateways/src/commons/text.ts";

const DISCORD_LIMIT = 2000;
const NOW = 1_800_000_000_000;

const working = (more: Partial<WorkingInBackground>): WorkingInBackground => ({ id: "job_d8f5a1", kind: "command", asked: null, service: false, what: "sleep 60", gatewayId: "discord:nouva", chatId: "room", senderId: "u1", startedAt: NOW - 9_000, lastWroteAt: null, ...more });
const atWork = [
  working({}),
  working({ id: "job_22", kind: "helper", what: "Read the shop's logs and say what failed", startedAt: NOW - 130_000, lastWroteAt: NOW - 20_000 }),
  working({ id: "job_33", kind: "ask", asked: "nix", what: "Deploy the shop", chatId: "elsewhere", startedAt: NOW - 3_700_000, lastWroteAt: NOW - 60_000 }),
];
const listed = (which: "helpers" | "commands") => backgroundSaid({ which, agent: "Nouva", working: atWork, here: (one) => one.chatId === "room", nameOf: () => "Nix", now: NOW });

const mission = (more: Partial<Mission>): Mission =>
  ({ id: "msn_0001aaaaaaaaaaaaaaaa", title: "Move the shop", agentId: "nouva", status: "running", waitKind: null, startedAt: 1, createdAt: 1, gatewayId: "discord:nouva", chatId: "room", startedBy: "u1", answers: [], told: [], ...more }) as Mission;
const missions = missionsSaid([mission({}), mission({ id: "msn_0002bbbbbbbbbbbbbbbb", title: "Which bank?", status: "waiting", waitKind: "input", createdAt: 2 })], () => true);

const help = (agent: string) => helpSaid(agent, new HookRegistry({} as never).list());

const whatsapp = (text: string) => toWhatsAppText(parseMarkdown(text));
const telegram = (text: string) => toTelegramHtml(parseMarkdown(text));
/** A list's shape: how many lines each of its blocks holds, a blank line parting the blocks. */
const shape = (text: string) => text.split("\n\n").map((block) => block.split("\n").length);

describe("a list is the same list in every chat app", () => {
  const answers = { "/backgrounds": listed("commands"), "/helpers": listed("helpers"), "/mission": missions, "/help": help("Nouva") };

  test("as written: a title, entries of three lines, a blank line between, and what ends them", () => {
    expect(shape(answers["/backgrounds"])).toEqual([1, 3, 1, 1]);
    expect(shape(answers["/helpers"])).toEqual([1, 3, 3, 1, 1]);
    expect(shape(answers["/mission"])).toEqual([2, 2]);
    // Its title, then five groups, each a name and a command to a line.
    expect(shape(answers["/help"])).toEqual([1, 7, 10, 6, 5, 5]);
  });

  for (const [command, written] of Object.entries(answers)) {
    test(`${command}: WhatsApp and Telegram keep every line and every blank one`, () => {
      expect(shape(whatsapp(written))).toEqual(shape(written));
      expect(shape(telegram(written))).toEqual(shape(written));
    });
  }

  test("WhatsApp is given its own marks: one star for bold, the code as code, and no markdown left over", () => {
    const text = whatsapp(answers["/backgrounds"]);
    expect(text.split("\n\n").slice(0, 2)).toEqual(["*Running in the background for Nouva* (1)", "*1. A command* · 9s · no output yet\n`sleep 60`\n`job_d8f5a1`"]);
    expect(whatsapp(answers["/helpers"])).toContain("*1. Nix*, asked · 1h 1m · last step 1m ago · started in another chat\nDeploy the shop\n`job_33`");
    expect(whatsapp(answers["/mission"]).split("\n")[0]).toBe("*Needs you* (1)");
    for (const written of Object.values(answers)) expect(whatsapp(written)).not.toContain("**");
  });

  test("Telegram is given tags: the title and each entry's lead in bold, a command and a job as code", () => {
    const text = telegram(answers["/backgrounds"]);
    expect(text.split("\n\n").slice(0, 2)).toEqual(["<b>Running in the background for Nouva</b> (1)", "<b>1. A command</b> · 9s · no output yet\n<code>sleep 60</code>\n<code>job_d8f5a1</code>"]);
    expect(telegram(answers["/help"])).toContain("<b>Work it carries on</b>\n<code>/mission</code>: ");
    for (const written of Object.values(answers)) expect(telegram(written)).not.toMatch(/\*\*|`/);
  });
});

describe("/help on Discord, which takes 2,000 characters a message", () => {
  test("it is one message for an agent's name of ordinary length", () => {
    expect(chunk(help("Nouva"), DISCORD_LIMIT)).toHaveLength(1);
  });

  test("grown past the limit, it is cut between two groups: each part opens with a group's name, and no line is cut", () => {
    // What a command more does to it; a long name gets there without inventing one.
    const long = help("N".repeat(120));
    expect(long.length).toBeGreaterThan(DISCORD_LIMIT);
    const parts = chunk(long, DISCORD_LIMIT);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(DISCORD_LIMIT);
      expect(part.startsWith("**")).toBe(true);
    }
    // Nothing lost and nothing broken: the parts, put back with the blank line the cut took, are the list.
    expect(parts.join("\n\n")).toBe(long);
    const lines = new Set(long.split("\n"));
    for (const line of parts.flatMap((part) => part.split("\n"))) expect(lines.has(line)).toBe(true);
  });
});
