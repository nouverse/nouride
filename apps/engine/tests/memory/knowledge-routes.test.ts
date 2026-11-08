/**
 * The knowledge base's routes (0.8.20, KNOWLEDGE_BASE §5.1, §11, §13): what the dashboard's Knowledge tab and
 * `nouride knowledge` read and change. A collection made here is the maker's until an admin opens it; an operator adds
 * and removes documents; an admin deletes a collection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { household, type Household } from "./fixture.ts";

let h: Household;
beforeEach(async () => {
  h = await household();
  // Gading's dashboard account, so a collection Gading makes is Gading's.
  h.config.people.find((person) => person.key === "gading")!.ids!.push("web:acc-gading");
});
afterEach(() => h.close());

function app(role: "viewer" | "operator" | "admin", account = "acc-gading") {
  const audited: string[] = [];
  const hono = new Hono<{ Variables: { principal: unknown } }>();
  hono.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "tester", role, user: { id: account } });
    await next();
  });
  const deps = {
    ctx: { config: { ...h.config, attachments: { maxSizeMb: 1 } } },
    memory: h.memory,
    registry: { get: (id: string) => (["nouva", "nix"].includes(id) ? { config: { id } } : undefined) },
    audit: { record: (row: { action: string }) => void audited.push(row.action) },
  } as never;
  registerKnowledgeRoutes(hono as never, deps);
  return { hono, audited };
}
const json = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const read = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("making a collection", () => {
  test("an operator's, for the person who made it; written as knowledge.toml in its own folder", async () => {
    const { hono, audited } = app("operator");
    const made = await hono.request("/knowledge", json("POST", { name: "Mum's health", description: "Lab results" }));
    expect(made.status).toBe(201);
    expect((await read(made)).collection).toMatchObject({ id: "mum-s-health", name: "Mum's health", readers: { kind: "people", people: ["gading"] }, documents: 0 });
    expect(readFileSync(join(h.knowledgeRoot, "mum-s-health", "knowledge.toml"), "utf8")).toContain('readers = ["gading"]');
    expect(audited).toEqual(["knowledge_collection_created"]);
    expect((await app("viewer").hono.request("/knowledge", json("POST", { name: "X" }))).status).toBe(403);
  });

  test("opened to more than its maker by an admin only; a name already taken refused", async () => {
    expect((await app("operator").hono.request("/knowledge", json("POST", { name: "House", readers: { kind: "everyone" } }))).status).toBe(403);
    const open = await app("admin").hono.request("/knowledge", json("POST", { name: "House", readers: { kind: "everyone" } }));
    expect(open.status).toBe(201);
    const taken = await app("admin").hono.request("/knowledge", json("POST", { name: "House" }));
    expect(taken.status).toBe(409);
    // The dashboard's words beside the command line's (0.8.20 item 0).
    expect(await taken.json()).toEqual({ error: 'There is already a collection called "house".', plain: "There is already a collection with that name." });
    expect((await app("admin").hono.request("/knowledge", json("POST", { name: "Y", readers: { kind: "people", people: ["nobody"] } }))).status).toBe(400);
    expect((await app("admin").hono.request("/knowledge", json("POST", { name: "Z", agents: ["ghost"] }))).status).toBe(400);
  });

  test("someone with nobody in People makes one for the admins, as a folder made by hand is", async () => {
    const made = await read(await app("operator", "acc-stranger").hono.request("/knowledge", json("POST", { name: "Notes" })));
    expect(made.collection).toMatchObject({ readers: { kind: "admins" } });
  });

  test("a refused setting names its field on the page, as the form names it (0.8.23)", async () => {
    const { hono } = app("admin");
    await hono.request("/knowledge", json("POST", { name: "Ops" }));
    const plain = async (method: string, path: string, body: unknown) => {
      const refused = await hono.request(path, json(method, body));
      expect(refused.status).toBe(400);
      return (await read(refused)).plain;
    };
    const check = (what: string) => `Nothing was saved. Check ${what}, and try again.`;
    expect(await plain("POST", "/knowledge", { name: "x".repeat(81) })).toBe(check("the name"));
    expect(await plain("POST", "/knowledge", { description: "Lab results" })).toBe(check("the name"));
    expect(await plain("POST", "/knowledge", { name: "Y", description: "x".repeat(301) })).toBe(check("what is in it"));
    expect(await plain("POST", "/knowledge", { name: "Y", readers: { kind: "people", people: ["nobody"] } })).toBe(check("who may be answered from it"));
    expect(await plain("POST", "/knowledge", { name: "Y", agents: ["ghost"] })).toBe(check("which agents look in it"));
    expect(await plain("PATCH", "/knowledge/ops", { about: ["nobody"] })).toBe(check("who it is about"));
    // The archive switch sends true or false, so nothing a person entered can be what was refused.
    expect(await plain("PATCH", "/knowledge/ops", { archived: "yes" })).toBe("Nothing was saved. Check what you entered, and try again.");
  });
});

describe("documents", () => {
  beforeEach(async () => {
    await app("admin").hono.request("/knowledge", json("POST", { name: "Ops", readers: { kind: "everyone" } }));
  });

  test("written on the page, uploaded as files, or sent as bytes; each read and its sections shown", async () => {
    const { hono } = app("operator");
    const written = await read(await hono.request("/knowledge/ops/documents", json("POST", { name: "Runbook", text: "# Runbook\n## Backups\nVzdump at 02:00.\n" })));
    expect(written.saved).toEqual([{ path: "Runbook.md", status: "indexed" }]);
    const form = new FormData();
    form.append("files", new File(["sku,price\nA,1\n"], "prices.csv"));
    form.append("files", new File([new Uint8Array([0xff, 0xd8])], "photo.jpg"));
    const uploaded = await read(await hono.request("/knowledge/ops/documents", { method: "POST", body: form }));
    expect(uploaded.saved).toEqual([
      { path: "prices.csv", status: "indexed" },
      { path: "photo.jpg", status: "listed", reason: "Nouride does not read this kind of file, so it is kept here but not searched." },
    ]);
    const bytes = await read(await hono.request("/knowledge/ops/documents", json("POST", { name: "notes.txt", base64: btoa("Plain notes about the NAS.") })));
    expect(bytes.saved).toEqual([{ path: "notes.txt", status: "indexed" }]);
    // The same name again is a document of its own, never one written over.
    const again = await read(await hono.request("/knowledge/ops/documents", json("POST", { name: "notes.txt", base64: btoa("Other notes.") })));
    expect(again.saved).toEqual([{ path: "notes (2).txt", status: "indexed" }]);

    // A viewer reads none of it: a collection may be kept for one person (memory's reads are an operator's too).
    expect((await app("viewer").hono.request("/knowledge/ops/document?path=Runbook.md")).status).toBe(403);
    expect((await app("viewer").hono.request("/knowledge")).status).toBe(403);
    expect((await app("viewer").hono.request("/knowledge/search?q=vzdump")).status).toBe(403);
    const shown = await read(await app("operator").hono.request("/knowledge/ops/document?path=Runbook.md"));
    expect((shown.sections as { trail: string }[]).map((section) => section.trail)).toEqual(["Runbook › Backups"]);
    const searched = await read(await app("operator").hono.request("/knowledge/search?q=vzdump"));
    expect((searched.hits as { item: string }[]).map((hit) => hit.item)).toEqual(["knowledge:ops/Runbook.md#0"]);
  });

  test("a name that would leave the folder is refused; a file over the upload cap too", async () => {
    const { hono } = app("operator");
    expect((await hono.request("/knowledge/ops/documents", json("POST", { name: "../../etc/passwd", text: "x" }))).status).toBe(201);
    expect(existsSync(join(h.knowledgeRoot, "ops", "passwd.md"))).toBe(true);
    expect(existsSync(join(h.knowledgeRoot, "..", "etc"))).toBe(false);
    const hidden = await hono.request("/knowledge/ops/documents", json("POST", { name: ".hidden", text: "x" }));
    expect(hidden.status).toBe(400);
    expect(((await hidden.json()) as { plain: string }).plain).toBe("That name cannot be used. Use letters, digits and spaces.");
    expect((await hono.request("/knowledge/ops/documents", json("POST", { name: "big.bin", base64: btoa("x".repeat(1024 * 1024 + 1)) }))).status).toBe(413);
  });

  test("removed by an operator; a collection deleted by an admin only, its documents with it", async () => {
    await app("operator").hono.request("/knowledge/ops/documents", json("POST", { name: "Runbook", text: "# Runbook\nVzdump.\n" }));
    expect((await app("operator").hono.request("/knowledge/ops/documents?path=Runbook.md", { method: "DELETE" })).status).toBe(200);
    expect((await read(await app("operator").hono.request("/knowledge/search?q=vzdump"))).hits).toEqual([]);
    expect((await app("operator").hono.request("/knowledge/ops", { method: "DELETE" })).status).toBe(403);
    expect((await app("admin").hono.request("/knowledge/ops", { method: "DELETE" })).status).toBe(200);
    expect(existsSync(join(h.knowledgeRoot, "ops"))).toBe(false);
  });

  test("archived and brought back; readers changed by an admin only", async () => {
    const archived = await read(await app("operator").hono.request("/knowledge/ops", json("PATCH", { archived: true })));
    expect(archived.collection).toMatchObject({ archived: true });
    expect((await app("operator").hono.request("/knowledge/ops", json("PATCH", { readers: { kind: "group", chat: "telegram:nouva:-100" } }))).status).toBe(403);
    const opened = await read(await app("admin").hono.request("/knowledge/ops", json("PATCH", { readers: { kind: "group", chat: "telegram:nouva:-100" }, archived: false })));
    expect(opened.collection).toMatchObject({ archived: false, readers: { kind: "group", chat: "telegram:nouva:-100" } });
  });
});
