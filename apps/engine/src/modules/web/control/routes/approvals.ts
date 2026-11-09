/**
 * Pending approvals and the standing grants they can turn into.
 */

import type { ApprovalDecision } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import { adminOnly, adminOnlyNotice } from "@/modules/tools/approval-answerers.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** How many answered requests `?all=1` lists. */
const SETTLED_LISTED = 50;

export function registerApprovalRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/approvals", (c) => {
    // The poll *is* the signal. A client asking for pending approvals is a client that would show one,
    // which is the only evidence the daemon has that anybody is there — and without it nothing could be refused for want
    // of anyone to ask, because the local gateway always claims to be connected.
    deps.reach?.notePoll();
    const agent = c.req.query("agent");
    const pending = deps.approvals.pending(agent);
    // `all=1`: what was answered too, from the rows the gate keeps until its sweep — `nouride approvals --all`.
    if (c.req.query("all") !== "1") return c.json({ pending });
    return c.json({ pending, settled: deps.approvals.settled({ ...(agent ? { agentId: agent } : {}), limit: SETTLED_LISTED }) });
  });

  control.get("/approvals/:id", (c) => {
    const approval = deps.approvals.get(c.req.param("id"));
    return approval ? c.json({ approval }) : c.json({ error: "no such approval", id: c.req.param("id") }, 404);
  });

  control.post("/approvals/:id/:decision", (c) => {
    const id = c.req.param("id");
    const decision = c.req.param("decision");
    const DECISIONS: Record<string, ApprovalDecision> = {
      "allow-once": "allow-once",
      "allow-always": "allow-always",
      deny: "deny",
    };
    const resolvedDecision = DECISIONS[decision];
    if (!resolvedDecision) {
      return c.json(
        { error: "decision must be one of allow-once, allow-always, deny" },
        400,
      );
    }

    // The principal, not a hard-coded "cli". Every dashboard answer was attributed to the CLI, so with
    // named accounts in play "who approved this write" had exactly one answer for everybody — which is
    // the one question an audit log of approvals exists to answer.
    // And how a person reads who that was, for the prompt in the chat that says it is settled.
    const principal = c.get("principal");
    // A change to an agent's persona or to People is an admin's to answer (`approval-answerers.ts`): an operator's
    // dashboard account answers the rest, not these. The control token is the operator at the terminal, an admin.
    const request = deps.approvals.get(id);
    if (request && adminOnly(request) && !atLeast(principal, "admin")) {
      return c.json({ error: `admin only: ${adminOnlyNotice(request)}`, plain: "Only an admin can answer this request.", id }, 403);
    }
    const name = principal.kind === "token" ? "the operator, from the command line" : `${principal.actor}, on the dashboard`;
    const resolved = deps.approvals.resolve(id, resolvedDecision, { id: principal.actor, name });
    if (!resolved) {
      // Already answered, already expired, or never existed — all three mean "your decision
      // changed nothing", and conflating them with success would be a lie.
      return c.json({ error: "not pending", id }, 409);
    }
    return c.json({ ok: true, id, decision: resolvedDecision });
  });

  // Grants are listed and revoked over the control API rather than only in the database, because
  // "what standing permissions does this agent have" is a question an operator asks from wherever
  // they are — and `nouride grants revoke --all` has to work from a phone over SSH.
  control.get("/grants", (c) => {
    if (!deps.grants) return c.json({ error: "grants are not enabled in this process" }, 501);
    return c.json({
      grants: deps.grants.list({
        ...(c.req.query("agent") ? { agentId: c.req.query("agent") as string } : {}),
        includeRevoked: c.req.query("all") === "1",
      }),
      // A separate list rather than a merged one. An exec grant is a command; a tool grant is a
      // directory. Flattening them into one array would need a shape that is neither, and the operator
      // deciding what to revoke wants to see which kind they are looking at.
      toolGrants: (deps.toolGrants?.list(c.req.query("agent") ?? undefined) ?? []).filter(
        (g) => c.req.query("all") === "1" || g.revokedAt === null,
      ),
    });
  });

  control.post("/grants/revoke", (c) => {
    if (!deps.grants) return c.json({ error: "grants are not enabled in this process" }, 501);
    const id = c.req.query("id");
    if (id) {
      // Tried against both stores: the operator pastes an id from `nouride grants` and should not have
      // to know which table it came from.
      if (deps.grants.revoke(id, "cli")) return c.json({ ok: true, revoked: 1 });
      const byKey = deps.toolGrants?.list().find((g) => g.id === id || g.grantKey === id);
      if (byKey && deps.toolGrants!.revoke(byKey.grantKey, "cli")) {
        return c.json({ ok: true, revoked: 1 });
      }
      return c.json({ error: "not found or already revoked", id }, 409);
    }
    const agent = c.req.query("agent");
    const revoked = deps.grants.revokeAll("cli", agent ?? undefined);
    // Tool grants are revoked by the same call. An operator running `grants revoke --all` means all of
    // them; leaving one kind standing because it lives in another table would be a surprise of exactly
    // the sort a permissions command must not have.
    let tools = 0;
    for (const grant of deps.toolGrants?.list(agent ?? undefined) ?? []) {
      if (grant.revokedAt === null && deps.toolGrants!.revoke(grant.grantKey, "cli")) tools += 1;
    }
    return c.json({ ok: true, revoked: revoked + tools });
  });
}
