/**
 * Missions (0.8.0): long work an agent finishes alone — one record, and one conversation (`web:mission`, the chat id
 * the mission's id) where it does the work. The record is read here; the conversation through the routes every
 * conversation has, by the `sessionId` a mission's page is handed. Spread into `api`, like the chat's own calls.
 * The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { MissionDetail, MissionEdit, MissionSettings, MissionSettingsPatch, MissionStart, MissionVerb, MissionView } from "@nouride/wire";

export const missionsApi = {
  /**
   * Sorted by the daemon: needs you first, then working, then the rest, newest first within each. 501 without missions.
   * `days`: how far back the ended ones go (0.8.8) — the daemon lists a week unless asked, and a month at most.
   * `whose`: the reader's own unless said; `everyone`, one person's (`person:<key>`) or nobody's (`unknown`), an
   * admin's alone to ask. `elsewhere`: for an admin reading their own, how many more are other people's or nobody's.
   */
  missions: (agent?: string, days?: number, whose = "mine") => {
    const query = new URLSearchParams({ ...(agent ? { agent } : {}), ...(days ? { days: String(days) } : {}), ...(whose !== "mine" ? { whose } : {}) }).toString();
    return request<{ missions: MissionView[]; elsewhere?: number }>(`${control}/missions${query ? `?${query}` : ""}`);
  },

  mission: (id: string) => request<MissionDetail>(`${control}/missions/${encodeURIComponent(id)}`),

  /** 201 with the mission; a refusal (no such agent, no goal, a relative folder) is a 400 whose `error` is a sentence. */
  startMission: (input: MissionStart) => post<{ mission: MissionView }>(`${control}/missions`, input),

  /** A draft changed before it starts (0.8.11); a 409 says why not — it started, or nothing changes. */
  editMission: (id: string, change: MissionEdit) =>
    post<{ mission: MissionView; changed: string[]; briefFailed?: string; plain?: string }>(`${control}/missions/${encodeURIComponent(id)}/edit`, change),

  /** A 409 says why it does not apply now — it ended already, it is not waiting for that. */
  actOnMission: (id: string, verb: MissionVerb, text?: string) =>
    post<{ mission: MissionView; said?: string; plain?: string }>(`${control}/missions/${encodeURIComponent(id)}/${verb}`, text ? { text } : {}),

  /**
   * An ended mission deleted (0.8.13): its record, conversation and own folder. A 409 says why not — it is still open, or
   * its folder holds work nobody committed, which `force` loses.
   */
  deleteMission: (id: string, force = false) =>
    request<{ ok: true; mission: string; turns: number }>(`${control}/missions/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, { method: "DELETE" }),

  missionSettings: () => request<MissionSettings>(`${control}/policy/missions`),

  /** Operators and up. A value outside its bounds is a 400 naming the key and the range; nothing is saved then. */
  setMissionSettings: (patch: MissionSettingsPatch) => post<MissionSettings & { ok: true }>(`${control}/policy/missions`, patch),

  /** One agent's own missions at once (0.8.11). `null` means "follow the daemon". */
  setAgentMissionsPerAgent: (agent: string, perAgent: number | null) => post<{ ok: true }>(`${control}/agents/${agent}/missions`, { perAgent }),
};
