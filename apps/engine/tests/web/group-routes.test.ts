/**
 * `/groups` over HTTP — what the Groups page sends (0.7.24). An admin reads every group, anyone else the ones their
 * person spoke in (`whose.ts`); a rename is an admin's, as an edit on People is, and is audited.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerGroupRoutes } from "@/modules/web/control/routes/groups.ts";

function app(role: "admin" | "operator" | "viewer", spoke: string[] = []) {
  const renamed: unknown[] = [];
  const audited: string[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: `u-${role}`, username: role } });
    await next();
  });
  registerGroupRoutes(control as never, {
    pipeline: {
      knownRooms: () => [{ gatewayId: "telegram:main", platform: "telegram", chatId: "-100", name: "Keluarga", dashboard: false, agents: ["nouva"], people: [], lastActive: 1 }],
      renameRoom: (gatewayId: string, chatId: string, title: string) =>
        title.length > 100
          ? { ok: false, reason: "a name is at most 100 characters", why: "long" }
          : (renamed.push({ gatewayId, chatId, title }), title ? { ok: true, name: title } : { ok: true, name: "Keluarga" }),
    },
    audit: { record: (row: { action: string }) => void audited.push(row.action) },
    ctx: { config: { people: [{ key: "mira", name: "Mira", ids: ["web:u-viewer", "telegram:77"] }] } },
    // Where Mira's accounts spoke, as the room log keeps it (`chatPlace`: the platform and the chat).
    roomMessages: { spokeIn: (ids: string[]) => new Set(ids.includes("telegram:77") ? spoke.map((chat) => `telegram\u0000${chat}`) : []) },
  } as never);
  const rename = (body: unknown) => control.request("/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { control, renamed, audited, rename };
}

describe("/groups", () => {
  test("lists every group for an admin, and for anyone else the groups their person spoke in", async () => {
    const names = async (role: "admin" | "viewer", spoke: string[] = []) => {
      const response = await app(role, spoke).control.request("/groups");
      expect(response.status).toBe(200);
      return ((await response.json()) as { groups: { name: string }[] }).groups.map((group) => group.name);
    };
    expect(await names("admin")).toEqual(["Keluarga"]);
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
