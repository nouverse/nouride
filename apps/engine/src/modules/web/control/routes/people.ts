/**
 * The people an agent is told about by name.
 */

import { atLeast } from "@/modules/users/auth.ts";
import { accountIdentity, personOf, type LinkTarget } from "@/modules/config/settings/identities.ts";
import type { MorningField, PersonField } from "@/modules/config/settings/people.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { CHANGED_MEANWHILE, NOT_CHANGED, NO_SETTINGS, notSaved } from "../plain.ts";

/** Each field a person's save can be refused for, as the People page's form names it. */
const PERSON_FIELDS: Record<PersonField, string> = {
  name: "the display name",
  key: "the person key",
  ids: "the accounts",
};

/** The two fields of a person's morning line, as its row names them. */
const MORNING_FIELDS: Record<MorningField, string> = {
  at: "the morning line's time",
  to: "where the morning line goes",
};

export function registerPeopleRoutes(control: ControlApp, deps: ControlDeps): void {
  // As loaded: every account in the platform's spelling, which the loader holds `[[people]]` to.
  control.get("/people", (c) => c.json({ people: deps.ctx.config.people ?? [] }));

  /**
   * Add a person, or change one.
   *
   * `key` names them: somebody already in `[[people]]`, or — with `create` — the key a new person is
   * given, refused when somebody holds it. Without a key, `id` is an account: whoever holds it, or a new
   * person holding it, with a key made from their name — `nouride people set <account>` says it that way.
   * Neither is needed to add somebody: a name is enough, and their accounts are attached when they pair.
   */
  control.post("/people", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const text = (field: string) => (typeof body[field] === "string" ? (body[field] as string).trim() : "");
    const name = text("name");
    const key = text("key");
    const account = text("id");
    /**
     * Present-but-empty is a clear; absent is "do not touch it".
     *
     * Collapsing both into `undefined` meant the dashboard could not remove a note, and — worse — an
     * agent running `nouride people set <id> --name X` deleted whatever the operator had written about
     * that person, because the command says nothing about notes.
     */
    const notes = typeof body.notes === "string" ? body.notes.trim() : undefined;
    /**
     * Their accounts, on the same rule: absent leaves them, an array replaces them — empty included,
     * which leaves a person with none.
     */
    const ids = Array.isArray(body.ids) ? body.ids.filter((entry): entry is string => typeof entry === "string") : undefined;

    if (!name) return c.json({ error: "person name is required" }, 400);

    /**
     * The notes an edit started from, when the editor sends them — the notes dialog does. Notes that
     * changed since are refused rather than overwritten: the person may have had an agent change a line
     * of them while the page was open. Checked inside the save, in turn with the agent's write, so the
     * check is still true when the write lands.
     */
    const expectedNotes = typeof body.expectedNotes === "string" && notes !== undefined ? body.expectedNotes : undefined;
    // The accounts it started from, on the same rule: a list sent replaces theirs, so one changed since is refused.
    const expectedIds = Array.isArray(body.expectedIds) && ids !== undefined ? body.expectedIds.filter((entry): entry is string => typeof entry === "string") : undefined;

    const result = await deps.settings.savePerson({
      // `notes: ""` is passed through, not dropped — it is the clear.
      person: {
        name,
        ...(key ? { key } : {}),
        ...(ids === undefined ? {} : { ids }),
        ...(notes === undefined ? {} : { notes }),
      },
      ...(!key && account ? { account } : {}),
      ...(body.create === true ? { create: true } : {}),
      ...(body.reattach === true ? { reattach: true } : {}),
      actor: principal.user?.username ?? principal.kind,
      ...(expectedNotes === undefined ? {} : { expectedNotes }),
      ...(expectedIds === undefined ? {} : { expectedIds }),
    });

    if (!result.ok) {
      const conflict = "conflict" in result && result.conflict === true;
      return c.json({ error: result.error, plain: conflict ? CHANGED_MEANWHILE : notSaved(result.field && PERSON_FIELDS[result.field]) }, conflict ? 409 : 400);
    }
    return c.json({ ok: true, person: result.person, people: deps.ctx.config.people });
  });

  /**
   * Take somebody out of People, named by key (`?key=`) or by an account they hold (`?id=`). Their MCP
   * tokens are revoked with them: a token is resolved by key when it is used, and one left live answered
   * again for whoever was given that key next. Their memory stays under their key — `nouride memory
   * forget` is what removes it — and a new person is not given that key unless someone says so.
   */
  control.delete("/people", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const person = (c.req.query("key") ?? c.req.query("id") ?? "").trim();
    if (!person) return c.json({ error: "a person is required (?key=… or ?id=…)" }, 400);

    const result = await deps.settings.removePerson({ person, actor: principal.user?.username ?? principal.kind });

    if (!result.ok) return c.json({ error: result.error, plain: NOT_CHANGED }, 400);
    const revoked = deps.mcpTokens?.revokeFor(result.person.key, Date.now()) ?? [];
    for (const id of revoked) deps.audit?.record({ action: "mcp_token_revoked", actor: principal.actor, details: { id, person: result.person.key, why: "removed from People" } });
    return c.json({ ok: true, people: deps.ctx.config.people, tokensRevoked: revoked.length });
  });

  /** A body's target: `{ person: key | id }` for somebody already known, `{ name }` for somebody new. */
  function targetOf(body: Record<string, unknown>): LinkTarget | null {
    if (typeof body.person === "string" && body.person.trim()) return { person: body.person.trim() };
    if (typeof body.name === "string" && body.name.trim()) return { name: body.name.trim() };
    return null;
  }

  /**
   * A person's morning line (0.8.0): `{ at: "07:00" }` to have one, `{ at: null }` for none; `to` one of their chat
   * accounts, `"telegram:555"`, or null for wherever they last wrote from — left out, it stays. An admin's, as the rest
   * of a person's entry is.
   */
  control.post("/people/:key/morning", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as { at?: unknown; to?: unknown };
    const { at, to } = body;
    if (at !== null && typeof at !== "string") return c.json({ error: "`at` is a time of day, HH:MM, or null" }, 400);
    if (to !== undefined && to !== null && typeof to !== "string") return c.json({ error: "`to` is one of their accounts, or null" }, 400);
    const result = await deps.settings.writePersonMorning(c.req.param("key"), { at, ...(to !== undefined ? { to } : {}) }, principal.actor);
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && MORNING_FIELDS[result.field]) }, 400);
    return c.json({ ok: true, at, to: at === null ? null : (to ?? deps.ctx.config.people.find((one) => one.key === c.req.param("key"))?.morningTo ?? null) });
  });

  /** Who this account is to the agents. */
  control.get("/people/me", (c) => {
    const principal = c.get("principal");
    if (!principal.user) return c.json({ person: null });
    const person = personOf(deps.ctx.config.people, accountIdentity(principal.user.id)) ?? null;
    return c.json({ person });
  });

  /**
   * Say who this account is — somebody already in `[[people]]`, or a new person by name. An admin's:
   * being linked to a person is being given their memory in a DM. The first login's "your name".
   */
  control.post("/people/me", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!principal.user || !atLeast(principal, "admin")) return c.json({ error: "admin only: an account is linked to a person by an admin" }, 403);
    const target = targetOf(((await jsonBody(c)) ?? {}) as Record<string, unknown>);
    if (!target) return c.json({ error: "person (a key or id) or name is required" }, 400);
    const result = await deps.settings.linkIdentity({ identity: accountIdentity(principal.user.id), target, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: "The account was not linked. Pick the person again, and try again." }, 400);
    return c.json({ person: result.person });
  });

  /** Link another dashboard account to a person. An admin's, for the same reason. */
  control.post("/people/link", async (c) => {
    if (!deps.settings || !deps.users) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const user = typeof body.user === "string" ? deps.users.byId(body.user) : null;
    if (!user) return c.json({ error: "user must be an account id" }, 400);
    const target = targetOf(body);
    if (!target) return c.json({ error: "person (a key or id) or name is required" }, 400);
    const result = await deps.settings.linkIdentity({ identity: accountIdentity(user.id), target, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: "The account was not linked. Pick the person again, and try again." }, 400);
    return c.json({ person: result.person });
  });
}
