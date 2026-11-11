/**
 * The people the agents are told about — `[[people]]`, and the key that gives someone a memory.
 *
 * Split out of `api.ts`, which is over its line budget, when the Memory menu needed `key` here; spread
 * into `api` like the others, so `api.savePerson()` reads the same at every call site.
 */

import { control, post, request } from "./api.client";
import type { PersonRecord, PersonTarget } from "@nouride/wire";

export const peopleApi = {
  /** Who this account is to the agents, and whether that is the owner. */
  peopleMe: () => request<{ person: PersonRecord | null }>(`${control}/people/me`),
  /** Say who this account is. An admin's; the first one becomes the owner when there is none. */
  linkMe: (target: PersonTarget) => post<{ person: PersonRecord }>(`${control}/people/me`, target),
  /** Say who another account is. An admin's. */
  linkUser: (user: string, target: PersonTarget) => post<{ person: PersonRecord }>(`${control}/people/link`, { user, ...target }),
  people: () => request<{ people: PersonRecord[] }>(`${control}/people`),
  /**
   * `notes` and `ids` follow the daemon's three cases: omit to keep whatever is there, empty to clear
   * it, a value to set it. Sending `ids` replaces the list rather than adding to it — which is what
   * makes removing an address possible from here at all. `expectedNotes` and `expectedIds`, what an
   * edit started from, have a save refused (409) when they changed meanwhile.
   *
   * `key` names who: somebody in People, or — with `create` — the key a new person gets, refused when
   * somebody holds it. `create` without a key makes one from the name.
   */
  savePerson: (person: { key?: string; name: string; notes?: string; expectedNotes?: string; ids?: string[]; expectedIds?: string[]; create?: boolean }) =>
    post<{ ok: boolean; person: PersonRecord; people: PersonRecord[] }>(
      `${control}/people`,
      person,
    ),
  /**
   * A person's morning line: a time of day, or null for none (0.8.0), and where it goes — one of their chat accounts, or
   * null for wherever they last wrote from; left out, it stays. An admin's.
   */
  setMorningLine: (key: string, at: string | null, to?: string | null) =>
    post<{ ok: true; at: string | null; to: string | null }>(`${control}/people/${encodeURIComponent(key)}/morning`, { at, ...(to !== undefined ? { to } : {}) }),
  deletePerson: (key: string) =>
    request<{ ok: boolean; people: PersonRecord[]; tokensRevoked: number }>(
      `${control}/people?key=${encodeURIComponent(key)}`,
      { method: "DELETE" },
    ),
};
