/**
 * Saving notes from the dashboard's notes dialog: an edit names the text it started from.
 *
 * Both texts have a second writer the operator cannot see. An agent writes its own `MEMORY.md`
 * whenever it keeps something, and `person_record` writes the first line of a person's notes. A
 * dialog left open over either would put back the text it opened with and erase what was written
 * meanwhile — so a save carrying `expected` (`expectedNotes` for People) that no longer matches is
 * refused with a 409, and one without it behaves as it always has.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRegistry } from "@nouride/persona";
import type { GlobalConfig, Person } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { savePerson } from "@/modules/config/settings/people.ts";
import { FileService } from "@/modules/setup/files.ts";
import { registerFileRoutes } from "@/modules/web/control/routes/files.ts";
import { registerPeopleRoutes } from "@/modules/web/control/routes/people.ts";

const root = mkdtempSync(join(tmpdir(), "nouride-notes-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function app(register: (control: never, deps: never) => void, deps: unknown) {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role: "admin", user: { username: "gading" } });
    await next();
  });
  register(control as never, deps as never);
  return (path: string, body: unknown) =>
    control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("an agent's MEMORY.md", () => {
  const agentsDir = mkdtempSync(join(root, "agents-"));
  mkdirSync(join(agentsDir, "nouva"));
  const path = join(agentsDir, "nouva", "MEMORY.md");
  const registry = { get: (id: string) => (id === "nouva" ? {} : undefined), reload: async () => {} } as unknown as AgentRegistry;
  const files = new FileService({ agentsDir, configPath: join(root, "config.toml"), registry, config: DEFAULT_CONFIG });
  const post = app(registerFileRoutes, { files });

  test("written by the agent while the dialog was open: the save is refused, the agent's note kept", async () => {
    writeFileSync(path, "# MEMORY\n\n- Opened.\n");
    const opened = readFileSync(path, "utf8");
    writeFileSync(path, "# MEMORY\n\n- Opened.\n- Kept by the agent meanwhile.\n");

    const response = await post("/agents/nouva/files/MEMORY.md", { content: "# MEMORY\n\n- Edited.\n", expected: opened });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/changed since you opened it/);
    expect(readFileSync(path, "utf8")).toContain("Kept by the agent meanwhile.");
  });

  test("unchanged since it was opened: saved", async () => {
    writeFileSync(path, "# MEMORY\n\n- Opened.\n");
    const response = await post("/agents/nouva/files/MEMORY.md", { content: "# MEMORY\n\n- Edited.\n", expected: "# MEMORY\n\n- Opened.\n" });
    expect(response.status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe("# MEMORY\n\n- Edited.\n");
  });

  test("a save that names nothing writes as it always has — the Files tab sends none", async () => {
    writeFileSync(path, "# MEMORY\n\n- Anything.\n");
    const response = await post("/agents/nouva/files/MEMORY.md", { content: "# MEMORY\n\n- Replaced.\n" });
    expect(response.status).toBe(200);
    expect(readFileSync(path, "utf8")).toBe("# MEMORY\n\n- Replaced.\n");
  });
});

describe("a person's notes", () => {
  const people: Person[] = [];
  const configPath = join(root, "people.toml");
  const config = { people, memory: DEFAULT_CONFIG.memory } as unknown as GlobalConfig;
  const post = app(registerPeopleRoutes, {
    ctx: { config },
    settings: { savePerson: (params: Parameters<typeof savePerson>[1]) => savePerson({ config, configPath }, params) },
  });
  const reset = (notes: string) => {
    people.length = 0;
    people.push({ key: "gading", ids: ["telegram:5550001111"], name: "Gading", notes });
    writeFileSync(configPath, `[[people]]\nids = ["telegram:5550001111"]\nname = "Gading"\nkey = "gading"\nnotes = ${JSON.stringify(notes)}\n`);
  };

  test("given a first line by an agent while the dialog was open: refused, the line kept", async () => {
    reset("Founder.");
    const response = await post("/people", { id: "telegram:5550001111", name: "Gading", notes: "Call him Ding.", expectedNotes: "" });
    expect(response.status).toBe(409);
    expect(people[0]?.notes).toBe("Founder.");
  });

  test("unchanged since they were opened: saved, ids and key left as they are", async () => {
    reset("Founder.");
    const response = await post("/people", { id: "telegram:5550001111", name: "Gading", notes: "Founder.\n\n- Call him Ding.", expectedNotes: "Founder." });
    expect(response.status).toBe(200);
    expect(people[0]).toMatchObject({ key: "gading", ids: ["telegram:5550001111"], notes: "Founder.\n\n- Call him Ding." });
  });

  test("found by any id they hold, in today's spelling", async () => {
    // The dialog sends the id as People shows it; a file from before 0.7.0 may still name the connection.
    reset("Founder.");
    const response = await post("/people", { id: "telegram:nouva:5550001111", name: "Gading", notes: "Edited.", expectedNotes: "Stale." });
    expect(response.status).toBe(409);
  });
});
