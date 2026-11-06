/**
 * Signing in and out, your own password and profile, and the daemon's accounts.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others: `api.x()` reads the same at every call site, and the types stay in `api.ts`,
 * where `scripts/check-wire.ts` compares them with the daemon's.
 */

import { control, post, request } from "./api.client";
import type { Principal, User } from "./api";

export const authApi = {
  login: (username: string, password: string) =>
    post<{ user: User }>(`${control}/auth/login`, { username, password }),

  logout: () => post<{ ok: true }>(`${control}/auth/logout`),

  me: () => request<Principal>(`${control}/auth/me`),

  changePassword: (current: string, next: string) =>
    post<{ ok: true }>(`${control}/auth/password`, { current, next }),

  saveProfile: (input: { username?: string; displayName?: string }) =>
    post<{ ok: true; user: User }>(`${control}/auth/profile`, input),

  /**
   * Turn password sign-in on or off for the whole daemon.
   *
   * Admin only, and live: the login route reads this per request, so the next
   * sign-in — including the caller's next session — obeys it. The daemon
   * refuses to turn it off unless external sign-in has a client secret that
   * actually resolves.
   */
  setPasswordLogin: (enabled: boolean) =>
    post<{ passwordLogin: boolean }>(`${control}/auth/password-login`, { enabled }),

  users: () => request<{ users: User[]; multiUser?: boolean }>(`${control}/users`),

  /**
   * `password` is optional, and omitting it is not the same as sending `""`.
   *
   * Omitted means an account with no password at all — provider sign-in only.
   * An empty string is rejected by the daemon as too short, which is what this
   * used to send and why "add somebody by email" was not expressible.
   */
  createUser: (input: { username: string; password?: string; role: string }) =>
    post<{ user: User }>(`${control}/users`, { ...input, must_change_password: true }),

  deleteUser: (id: string) => request<{ ok: true }>(`${control}/users/${id}`, { method: "DELETE" }),

  setUserRole: (id: string, role: string) => post<{ ok: true }>(`${control}/users/${id}/role`, { role }),
};
