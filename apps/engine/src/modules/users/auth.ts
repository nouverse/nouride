/**
 * Who is making this request, and what they are allowed to do.
 *
 * Two credentials reach the same routes. The **control token** is a machine credential: `0640` on disk,
 * readable by the service group so its members run the CLI without sudo (`web/control/token.ts`), and it
 * stands for the operator of the host — there is nothing above it to check against, so it is treated as an
 * admin. A **session cookie** is a person, with a role attached.
 *
 * One guard rather than two route trees. A second copy of the routes behind a different guard is how
 * one copy ends up missing a check, and the copy that is missing it is never the one anybody reviews.
 */


import { timingSafeEqual } from "@nouride/runtime";
import type { UserRole } from "@nouride/wire";
import type { UserRecord, UsersPort } from "@/modules/users/users.store.ts";

export const SESSION_COOKIE = "nouride_session";

export interface Principal {
  kind: "token" | "user";
  /** For the audit log: `cli` for the control token, the username for a person. */
  actor: string;
  role: UserRole;
  user?: UserRecord;
}

/** Ranked, so a check is "at least this" rather than a list of accepted roles at every call site. */
const RANK: Record<UserRole, number> = { viewer: 0, operator: 1, admin: 2 };

export function atLeast(principal: Principal, role: UserRole): boolean {
  return RANK[principal.role] >= RANK[role];
}

/**
 * Read one cookie out of a header.
 *
 * Hand-rolled because the alternative is a dependency for fifteen tokens of parsing. Values are
 * compared, never interpolated anywhere, so the only property that matters is not confusing
 * `nouride_session_x` with `nouride_session`.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, expiresAt: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax rather than Strict: the dashboard is opened by following a link from a terminal or a README,
    // and Strict drops the cookie on that first cross-site navigation — which reads as "it logged me
    // out" on the one visit where the operator is least sure the thing works.
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    // Only over TLS when the request arrived over TLS. Setting it unconditionally would break every
    // plain-HTTP install, which is what `docker compose up` on a laptop produces.
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearedSessionCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Identify the caller, or null.
 *
 * The control token is compared in constant time via `timingSafeEqual` to prevent a network
 * attacker from recovering it character-by-character through timing measurements.
 */
export function identify(input: {
  tokenHeader: string | undefined;
  cookieHeader: string | undefined;
  controlToken: string;
  users?: UsersPort;
}): Principal | null {
  // Both guards are on the *buffers*, not the strings: `timingSafeEqual` throws on a length mismatch
  // rather than answering false, and a header of multibyte characters can match the token's string
  // length while being longer in bytes — which would turn a bad token into a thrown request instead of
  // a rejected one. The length is not the secret, so leaking it through an early return costs nothing.
  const provided = Buffer.from(input.tokenHeader ?? "");
  const expected = Buffer.from(input.controlToken);
  if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
    return { kind: "token", actor: "cli", role: "admin" };
  }

  const token = readCookie(input.cookieHeader, SESSION_COOKIE);
  if (!token || !input.users) return null;

  const user = input.users.sessionUser(token);
  if (!user) return null;

  return { kind: "user", actor: user.username, role: user.role, user };
}
