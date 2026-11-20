/** One agent's own settings: the folders it takes project skills from, and the levels its effort is set to. */

import type { LLM_EFFORTS } from "@nouride/shared";

/** A folder an agent takes project skills from, and the skills it brings (0.8.24). */
export interface SkillRoot {
  path: string;
  /** Whether the server can open it now: a repository not cloned yet cannot be. */
  readable: boolean;
  skills: { name: string; description: string }[];
}

/**
 * The levels an agent's effort can be set to, in order. The dashboard offers them, so it keeps a list at runtime,
 * typed as this one: a level the daemon adds and the page lacks fails its typecheck.
 */
export type EffortLevels = typeof LLM_EFFORTS;

/**
 * What deleting an agent would take (`GET /agents/:id/delete`), counted before anybody confirms: what makes it run.
 * Its chats, what it remembered and its records are not in it, since they stay.
 */
export interface AgentDeletion {
  agent: string;
  displayName: string;
  /** Missions of its own still open: stopped first. */
  missions: number;
  /** Background jobs running now: ended first. */
  jobs: number;
  /** Its own automations: deleted. */
  automations: number;
  /** Other agents' automations with a step given to it: turned off, each saying why. */
  handed: number;
  /** The connections only it answers, by id: removed. */
  connections: string[];
  /** Rooms it has a seat in: it leaves them. */
  rooms: number;
  /** Standing permissions for its commands and tools. */
  grants: number;
  /** Stored sign-ins to connectors. */
  signIns: number;
  /** Its own folders (its pack and its private folder, coding CLI sign-ins included): how much they hold. */
  folder: { bytes: number | null; files: number; more: boolean };
  /** Whether it has a user of its own on the machine, which goes with it. */
  account: boolean;
}

/** An agent deleted (`POST /agents/:id/delete`): what went, and what could not. */
export interface AgentDeleted {
  deleted: string;
  /** What `AgentDeletion` counted, as it was taken. */
  took: Omit<AgentDeletion, "agent" | "displayName" | "folder" | "account">;
  /** Its user on the machine: removed, never had one, none on this install, or left behind with why. */
  account: "removed" | "absent" | "none" | "left";
  /** What a person should know and may act on: the account left behind, a folder that could not be emptied. */
  notes: string[];
}

