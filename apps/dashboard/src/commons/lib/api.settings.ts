/**
 * The daemon-wide settings the dashboard edits: connections, provider profiles, exec and spend policy,
 * mentions, group context, `config.toml` itself, and the restart that applies them.
 *
 * Split out of `api.ts`, which had grown past the size cap with every endpoint group inline, and spread
 * into `api` like the others, so `api.x()` reads the same at every call site. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { GatewayInstance, ProviderProfileView } from "@nouride/wire";

export const settingsApi = {
  gateways: () =>
    request<{ gateways: GatewayInstance[]; editable: boolean; groupContextDefault?: number }>(
      `${control}/gateways`,
    ),

  groupContext: () =>
    request<{ messages: number; editable: boolean }>(`${control}/group-context`),

  setGroupContext: (messages: number) =>
    post<{ ok: true; restartRequired: boolean }>(`${control}/group-context`, { messages }),

  spendPolicy: () =>
    request<{
      maxDailyCostUsd: number;
      alertThresholdPct: number;
      /** Null when nothing records usage, which is not the same as a quiet day. */
      spentTodayUsd: number | null;
      unpricedRequests: number;
      editable: boolean;
    }>(`${control}/policy/spend`),

  setDailyCostCap: (maxDailyCostUsd: number) =>
    post<{ ok: true; maxDailyCostUsd: number }>(`${control}/policy/spend`, { maxDailyCostUsd }),

  mentionSettings: () =>
    request<{ mentionsEnabled: boolean; mentionMaxHops: number; editable: boolean }>(
      `${control}/mentions`,
    ),

  setMentionSettings: (input: { mentionsEnabled?: boolean; mentionMaxHops?: number }) =>
    post<{ ok: true; mentionsEnabled: boolean; mentionMaxHops: number }>(
      `${control}/mentions`,
      input,
    ),

  saveGateway: (input: {
    platform: string;
    name: string;
    enabled: boolean;
    token?: string;
    agent?: string;
    sessionDir?: string;
    groupContextMessages?: number;
  }) => post<{ ok: true; restartRequired: boolean }>(`${control}/gateways`, input),

  deleteGateway: (id: string) =>
    // `restartRequired` unless the daemon could take the connection down itself.
    request<{ ok: true; restartRequired?: boolean }>(`${control}/gateways/${encodeURIComponent(id)}`, { method: "DELETE" }),

  pairing: (id: string) =>
    request<{ status: string; linked: boolean; qr: string | null; at?: number }>(
      `${control}/gateways/${encodeURIComponent(id)}/pairing`,
    ),

  providers: () =>
    request<{ providers: ProviderProfileView[]; editable: boolean }>(`${control}/providers`),

  saveProviderProfile: (input: {
    name: string;
    kind: string;
    baseUrl: string;
    apiKey?: string;
  }) => post<{ ok: true; restartRequired: boolean }>(`${control}/providers`, input),

  deleteProvider: (name: string) =>
    request<{ ok: true }>(`${control}/providers/${encodeURIComponent(name)}`, { method: "DELETE" }),

  /** `plain`: what a failed probe means, in the page's words (0.8.20); `error` is the server's own, for Details. */
  probe: (input: { kind: string; baseUrl: string; apiKey: string }) =>
    post<{ ok: boolean; models: string[]; error?: string; plain?: string }>(`${control}/providers/probe`, input),

  providerModels: (name: string) =>
    request<{ ok: boolean; models: string[]; error?: string; plain?: string }>(`${control}/providers/${encodeURIComponent(name)}/models`),

  /**
   * Answers at once; the daemon restarts once nothing is running — or at once, with `now`. Followed back by `restart.ts`.
   * `plain`: when it restarts, in the page's words (0.8.20); absent from an older daemon, whose `note` is said instead.
   */
  restartDaemon: (options: { now?: boolean } = {}) => post<{ ok: boolean; waiting: boolean; note: string; plain?: string }>(`${control}/restart`, options),

  readConfig: () => request<{ content: string; path: string }>(`${control}/config`),

  // `expected`: the text it was opened with. A file changed since — a card saved, an agent's notes written — is
  // refused with a 409 rather than overwritten by a tab left open.
  writeConfig: (content: string, expected?: string) =>
    post<{ ok: true; restartRequired: true }>(`${control}/config`, { content, expected }),
};
