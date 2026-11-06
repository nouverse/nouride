/**
 * The first-run wizard's calls.
 *
 * A distinct flow: two pages reach these and nothing else does, they run once on a fresh install,
 * and none of them exist after it. Spread into `api` rather than imported separately by those pages,
 * so `api.setupState()` still reads the same at every call site — the split is about where the lines
 * live, not about making callers name a second client.
 */

import { control, post, request } from "./api.client";
import type { SetupState } from "./api";
import type { PresetId } from "./api.agent-tools";

export const setupApi = {
  setupState: () => request<SetupState>(`${control}/setup/state`),
  probeProvider: (input: { kind: string; base_url: string; api_key: string }) =>
    post<{ ok: boolean; models: string[]; error?: string; plain?: string }>(`${control}/setup/probe`, input),
  saveProvider: (input: { kind: string; name?: string; base_url: string; api_key: string; skip_probe?: boolean }) =>
    post<{ ok: true; models: string[] }>(`${control}/setup/provider`, input),
  setupModels: () => request<{ ok: true; models: string[] }>(`${control}/setup/models`),
  /**
   * Point the daemon at the gateway it hosts — the key is minted there, never typed or shown. Answers
   * the models the signed-in accounts can serve, for the agent step.
   */
  connectBundledGateway: () => post<{ ok: true; models: string[] }>(`${control}/setup/gateway`, {}),
  createAgent: (input: {
    id: string;
    display_name: string;
    system_prompt: string;
    model: string;
    /**
     * Which profile the model runs on.
     *
     * The daemon has accepted this since the endpoint was written and no dashboard ever sent it, so
     * a new agent silently landed on whichever profile happened to resolve first — and the model you
     * typed had to exist there or the first turn failed with a 404 from a provider you never chose.
     */
    provider?: string;
    /** One short line for its peers and the Agents list. Absent or blank is its preset's. Absent before 0.7.18. */
    headline?: string;
    allow_exec?: boolean;
    auto_on?: boolean;
    /** What it starts as; absent is Pilot, which is what the wizard makes. */
    preset?: PresetId;
    /** For `custom`: the tools picked. */
    tools?: string[];
    /** An external agent (0.8.1): the coding CLI that answers it, and the profile it signs in on. */
    external?: { cli: string; profile?: string };
  }) => post<{ ok: true; id: string; provider: string }>(`${control}/setup/agent`, input),
};
