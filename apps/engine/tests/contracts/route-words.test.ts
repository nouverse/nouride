/**
 * The reader behind the server's replies in everyday words (`scripts/route-words.ts`, 0.8.20): it finds each refusal
 * and note a control route answers with, follows a value as far as its file says, and marks what it cannot read. A
 * route's words it missed would let a command reach the dashboard; a value it took for data when it is words, a domain's
 * sentence or an exception's message, would too.
 */

import { describe, expect, test } from "bun:test";
import { repliesIn, routesIn, unplain, type Reply, type Said } from "../../../../scripts/route-words.ts";
import { CONTROL } from "../../../../scripts/route-values.ts";

const read = (source: string, path = "fixture.ts") => repliesIn(path, source);
const words = (said: Said[]) => said.map((one) => one.text || `<${one.unread.join(", ")}>`);
const summary = (reply: Reply) => `${reply.method} ${reply.path} ${reply.status?.join(",") ?? "?"}: ${[...words(reply.error), ...words(reply.note)].join(" | ")}${reply.plain.length ? ` (plain: ${words(reply.plain).join(" | ")})` : ""}`;

describe("what the reader reads", () => {
  test("each route's replies: its method and path, the status, and each reply's error, note and plain", () => {
    const replies = read(`
      export function registerThings(control: ControlApp, deps: ControlDeps): void {
        control.get("/things/:id", (c) => {
          if (!deps.things) return c.json({ error: "things are not run in this process" }, 501);
          if (!found) return c.json({ error: "no such thing", note: "the list has the others" }, 404);
          return c.json({ thing: found });
        });
        control.post("/things/:id/stop", (c) => c.json({ error: "it needs [things] enabled", plain: "Things are turned off on this server." }, 409));
        for (const verb of ["approve", "deny"] as const) {
          control.post(\`/things/:id/\${verb}\`, (c) => c.json({ error: "operator only" }, 403));
        }
      }
    `);
    expect(replies.map(summary)).toEqual([
      "GET /things/:id 501: things are not run in this process",
      "GET /things/:id 404: no such thing | the list has the others",
      "GET /things/:id 200: ",
      "POST /things/:id/stop 409: it needs [things] enabled (plain: Things are turned off on this server.)",
      "POST /things/:id/:0 403: operator only",
    ]);
    expect(routesIn("fixture.ts", `export function r(control: ControlApp) { control.get("/a", h); control.delete("/a/:id", h); }`)).toEqual([
      { method: "GET", path: "/a" },
      { method: "DELETE", path: "/a/:id" },
    ]);
  });

  test("a value followed inside the file: a const, a function's tuple, a parameter by the call followed, ?:, || and a spread", () => {
    const replies = read(`
      export function registerMemory(control: ControlApp, deps: ControlDeps): void {
        const unavailable = { error: "memory is not run in this process" };
        function refusal(principal: Principal, role: "operator" | "admin", why = ""): [string, 403 | 503] | null {
          if (!atLeast(principal, role)) return [\`\${role} only\${why}\`, 403];
          if (!deps.memory) return ["memory is not wired in this process", 503];
          return null;
        }
        control.post("/memory/forget", (c) => {
          const no = refusal(c.get("principal"), "admin", ": forgetting cannot be undone");
          if (no) return c.json({ error: no[0] }, no[1]);
          if (!deps.memory) return c.json(unavailable, 501);
          return c.json({ error: busy ? "a pass is running" : "nothing to forget", ...(left ? { note: "try again later" } : {}) }, 409);
        });
        control.get("/memory/status", (c) => {
          const no = refusal(c.get("principal"), "operator");
          return no ? c.json({ error: no[0] }, no[1]) : c.json({ ok: true });
        });
      }
    `);
    const forget = replies.filter((reply) => reply.path === "/memory/forget");
    expect(forget.map(summary)).toEqual([
      // Its role and its reason, from the arguments its own call passes: never the other route's "operator".
      "POST /memory/forget 403,503: {} only{} | admin | : forgetting cannot be undone | memory is not wired in this process",
      "POST /memory/forget 501: memory is not run in this process",
      "POST /memory/forget 409: a pass is running | nothing to forget | try again later",
    ]);
    expect(forget.flatMap((reply) => [...reply.error, ...reply.note]).flatMap((said) => said.unread)).toEqual([]);
    // A parameter's default, where its call passes nothing.
    const status = replies.find((reply) => reply.path === "/memory/status" && reply.status?.includes(403))!;
    expect(summary(status)).toBe("GET /memory/status 403,503: {} only{} | operator | memory is not wired in this process");
  });

  test("a sentence a helper of the control API makes of the words it is handed: read with each call's words", () => {
    // At a route's own path, so `../plain.ts` is the real one and its `notSaved` is followed.
    const replies = read(`
      import { NOT_SAVED, notSaved } from "../plain.ts";
      const CRON_FIELDS = { schedule: "the schedule", agentId: "the agent", "payload.goal": "the goal" } as const;
      export function registerCron(control: ControlApp, deps: ControlDeps): void {
        control.post("/cron", (c) => c.json({ error: result.error, plain: notSaved("the schedule") }, 400));
        control.post("/cron/:id", (c) => c.json({ error: result.error, plain: notSaved(result.field && CRON_FIELDS[result.field]) }, 400));
        control.post("/cron/:id/goal", (c) => c.json({ error: result.error, plain: notSaved(CRON_FIELDS["payload.goal"]) }, 400));
        control.post("/cron/:id/run", (c) => c.json({ error: result.error, plain: NOT_SAVED }, 400));
      }
    `, `${CONTROL}/routes/cron.ts`);
    const plains = replies.map((reply) => words(reply.plain));
    const shape = "Nothing was saved. Check {}, and try again.";
    const generic = "Nothing was saved. Check what you entered, and try again.";
    expect(plains).toEqual([
      [shape, "the schedule", generic],
      // Every entry of the table the route looks the field up in, and the words with no field.
      [shape, "the schedule", "the agent", "the goal", generic],
      [shape, "the goal", generic],
      [generic],
    ]);
    expect(replies.every((reply) => reply.plainAlways)).toBe(true);
  });

  test("words handed to a helper are held like any: one it cannot read, or a technical one, does not pass", () => {
    const reply = (argument: string) =>
      read(`
        import { notSaved } from "../plain.ts";
        export function r(control: ControlApp) { control.post("/x", (c) => c.json({ error: result.error, plain: notSaved(${argument}) }, 400)); }
      `, `${CONTROL}/routes/x.ts`)[0]!;
    // The domain's own words, or a name a route passes on: the page would show what nothing here checked.
    expect(unplain(reply("result.field"))).toEqual(["plain holds words written elsewhere: result.field"]);
    expect(unplain(reply(`c.req.param("field")`))).toEqual(['plain holds words written elsewhere: c.req.param("field")']);
    expect(unplain(reply(`"the bot_token"`))).toEqual(['plain has a setting\'s name: "the bot_token"']);
    expect(unplain(reply(`"the port"`))).toEqual([]);
  });

  test("what another file writes cannot be read: a domain's refusal, an exception's message, a body built elsewhere", () => {
    const [saved, thrown, built, data, imported] = read(`
      import { describe } from "@/modules/things/words.ts";
      export function registerSettings(control: ControlApp, deps: ControlDeps): void {
        control.post("/settings", async (c) => {
          const result = await deps.settings.save(await jsonBody(c));
          if (!result.ok) return c.json({ error: result.error }, 400);
          try {
            await deps.settings.apply();
          } catch (err) {
            return c.json({ error: \`could not apply it: \${String(err)}\` }, 500);
          }
          if (result.later) return c.json(result, 409);
          return c.json({ error: \`no agent "\${c.req.param("id")}" in \${agent.config.name}, \${names.join(", ")} instead\` }, 404);
        });
        control.post("/settings/other", (c) => c.json({ error: describe(c.req.param("id")) }, 400));
      }
    `);
    expect(saved!.error[0]!.unread).toEqual(["result.error"]);
    expect(thrown!.error[0]).toMatchObject({ text: "could not apply it: {}", unread: ["String(err)"] });
    // Named by what it was made of: the call into another file.
    expect(built!.unread).toEqual(["deps.settings.save(await jsonBody(c))"]);
    // An id, a name, a list joined: data, standing as {}.
    expect(data!.error).toEqual([{ text: 'no agent "{}" in {}, {} instead', line: 13, unread: [] }]);
    // A function of another file is a domain's: what it returns is not read here.
    expect(imported!.error[0]!.unread).toEqual(['describe(c.req.param("id"))']);
  });

  test("a const another file exports is read, and a tuple spread into c.json, and a body a function of the file builds", () => {
    const replies = read(`
      import { NOT_RUNNING } from "./plain.ts";
      export function registerRooms(control: ControlApp, deps: ControlDeps): void {
        const refused = (error: string): [{ error: string; plain: string }, 409] => [{ error, plain: "That room is not there." }, 409];
        control.post("/rooms", (c) => c.json({ error: "rooms are not run here", plain: NOT_RUNNING }, 501));
        control.post("/rooms/:id", (c) => c.json(...refused("no such room")));
        control.post("/rooms/:id/send", (c) => {
          const sent = send(c.req.param("id"));
          return c.json(sent.body, sent.status);
        });
      }
      function send(id: string): { status: 200 | 409; body: Record<string, unknown> } {
        const fail = (status: 409, error: string) => ({ status, body: { error } }) as const;
        if (!id) return fail(409, "the local gateway is not enabled");
        return { status: 200, body: { id } };
      }
    `, "/nowhere/control/routes/rooms.ts");
    expect(replies.map(summary)).toEqual([
      // The file it is imported from is not there: the const cannot be read, and the reply says so.
      "POST /rooms 501: rooms are not run here (plain: <NOT_RUNNING>)",
      "POST /rooms/:id 409: no such room (plain: That room is not there.)",
      "POST /rooms/:id/send 409,200: the local gateway is not enabled",
    ]);
  });

  test("the guard's replies answer every route", () => {
    const replies = read(`
      export function controlGuard(deps: ControlDeps) {
        return async (c, next) => {
          if (!principal) return c.json({ error: "unauthorized" }, 401);
          await next();
        };
      }
    `, "apps/engine/src/modules/web/control/guard.ts");
    expect(replies.map(summary)).toEqual(["* * 401: unauthorized"]);
  });
});

describe("what the rule refuses", () => {
  const reply = (body: string, status = "409") =>
    read(`export function r(control: ControlApp) { control.post("/x", (c) => { const result = deps.do(); return c.json(${body}, ${status}); }); }`)[0]!;

  test("a command-line word, or words it cannot read, with no plain", () => {
    expect(unplain(reply(`{ error: "semantic search is off: it needs [memory.semantic] enabled, provider and model" }`))).toEqual([
      'error has a section of the config file: "semantic search is off: it needs [memory.semantic] enabled, provider and model"',
    ]);
    expect(unplain(reply(`{ error: "Its folder holds work nobody committed. Commit it there first." }`))).toEqual([
      'error has a git word: "Its folder holds work nobody committed. Commit it there first."',
    ]);
    expect(unplain(reply(`{ error: "nothing would restart it", note: "pass --force to stop it anyway" }`))).toEqual(['note has a flag: "pass --force to stop it anyway"']);
    expect(unplain(reply(`{ error: result.refused }`))).toEqual(["error holds words written elsewhere: result.refused"]);
    expect(unplain(reply(`result`, "400"))).toEqual(["a refusal written elsewhere: deps.do()"]);
    expect(unplain(reply(`{ error: "a name is required" }`))).toEqual([]);
  });

  test("a plain there whatever happens, in everyday words, beside the words the CLI prints, lets it through", () => {
    expect(unplain(reply(`{ error: result.refused, plain: "This mission has already ended." }`))).toEqual([]);
    expect(unplain(reply(`{ error: "it needs [memory.semantic] enabled", plain: busy ? "Search by meaning is off." : "Not now." }`))).toEqual([]);
    // Only in one branch: the other shows the error as it is.
    expect(unplain(reply(`{ error: result.refused, ...(gone ? { plain: "It is gone." } : {}) }`))).toEqual(["error holds words written elsewhere: result.refused"]);
    // A plain is held to the same rule.
    expect(unplain(reply(`{ error: "x", plain: "Run nouride doctor on the server." }`))).toEqual(['plain has a command: "Run nouride doctor on the server."']);
    expect(unplain(reply(`{ error: "x", plain: result.words }`))).toEqual(["plain holds words written elsewhere: result.words"]);
    // A plain alone would leave the CLI nothing to print.
    expect(unplain(reply(`{ plain: "Nothing was saved." }`))).toEqual(["a plain with no error or note beside it, the words the CLI prints"]);
  });

  test("each body a reply can answer with is held on its own, and a word passes with a plain beside it", () => {
    // A probe: one body says nothing, the other gives the page's words beside the server's.
    expect(unplain(reply(`probe.ok ? { ok: true, models: probe.models } : { ...probe, plain: "Nouride could not reach that address." }`, "200"), true)).toEqual([]);
    expect(unplain(reply(`probe.ok ? probe : { ...probe, plain: "Nouride could not reach that address." }`, "200"), true)).toEqual(["a success the page shows words from written elsewhere: probe"]);
    // An error and its plain spread in together say both or neither.
    expect(unplain(reply(`{ servers: [], ...(result.error ? { error: result.error, plain: "Some connectors could not be read." } : {}) }`, "200"))).toEqual([]);
    expect(unplain(reply(`{ servers: [], ...(result.error ? { error: result.error } : {}) }`, "200"))).toEqual(["error holds words written elsewhere: result.error"]);
  });

  test("a success's own field a page shows (PAGE_WORDS) is held as a note is, on its route and no other (0.8.23)", () => {
    const told = (body: string, path = "/missions/:id/:verb") =>
      read(`export function r(control: ControlApp) { control.post("${path}", (c) => { const told = deps.missions.tell(); return c.json(${body}); }); }`)[0]!;
    // Where a tell went, in the mission's words: the page shows them.
    expect(unplain(told(`{ mission: told.mission, said: told.said }`), true)).toEqual(["said holds words written elsewhere: told.said"]);
    expect(unplain(told(`{ mission: told.mission, said: "Told. It reads this before its next step --now." }`), true)).toEqual(['said has a flag: "Told. It reads this before its next step --now."']);
    // With the page's words beside them, they are the CLI's.
    expect(unplain(told(`{ mission: told.mission, said: told.said, plain: "Kept for its next turn." }`), true)).toEqual([]);
    // A field of that name on a route no page shows it from is data.
    expect(unplain(told(`{ mission: told.mission, said: told.said }`, "/missions/:id/elsewhere"), false)).toEqual([]);
    // A body built elsewhere, on a route whose page shows words from its success, cannot pass without them: held by the
    // table, whatever the page's call declares.
    const tidy = read(`export function r(control: ControlApp) { control.post("/memory/tags/tidy/model", async (c) => { const result = await deps.memory.tags.suggest(); return c.json(result); }); }`)[0]!;
    expect(unplain(tidy)).toEqual(["a success the page shows words from written elsewhere: deps.memory.tags.suggest()"]);
    const beside = read(`export function r(control: ControlApp) { control.post("/memory/tags/tidy/model", async (c) => { const result = await deps.memory.tags.suggest(); return c.json({ ...result, plain: "Try again." }); }); }`)[0]!;
    expect(unplain(beside)).toEqual([]);
  });

  test("a success is data, unless the page shows words from it: a note, or a test that failed", () => {
    expect(unplain(reply(`{ ok: true, ...result }`, "200"))).toEqual([]);
    expect(unplain(reply(`{ ok: true, ...result }`, "200"), true)).toEqual(["a success the page shows words from written elsewhere: ...deps.do()"]);
    expect(unplain(reply(`{ ok: true, ...result, plain: "Nouride restarts in a moment." }`, "200"), true)).toEqual([]);
    expect(unplain(reply(`{ ok: true, note: result.note }`, "200"))).toEqual(["note holds words written elsewhere: result.note"]);
  });
});
