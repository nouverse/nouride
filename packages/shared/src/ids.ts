/**
 * Id generation.
 *
 * `crypto.randomUUID` is a web standard present in Bun, Node and Deno, so this
 * does not need to go through `@nouride/runtime` — there is nothing
 * runtime-specific to isolate.
 */

/** Prefixed id: `apr_9f2c…`. The prefix makes a stray id in a log self-describing. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/**
 * Stable session id derived from its key, so a restart reattaches to the same row
 * without a lookup table (§18 SPEC keeps a UNIQUE constraint on the same triple).
 */
export function sessionId(agentId: string, gateway: string, chatId: string): string {
  return `ses_${agentId}:${gateway}:${chatId}`;
}

/**
 * The same id, from the key object the daemon passes around.
 *
 * A `static` on `SessionStore` until the store refactor, which made it the last reason business
 * logic imported a store class at all — four modules pulled in the whole store to call one pure
 * function that touches no database. It was never a database operation: it derives a string from
 * three strings, and it lives beside `sessionId`, which it wraps.
 */
export function sessionIdFor(key: {
  agentId: string;
  gatewayId: string;
  chatId: string;
}): string {
  return sessionId(key.agentId, key.gatewayId, key.chatId);
}

/**
 * A turn that runs inside another conversation without being one: a `delegate` helper, or a peer
 * answering `ask_agent`, or (0.8.17) a side question answering `/btw`. The marker is what lets anything
 * downstream find the conversation it belongs to — see `rootSessionOf`.
 */
export type ChildSessionKind = "sub" | "peer" | "btw";

/** The scratch session id for a child turn. Never persisted; see `pipeline/subagent.ts`. */
export function childSessionId(parent: string, kind: ChildSessionKind): string {
  return `${parent}:${kind}:${newId(kind)}`;
}

/**
 * The conversation a session id belongs to, with every child marker stripped.
 *
 * Why it exists: a helper's spilled output is handed back to the lead by path, and the lead can only
 * open it if both resolve to the same directory. Cut at the *first* marker, so a peer that delegates
 * still resolves to the conversation a person is in.
 */
export function rootSessionOf(id: string): string {
  const marker = /:(?:sub|peer|btw):/.exec(id);
  return marker ? id.slice(0, marker.index) : id;
}

/**
 * A person, as the owner of something is kept: `<platform>:<their id there>`, the form People writes an id in and a
 * conversation's opener is kept in (`web:<account id>`, `telegram:814…`). `gatewayId` carries the platform. Nothing
 * for a sender that is no person: the command line, the daemon's own, an agent.
 */
export function ownerIdentity(gatewayId: string, senderId: string | null | undefined): string | undefined {
  const who = senderId?.trim();
  if (!who || who === "cli" || who.startsWith("agent:") || who.startsWith("nouride:")) return undefined;
  const platform = gatewayId.split(":")[0];
  return platform ? `${platform}:${who}` : undefined;
}
