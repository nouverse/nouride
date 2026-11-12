/**
 * `/groups` over HTTP — what the Groups page sends (0.7.24). An admin reads every group, anyone else the ones their
 * person spoke in (`whose.ts`); a rename is an admin's, as an edit on People is, and is audited.
 *
 * And who answers a message in a room that tags nobody: said with each room, and set by an admin, as the setting
 * `/mention` writes from the room. The page and the chat are two doors to one row, so what this door writes is what
 * the chat's reads, and a choice it cannot make it refuses in the page's words.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerGroupRoutes } from "@/modules/web/control/routes/groups.ts";

function app(role: "admin" | "operator" | "viewer", spoke: string[] = [], keeps = true) {
  const renamed: unknown[] = [];
  const audited: string[] = [];
  /** A room's own setting, as the store keeps it, by platform and chat; and every write, as it was asked. */
  const own = new Map<string, { requireMention: boolean; answerer?: string }>();
  const sets: unknown[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: `u-${role}`, username: role } });
    await next();
  });
  registerGroupRoutes(control as never, {
    pipeline: {
      knownRooms: () => [
        { gatewayId: "telegram:main", platform: "telegram", chatId: "-100", name: "Keluarga", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 },
        ...(role === "admin" ? [{ gatewayId: "web:dashboard", platform: "web", chatId: "web-1", name: "Planning", dashboard: true, agents: ["nouva"], people: [], lastActive: 1 }] : []),
      ],
      roomMention: (platform: string, chatId: string) => own.get(`${platform} ${chatId}`) ?? null,
      setRoomMention: (platform: string, chatId: string, choice: { requireMention: boolean; answerer?: string } | null, actor: string) => {
        if (!keeps) return false;
        sets.push({ platform, chatId, choice, actor });
        if (choice === null) own.delete(`${platform} ${chatId}`);
        else own.set(`${platform} ${chatId}`, choice);
        return true;
      },
      // As the router answers: nobody where a tag is needed, the agent named, else the orchestrator.
      untaggedAnswerer: (room: { gateway: string; chatId: string }) => {
        const kept = own.get(`${room.gateway} ${room.chatId}`);
        return kept?.requireMention ? null : (kept?.answerer ?? "nouva");
      },
      renameRoom: (gatewayId: string, chatId: string, title: string) =>
        title.length > 100
          ? { ok: false, reason: "a name is at most 100 characters", why: "long" }
          : (renamed.push({ gatewayId, chatId, title }), title ? { ok: true, name: title } : { ok: true, name: "Keluarga" }),
    },
    audit: { record: (row: { action: string }) => void audited.push(row.action) },
    registry: { enabled: () => ["nouva", "novelist"].map((id) => ({ config: { id } })) },
    ctx: { config: { people: [{ key: "mira", name: "Mira", ids: ["web:u-viewer", "telegram:77"] }] } },
    // Where Mira's accounts spoke, as the room log keeps it (`chatPlace`: the platform and the chat).
    roomMessages: { spokeIn: (ids: string[]) => new Set(ids.includes("telegram:77") ? spoke.map((chat) => `telegram\u0000${chat}`) : []) },
  } as never);
  const post = (path: string) => (body: unknown) => control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rename = post("/groups");
  const answer = post("/groups/mention");
  const said = async () => ((await (await control.request("/groups")).json()) as { groups: { name: string; mention?: unknown; untagged?: string }[] }).groups;
  return { control, renamed, audited, rename, answer, said, sets, own };
}

describe("/groups", () => {
  test("lists every group for an admin, and for anyone else the groups their person spoke in", async () => {
    const names = async (role: "admin" | "viewer", spoke: string[] = []) => {
      const response = await app(role, spoke).control.request("/groups");
      expect(response.status).toBe(200);
      return ((await response.json()) as { groups: { name: string }[] }).groups.map((group) => group.name);
    };
    expect(await names("admin")).toEqual(["Keluarga", "Planning"]);
    expect(await names("viewer")).toEqual([]);
    // From any of their person's accounts: Mira's Telegram spoke there, and her dashboard account reads it.
    expect(await names("viewer", ["-100"])).toEqual(["Keluarga"]);
  });

  test("a rename is an admin's, and audited", async () => {
    const admin = app("admin");
    const done = await admin.rename({ gatewayId: "telegram:main", chatId: "-100", title: "Arisan" });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, name: "Arisan" });
    expect(admin.renamed).toEqual([{ gatewayId: "telegram:main", chatId: "-100", title: "Arisan" }]);
    expect(admin.audited).toEqual(["room_renamed"]);

    for (const role of ["operator", "viewer"] as const) {
      const other = app(role);
      expect((await other.rename({ gatewayId: "telegram:main", chatId: "-100", title: "Arisan" })).status, role).toBe(403);
      expect(other.renamed, role).toEqual([]);
    }
  });

  test("an empty title clears; a missing one, or no room, is refused", async () => {
    const admin = app("admin");
    expect(await (await admin.rename({ gatewayId: "telegram:main", chatId: "-100", title: "" })).json()).toEqual({ ok: true, name: "Keluarga" });
    expect((await admin.rename({ gatewayId: "telegram:main", chatId: "-100" })).status).toBe(400);
    expect((await admin.rename({ chatId: "-100", title: "x" })).status).toBe(400);
  });

  test("a name too long is refused in the page's words, worded from why, beside the CLI's (0.8.20)", async () => {
    const refused = await app("admin").rename({ gatewayId: "telegram:main", chatId: "-100", title: "x".repeat(101) });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "a name is at most 100 characters", plain: "That name is too long. Try a shorter one." });
  });
});

describe("/groups/mention: who answers a message in a room that tags nobody", () => {
  const ROOM = { gatewayId: "telegram:main", chatId: "-100" };

  test("each room is listed with its own setting where it has one, and who answers there now", async () => {
    const admin = app("admin");
    // Nothing of its own: no setting said, and the router's answer.
    expect((await admin.said())[0]).toMatchObject({ name: "Keluarga", untagged: "nouva" });
    expect("mention" in (await admin.said())[0]!).toBe(false);
    admin.own.set("telegram -100", { requireMention: false, answerer: "novelist" });
    expect((await admin.said())[0]).toMatchObject({ mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" });
    // A tag needed: nobody answers, so nobody is named.
    admin.own.set("telegram -100", { requireMention: true });
    expect((await admin.said())[0]).toMatchObject({ mention: { requireTag: true } });
    expect("untagged" in (await admin.said())[0]!).toBe(false);
    // What `/mention off` left: no tag needed, nobody named, the orchestrator answering.
    admin.own.set("telegram -100", { requireMention: false });
    expect((await admin.said())[0]).toMatchObject({ mention: { requireTag: false }, untagged: "nouva" });
  });

  test("an agent, a tag needed and the default are each written as the chat's `/mention` writes them, by the platform and the chat", async () => {
    const admin = app("admin");
    const named = await admin.answer({ ...ROOM, mention: "agent", agent: "novelist" });
    expect(named.status).toBe(200);
    expect(await named.json()).toEqual({ ok: true, mention: { requireTag: false, answerer: "novelist" }, untagged: "novelist" });
    expect(await (await admin.answer({ ...ROOM, mention: "required" })).json()).toEqual({ ok: true, mention: { requireTag: true } });
    expect(await (await admin.answer({ ...ROOM, mention: "default" })).json()).toEqual({ ok: true, untagged: "nouva" });
    expect(admin.sets).toEqual([
      { platform: "telegram", chatId: "-100", choice: { requireMention: false, answerer: "novelist" }, actor: "admin" },
      { platform: "telegram", chatId: "-100", choice: { requireMention: true }, actor: "admin" },
      { platform: "telegram", chatId: "-100", choice: null, actor: "admin" },
    ]);
    expect(admin.audited).toEqual(["room_mention_set", "room_mention_set", "room_mention_set"]);
  });

  test("it is an admin's, as in the chat", async () => {
    for (const role of ["operator", "viewer"] as const) {
      const other = app(role);
      expect((await other.answer({ ...ROOM, mention: "required" })).status, role).toBe(403);
      expect(other.sets, role).toEqual([]);
    }
  });

  test("what cannot be chosen is refused, and nothing is written", async () => {
    const admin = app("admin");
    for (const [body, status] of [
      [{ chatId: "-100", mention: "required" }, 400],
      [{ ...ROOM }, 400],
      [{ ...ROOM, mention: "off" }, 400],
      [{ ...ROOM, mention: "agent" }, 400],
      [{ ...ROOM, mention: "agent", agent: "ghost" }, 400],
      [{ gatewayId: "telegram:main", chatId: "-999", mention: "required" }, 404],
    ] as const) {
      expect((await admin.answer(body)).status, JSON.stringify(body)).toBe(status);
    }
    // An agent that is gone, and a room that is: each said in the page's words.
    expect(await (await admin.answer({ ...ROOM, mention: "agent", agent: "ghost" })).json()).toEqual({ error: "no agent `ghost`", plain: "That agent is not there any more. Reload the page." });
    expect(((await (await admin.answer({ gatewayId: "telegram:main", chatId: "-999", mention: "required" })).json()) as { plain: string }).plain).toBe("That room is not there any more. Reload the page.");
    expect(admin.sets).toEqual([]);
    expect(admin.audited).toEqual([]);
  });

  test("a room made in the dashboard has none to set: its members answer", async () => {
    const admin = app("admin");
    const refused = await admin.answer({ gatewayId: "web:dashboard", chatId: "web-1", mention: "agent", agent: "novelist" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { plain: string }).plain).toBe("A room made in the dashboard is answered by its members: the orchestrator when it is one of them.");
    expect(admin.sets).toEqual([]);
  });

  test("a daemon that keeps no room settings says so, and is not answered as done", async () => {
    const admin = app("admin", [], false);
    const refused = await admin.answer({ ...ROOM, mention: "required" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { plain: string }).plain).toBe("This cannot be changed on this server.");
    expect(admin.audited).toEqual([]);
  });
});
