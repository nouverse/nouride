/**
 * Dashboard links (0.8.11, `web/links.ts`): one builder for every page, from `[dashboard] public_url` and none without
 * it; one rule for whether a chat gets one; and no preview card of the login page under a message that holds one. An
 * agent asked about a mission could not hand over its page, and six places built an address, each its own way.
 */

import { describe, expect, test } from "bun:test";
import type { Gateway, MessageEnvelope, OutboundMessage, Person } from "@nouride/shared";
import { Notifier } from "@/commons/notify.ts";
import { senderHasAccount, senderIsAdmin } from "@/modules/people/match.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import { Voice } from "@/modules/pipeline/voice.ts";
import { dashboardLink, holdsDashboardLink, linksFor, publicBase } from "@/modules/web/links.ts";

const BASE = "https://agents.example.com";
const SET = { publicUrl: BASE };

describe("a dashboard link", () => {
  test("none without `public_url` — empty or only spaces — never a `host:port` nobody reaches from a phone", () => {
    expect(dashboardLink({ publicUrl: "" }, { kind: "overview" })).toBeNull();
    expect(dashboardLink({ publicUrl: "   " }, { kind: "mission", id: "msn_1" })).toBeNull();
    expect(publicBase({ publicUrl: "  " })).toBe("");
  });

  test("one slash after the address, however it was written", () => {
    expect(dashboardLink({ publicUrl: ` ${BASE}// ` }, { kind: "mission", id: "msn_1" })).toBe(`${BASE}/dashboard/missions/msn_1`);
    expect(publicBase({ publicUrl: `${BASE}/` })).toBe(BASE);
  });

  test("each page, its ids encoded: a `/`, `?`, `#` or `&` in one never makes another path or another parameter", () => {
    expect(dashboardLink(SET, { kind: "mission", id: "a/b?c#d" })).toBe(`${BASE}/dashboard/missions/a%2Fb%3Fc%23d`);
    expect(dashboardLink(SET, { kind: "schedule" })).toBe(`${BASE}/dashboard/schedule`);
    expect(dashboardLink(SET, { kind: "schedule", job: "job_1&x=2" })).toBe(`${BASE}/dashboard/schedule?job=job_1%26x%3D2`);
    expect(dashboardLink(SET, { kind: "overview" })).toBe(`${BASE}/dashboard/`);
    expect(dashboardLink(SET, { kind: "agent-cli", agentId: "nix" })).toBe(`${BASE}/dashboard/agents/nix/cli`);
    expect(dashboardLink(SET, { kind: "mcp-install", name: "io.github.x/y z", agent: "nouva" })).toBe(`${BASE}/dashboard/mcp?install=io.github.x%2Fy%20z&agent=nouva`);
  });
});

describe("who gets one in a chat", () => {
  // 8142 holds a dashboard account; 555 holds none.
  const rule = (publicUrl: string, types: Record<string, string> = {}) =>
    linksFor({ dashboard: () => ({ publicUrl }), hasAccount: (who) => who.senderId === "8142", chatTypeOf: (_gatewayId, chatId) => types[chatId] });
  const page = { kind: "mission", id: "msn_1" } as const;
  const link = `${BASE}/dashboard/missions/msn_1`;
  const dm = (senderId: string) => ({ gatewayId: "telegram:nouva", chatId: senderId, senderId, chatType: "dm" });
  const room = (chatType: string) => ({ gatewayId: "telegram:nouva", chatId: "-100team", senderId: "555", chatType });

  test("in a DM, the person who holds a dashboard account; never one who holds none", () => {
    expect(rule(BASE)(dm("8142"), page)).toBe(link);
    expect(rule(BASE)(dm("555"), page)).toBeNull();
  });

  test("in a DM the daemon started a turn in — a job's run, a proposed mission — the chat's own person", () => {
    expect(rule(BASE)({ gatewayId: "telegram:nouva", chatId: "8142", senderId: "nouride:system", chatType: "dm" }, page)).toBe(link);
    expect(rule(BASE)({ gatewayId: "telegram:nouva", chatId: "555", senderId: "nouride:system", chatType: "dm" }, page)).toBeNull();
  });

  test("in a group or a channel, whoever is there", () => {
    expect(rule(BASE)(room("group"), page)).toBe(link);
    expect(rule(BASE)(room("channel"), page)).toBe(link);
  });

  test("a chat whose type the caller does not know — a mission's notice — is looked up in the chats seen", () => {
    const linkFor = rule(BASE, { "-100team": "group" });
    expect(linkFor({ gatewayId: "telegram:nouva", chatId: "-100team", senderId: "555" }, page)).toBe(link);
    expect(linkFor({ gatewayId: "telegram:nouva", chatId: "555", senderId: "555" }, page)).toBeNull();
  });

  test("without `public_url`, none anywhere", () => {
    expect(rule("")(dm("8142"), page)).toBeNull();
    expect(rule("")(room("group"), page)).toBeNull();
  });
});

describe("who holds a dashboard account, by People", () => {
  const people: Person[] = [
    { key: "gading", name: "Gading", ids: ["telegram:8142", "web:usr_admin"] },
    { key: "sam", name: "Sam", ids: ["telegram:777", "web:usr_member"] },
    { key: "mira", name: "Mira", ids: ["telegram:555"] },
    { key: "old", name: "Old", ids: ["telegram:999", "web:usr_gone"] },
  ];
  const roles: Record<string, string> = { usr_admin: "admin", usr_member: "member" };
  const roleOf = (id: string) => roles[id];
  const sender = (senderId: string) => ({ gatewayId: "telegram:nouva", senderId });

  test("any role counts, not only an admin's", () => {
    expect(senderHasAccount(people, sender("8142"), roleOf)).toBe(true);
    expect(senderHasAccount(people, sender("777"), roleOf)).toBe(true);
    expect(senderIsAdmin(people, sender("777"), roleOf)).toBe(false);
    expect(senderIsAdmin(people, sender("8142"), roleOf)).toBe(true);
  });

  test("none for a person without a `web:` id, one whose account was deleted, or a sender People does not know", () => {
    expect(senderHasAccount(people, sender("555"), roleOf)).toBe(false);
    expect(senderHasAccount(people, sender("999"), roleOf)).toBe(false);
    expect(senderHasAccount(people, sender("123"), roleOf)).toBe(false);
  });
});

function fakeGateway(id: string) {
  const sent: OutboundMessage[] = [];
  const gateway = {
    id,
    platform: "telegram",
    status: "connected",
    buttons: true,
    send: async (message: OutboundMessage) => (sent.push(message), ["1"]),
  } as unknown as Gateway;
  return { gateway, sent };
}

describe("no preview card of the login page", () => {
  const link = `${BASE}/dashboard/missions/msn_1`;

  test("a text holds a link when it holds the address and `/dashboard/`; nothing does without `public_url`", () => {
    expect(holdsDashboardLink(SET, `Page: ${link}`)).toBe(true);
    expect(holdsDashboardLink(SET, `See ${BASE}/blog/post`)).toBe(false);
    expect(holdsDashboardLink({ publicUrl: "" }, "the page is at /dashboard/missions/msn_1")).toBe(false);
  });

  test("the daemon's notices and asks that hold one go with the preview off; the rest as before", async () => {
    const { gateway, sent } = fakeGateway("telegram:nouva");
    const notifier = new Notifier({ gateways: new Map([[gateway.id, gateway]]), previewOff: (text) => holdsDashboardLink(SET, text) });
    const to = { gatewayId: "telegram:nouva", chatId: "8142" };
    await notifier.toChat(to, `✓ Mission msn_1 done\nPage: ${link}`);
    await notifier.toChat(to, "✓ Mission msn_1 done");
    await notifier.ask(to, () => `⏸ Mission msn_1 needs you\nPage: ${link}`, [{ label: "Accept", data: "m:a" }]);
    expect(sent.map((one) => one.suppressPreview)).toEqual([true, undefined, true]);
  });

  test("an agent's reply that holds one goes with the preview off; one without keeps its preview", async () => {
    const { gateway, sent } = fakeGateway("telegram:nouva");
    const voice = new Voice({ config: { gateways: [], dashboard: SET }, gateways: new Map([[gateway.id, gateway]]) } as unknown as PipelineDeps);
    const asked = { id: "msg_1", timestamp: 0, gateway: "telegram", gatewayId: "telegram:nouva", chatId: "8142", chatType: "dm", senderId: "8142", senderName: "Gading", text: "how is it going?" } as unknown as MessageEnvelope;
    await voice.reply(asked, `Halfway. Its page: ${link}`);
    await voice.reply(asked, "Halfway. See https://example.org/docs");
    expect(sent.map((one) => one.suppressPreview)).toEqual([true, undefined]);
  });
});
