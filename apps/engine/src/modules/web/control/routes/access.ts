/**
 * Whose messages are answered, and how much of a group an agent reads.
 */

import type { AccessEvent, AccessImported, AccessListing, AccessMode } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { ACCESS_ACTIONS } from "@/modules/access/access.store.ts";
import { accountIdentity, personOf, type LinkTarget } from "@/modules/config/settings/identities.ts";
import { idFormsFor } from "@/modules/people/match.ts";
import { sendersIn, type Person } from "@nouride/shared";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NOT_SAVED, NO_SETTINGS, notSaved } from "../plain.ts";

/**
 * Who an approved sender is: `me` (the approving admin's own person), `person:<key>` (somebody known),
 * `new` with a name (somebody new), or nothing — approved, and nobody in particular.
 */
function identityTarget(
  as: string | undefined,
  name: string | undefined,
  approver: { user?: { id: string } },
  people: readonly Person[],
): LinkTarget | null | "invalid" | "unlinked" {
  if (!as) return null;
  if (as === "me") {
    const me = approver.user ? personOf(people, accountIdentity(approver.user.id)) : undefined;
    return me ? { person: me.key } : "unlinked";
  }
  if (as.startsWith("person:") && as.length > "person:".length) return { person: as.slice("person:".length) };
  if (as === "new" && name?.trim()) return { name: name.trim() };
  return "invalid";
}

export function registerAccessRoutes(control: ControlApp, deps: ControlDeps): void {
  // Access control: pending pair requests, and the operator's answers. Over the control API rather
  // than only in chat because approving someone should not require watching the agent's chats.
  /**
   * Who is allowed to talk to the agents.
   *
   * A different question from which gateways exist, and the two get confused constantly: a gateway is
   * *where messages arrive*, access is *whose messages are answered*. Both are reported here so the
   * dashboard can say which rule is in force rather than showing a list of names with no context —
   * an allowlist of three people means nothing until you know the mode is `allowlist`.
   */
  control.get("/access", (c) => {
    if (!deps.access) return c.json({ error: "access control is not enabled" }, 501);
    const status = c.req.query("status");
    // Before reading: a code that ran out is not waiting, and a denial whose day is over is not denied.
    deps.access.tidy();
    const listed = deps.access.listed(status === "pending" || status === "approved" || status === "denied" || status === "blocked" ? status : undefined, c.req.query("q"));
    return c.json({
      mode: deps.ctx.config.security.access.mode,
      // Whether the mode can be changed from here at all. A daemon running on built-in defaults has no
      // file to write, and a toggle that silently fails is worse than one that is visibly disabled.
      editable: Boolean(deps.settings),
      // `[security.access] allowlist`: bare or gateway-scoped (`telegram:bot:5550001111`). Admits without pairing in
      // `pair` and `allowlist` mode, which is why it is shown alongside rather than folded into the sender list.
      allowlist: deps.ctx.config.security.access.allowlist,
      senders: listed.senders,
      approvedTotal: listed.approvedTotal,
    } satisfies AccessListing);
  });

  /**
   * Who asked, and what was answered — the Access page's History, from the audit log.
   *
   * The audit log rather than the access table because the table holds where each person stands now: a
   * revoke, a reset or an unblock deletes the row, and an expired request is gone by design.
   */
  control.get("/access/history", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "200", 10);
    return c.json({ entries: deps.audit.ofActions(ACCESS_ACTIONS, Number.isNaN(limit) ? 200 : Math.min(limit, 500)) } satisfies { entries: AccessEvent[] });
  });

  /**
   * How far back agents read a group they were not addressed in — for the whole daemon.
   *
   * Its own route rather than a field on `/gateways`, because it is a daemon setting and reading it
   * from a per-connection endpoint is how a global control ends up looking scoped. Admin only, for the
   * same reason `/access/mode` is: it changes what reaches a model on every connection at once.
   */
  control.get("/group-context", (c) => {
    if (!deps.settings) return c.json({ messages: 0, editable: false } satisfies { messages: number; editable: boolean });
    return c.json({ messages: deps.settings.groupContextDefault(), editable: true } satisfies { messages: number; editable: boolean });
  });

  control.post("/group-context", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    // Not coerced: `Number("")` and `Number(null)` are both 0, which is the off position, so a field
    // that arrived empty would switch the feature off across the daemon.
    if (typeof body.messages !== "number") {
      return c.json({ error: "messages must be a number" }, 400);
    }

    const result = await deps.settings.setGroupContextMessages({
      messages: body.messages,
      actor: principal.actor,
    });
    return result.ok ? c.json(result satisfies { ok: true; restartRequired: boolean }) : c.json({ error: result.error, plain: notSaved("the number of messages replayed") }, 400);
  });

  /**
   * Turn pairing on or off.
   *
   * Registered before `/access/:action` because Hono matches in order and `mode` would otherwise be
   * read as an action. Admin only, and it takes effect on the next message rather than the next boot —
   * see `SettingsService.setAccessMode` for why this one setting is live.
   */
  control.post("/access/mode", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const mode = String(body.mode ?? "").trim();

    const result = await deps.settings.setAccessMode({
      mode,
      // The same set boot checks: only an agent that can run commands makes `open` dangerous.
      agentsWithExec: deps.registry
        .active()
        .filter((agent) => agent.config.tools.enabled.includes("exec"))
        .map((agent) => agent.config.id),
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true, mode: deps.ctx.config.security.access.mode } satisfies { ok: true; mode: AccessMode });
  });

  /**
   * A list of senders let in ahead, at once (`nouride access allow --from`). Registered before `/access/:action`, as
   * `mode` is. Each line is read as the connection reads a written id (`Gateway.senderIdOf`: a phone number as
   * WhatsApp's address of it), so what is kept is what a message from them will carry. `dryRun` writes nothing.
   * `senders` are lines read already; `text` is the list as it was written or pasted, read here.
   */
  control.post("/access/import", async (c) => {
    if (!deps.access) return c.json({ error: "access control is not enabled" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const gatewayId = typeof body.gateway === "string" ? body.gateway.trim() : "";
    const gateway = deps.ctx.gateways.get(gatewayId);
    if (!gateway || gateway.internal) {
      return c.json({ error: `no connection ${JSON.stringify(gatewayId)}`, plain: "There is no connection of that name. Check its name under Connections." }, 404);
    }
    // The list as written (`text`, the Access page's), read as the command reads a file, or its lines read already.
    const listed: unknown[] = typeof body.text === "string" ? sendersIn(body.text) : Array.isArray(body.senders) ? body.senders : [];
    if (listed.length === 0) return c.json({ error: "senders is a list of at least one id", plain: "The list names nobody. Check it, and send it again." }, 400);
    if (listed.length > IMPORT_MAX) return c.json({ error: `a list is at most ${IMPORT_MAX} senders`, plain: "A list holds at most 50,000 people. Send it in parts." }, 400);

    const senders = new Map<string, { senderId: string; name?: string }>();
    const invalid: string[] = [];
    let duplicates = 0;
    for (const line of listed) {
      const written = typeof line === "string" ? line : typeof (line as { id?: unknown })?.id === "string" ? (line as { id: string }).id : "";
      const name = typeof (line as { name?: unknown })?.name === "string" ? (line as { name: string }).name.trim() : "";
      // As this connection writes a sender: its own reading where it has one, else the id as written, whole.
      const senderId = gateway.senderIdOf ? gateway.senderIdOf(written) : /^\S+$/.test(written.trim()) ? written.trim() : null;
      if (!senderId) invalid.push(written.slice(0, 60));
      else if (senders.has(senderId)) duplicates += 1;
      else senders.set(senderId, { senderId, ...(name ? { name } : {}) });
    }
    const dryRun = body.dryRun === true;
    const counts = deps.access.allowMany(gatewayId, [...senders.values()], principal.actor, dryRun);
    return c.json({ gateway: gatewayId, dryRun, read: listed.length, ...counts, duplicates, invalid: { count: invalid.length, examples: invalid.slice(0, 10) } } satisfies AccessImported);
  });

  control.post("/access/:action", async (c) => {
    if (!deps.access) return c.json({ error: "access control is not enabled" }, 501);
    const action = c.req.param("action");
    const code = c.req.query("code");
    const gatewayId = c.req.query("gateway");
    const senderId = c.req.query("sender");

    if (action === "approve" && code) {
      const principal = c.get("principal");
      // An admin's: approving somebody hands them every agent on this box, and "who they are" below
      // can hand them somebody's memory.
      if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
      const as = identityTarget(c.req.query("as"), c.req.query("name"), principal, deps.ctx.config.people);
      if (as === "invalid") return c.json({ error: 'as is "me", "person:<key>" or "new" with name' }, 400);
      if (as === "unlinked") return c.json({ error: "your account is not linked to a person yet. Link it on My Account first" }, 400);
      if (as && !deps.settings) return c.json({ error: "config editing is not available, so who they are cannot be recorded", plain: NO_SETTINGS }, 501);
      const record = deps.access.approveByCode(code, principal.actor);
      if (!record) return c.json({ error: "no pending request with that code, or it expired" }, 404);
      let person: unknown = null;
      if (as && deps.settings) {
        // The platform form — `telegram:814…` — so it is them whichever of our bots they write to.
        const identity = idFormsFor({ gatewayId: record.gatewayId, senderId: record.senderId }).at(-1)!;
        const linked = await deps.settings.linkIdentity({ identity, target: as, actor: principal.actor });
        if (!linked.ok) {
          const unlinked = { ok: true, sender: record, warning: `approved, but not linked: ${linked.error}`, plain: "Approved, but not linked to the person you chose. Whoever runs the server can see why." };
          return c.json(unlinked satisfies { ok: boolean; warning?: string; plain?: string });
        }
        person = linked.person;
      }
      // Told in the conversation they used, so they know to try again rather than waiting.
      if (record.chatId) {
        void deps.notifier?.toChat(
          { gatewayId: record.gatewayId, chatId: record.chatId },
          "You are approved. Go ahead, message me again.",
        );
      }
      const approved = { ok: true, sender: record, person };
      return c.json(approved satisfies { ok: boolean; warning?: string; plain?: string });
    }

    if (action === "allow" && gatewayId && senderId) {
      const principal = c.get("principal");
      // An admin's, as approving a code is: it lets somebody in, where every other answer keeps them out.
      if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);
      // The name they last wrote under, when none is given: an id from config.toml has none, and the
      // room log has usually seen theirs — "Unnamed sender" for somebody the daemon knows is a gap.
      const name = c.req.query("name")?.trim() || deps.roomMessages?.lastNameOf(gatewayId, senderId) || undefined;
      const record = deps.access.allow(gatewayId, senderId, principal.actor, name);
      if (!record) return c.json({ error: `${gatewayId}:${senderId} is blocked. Unblock them first` }, 409);
      const allowed = { ok: true, sender: record };
      return c.json(allowed satisfies { ok: boolean });
    }

    if (isAnswer(action) && gatewayId && senderId) {
      const access = deps.access;
      const actor = c.get("principal").actor;
      const done = {
        deny: () => access.resolve(gatewayId, senderId, "denied", actor) !== null,
        block: () => Boolean(access.block(gatewayId, senderId, actor)),
        revoke: () => access.revoke(gatewayId, senderId, actor),
        reset: () => access.reset(gatewayId, senderId, actor),
        unblock: () => access.unblock(gatewayId, senderId, actor),
      }[action]();
      if (!done) {
        // Said, because `revoke` on a block or `unblock` on an approval is a person who meant the other one.
        const now = access.get(gatewayId, senderId)?.status;
        return c.json({ error: now ? `${gatewayId}:${senderId} is ${now}, so there is nothing to ${action}` : "not found" }, 404);
      }
      // Their "stop asking me" goes with the access a deny, a block or a revoke ends, or pairing them again
      // would bring it back — a decision nobody made twice. A reset or an unblock ends no access.
      if (action === "deny" || action === "block" || action === "revoke") deps.autoApprove?.forget(gatewayId, senderId);
      return c.json({ ok: true } satisfies { ok: boolean });
    }

    return c.json(
      { error: "approve needs ?code=…; allow, deny, block, revoke, reset and unblock need ?gateway=…&sender=…", plain: INCOMPLETE },
      400,
    );
  });
}

/**
 * The answers about one sender beside approving. An operator's, where approving is an admin's: none of
 * them lets anybody in — a reset or an unblock only lets them *ask* again.
 */
const ANSWERS = ["deny", "block", "revoke", "reset", "unblock"] as const;

/**
 * Senders in one list let in at once: enough for a business's whole contact list, and a body the route still reads
 * whole. The refusal's words say this number.
 */
const IMPORT_MAX = 50_000;
const isAnswer = (action: string | undefined): action is (typeof ANSWERS)[number] => ANSWERS.includes(action as never);
