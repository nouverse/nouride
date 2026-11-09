/**
 * What the daemon says about itself (`/health`, `/status`, `routes/setup.ts`, `routes/auth.ts`): its health, the setup
 * state, the signed-in account, and every agent.
 */

import type { AgentExternal } from "./external-agents.ts";
import type { AgentLook } from "./look.ts";
import type { HelperTrouble } from "./memory.ts";

export interface HealthPayload {
  /** `starting` from the moment the daemon binds its port until its boot is done. */
  status: "starting" | "ok" | "degraded" | "shutting_down";
  /** While starting: what boot is doing — "connecting MCP servers". */
  phase?: string;
  uptime: number;
  version: string;
  /** The event stream's contract version, from 0.7.8 — absent on an older daemon. */
  eventProtocol?: string;
  /**
   * Which build this is — `basic`, `router`, `pro`, or `unknown` for one built from source.
   *
   * Optional because a dashboard can be newer than the daemon it is talking to: an operator
   * who updated the browser tab but not the binary would otherwise see `undefined` rendered.
   */
  edition?: string;
  /** A paired Nouride Box. Absent from a daemon older than the Pro editions, which no Box runs. */
  appliance?: boolean;
  agents: number;
  gateways: Record<string, string>;
  issues?: string[];
  /** The packs that did not load, by id — absent when none failed, and from a daemon older than 0.7.11. */
  failedAgents?: string[];
  /**
   * The image name to move to, where this daemon runs in a container under a name that stops getting updates: what
   * the image sets in `NOURIDE_IMAGE_MOVED_TO`. Absent otherwise, and from a daemon older than the rename.
   */
  imageMovedTo?: string;
}

export interface SetupState {
  hasUser: boolean;
  hasProvider: boolean;
  hasAgent: boolean;
  complete: boolean;
  /**
   * Whether this install has an external identity provider, and what to call it on the button.
   *
   * Optional because a daemon older than the field answers without it, and the login page has to
   * treat that as "no button" rather than as a crash.
   */
  oauth?: { available: boolean; label: string };
  /**
   * The LLM gateway this build carries. `available`: it runs, and `baseUrl` is where (loopback — see
   * `bundled-gateway.ts`). `sharedCredential`: how it came to hold this daemon's admin credential, if it did.
   * `mount`: where its dashboard and API are served through this one; `dashboard`: whether the page can show it.
   *
   * `carried`: the build carries it, on or off — absent from a daemon older than the switch, which offered the gateway
   * only while it ran; then `available` is all there is to go on, and there is no switch to turn. `decidedBy`: the
   * server's environment holds the switch, and the dashboard shows it without being able to move it.
   */
  bundledGateway?: {
    available: boolean;
    baseUrl?: string;
    sharedCredential?: "environment" | "generated";
    mount?: string;
    dashboard?: boolean;
    carried?: boolean;
    decidedBy?: "environment";
  };
  /**
   * Whether to draw the password form.
   *
   * Optional, and **absent must read as true**: a daemon older than the setting
   * says nothing, and a login page with neither a form nor a button is
   * unanswerable.
   */
  passwordLogin?: boolean;
}

/**
 * What each role may do.
 *
 * `viewer` is read-only: it can watch, and that is all. `operator` runs the daemon — chat, approvals,
 * agents, files — but cannot create accounts or hand out roles, because the ability to mint an admin is
 * the ability to become one. `admin` is both.
 */
export type UserRole = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  /** What to call them. Empty means nobody has said — the agent then uses no name at all. */
  displayName: string;
  role: UserRole;
  createdAt: number;
  updatedAt: number;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  /** False for an account added by email alone: it signs in through the provider only. */
  hasPassword?: boolean;
}

export interface Principal {
  kind: "token" | "user";
  role: User["role"];
  actor: string;
  user: User | null;
}

/** A provider profile and a model on it: one of an agent's fallbacks. */
export interface FallbackPair {
  provider: string;
  model: string;
}

export interface AgentSummary {
  id: string;
  /** When the daemon first saw it, ms (0.8.1): the order agents were made in. Null or absent from older daemons. */
  since?: number | null;
  displayName: string;
  /** What it is for, as its peers read it — the `Headline:` line of its IDENTITY.md. Absent from a daemon before 0.7.18. */
  headline?: string | null;
  enabled: boolean;
  state: string;
  /** What it is doing now, and why it could not work if asked. Absent from a daemon before 0.7.18. */
  activity?: {
    activity: "waiting" | "working" | "asleep" | "idle";
    working: { gatewayId: string; chatId: string }[];
    jobs: number;
    /** Missions at work, and missions waiting for a person (0.8.15); absent from an older daemon. */
    missions?: number;
    missionsWaiting?: number;
    waiting: number;
    unavailable: string | null;
  };
  provider: string;
  model: string;
  /** Who answers when the model cannot, in order; empty for none. Absent from a daemon before 0.8.0. */
  fallbacks?: FallbackPair[];
  /**
   * How long its model thinks: `[llm] effort`, else `[llm.defaults] effort`, null for neither; and the install's
   * `[llm.defaults] effort`, which "default" follows. Absent from a daemon before 0.8.17.
   */
  effort?: string | null;
  effortDefault?: string | null;
  /**
   * Its small and high tiers: the pack's own (`own`, null when it inherits) and what it inherits — the install's on
   * the install's provider, else its own model. Absent from a daemon before 0.8.0.
   */
  tiers?: Record<"small" | "high", { own: string | null; inherits: string }>;
  /** What its turns are budgeted at, and where that number comes from. Absent from a daemon before 0.7.13. */
  contextWindow?: { tokens: number; source: "pack" | "gateway" | "table" | "default" };
  tools: string[];
  /** What the pack says. `per-person` means each person's own setting decides. */
  approvals: "per-person" | "careful" | "balanced" | "trusted";
  /** Whether its connections take new senders; `follow` defers to the daemon. Absent from an older daemon. */
  access?: "follow" | "pair" | "allowlist";
  /** Whether, as the orchestrator, it installs the programs every agent runs (0.8.0). Absent before. */
  sharedTools?: boolean;
  /** Its second look (0.8.0): the pack's own `model_guard` or null, and the daemon's. Absent before. */
  secondLook?: { own: string | null; install: string };
  /** This agent's own tool budget, or null when it follows the daemon's. */
  maxToolIterations?: number | null;
  /** Seconds this pack pins, or null when it follows the daemon's clock. */
  maxTurnSeconds?: number | null;
  jobQuietAfterMinutes?: number | null;
  /** Helpers it may have working in the background at once, or null when it follows the daemon's. Absent before 0.7.15. */
  maxBackgroundHelpers?: number | null;
  /** Missions it may have working at once, or null when it follows the daemon's. Absent before 0.8.11. */
  missionsPerAgent?: number | null;
  /** An external agent's coding CLI and the profile it is signed in on (0.8.1). Absent for any other agent. */
  external?: AgentExternal;
  /** The parts of its cat in the Office its pack picks (0.8.1); the rest come from its id. */
  look?: AgentLook;
}

export interface StatusPayload {
  status: string;
  uptime: number;
  configSource: string | null;
  dataDir: string;
  /** Who answers a message that names no agent, and is the front desk of rooms (`[daemon] orchestrator`). */
  orchestrator: string | null;
  agents: AgentSummary[];
  gateways: { id: string; platform: string; status: string }[];
  /** What the helper model's work ran into in the last 24 h — none is none. Absent from a daemon before 0.7.25. */
  helpers?: HelperTrouble[];
}

export interface FileSummary {
  name: string;
  label: string;
  description: string;
  exists: boolean;
  bytes: number;
  modifiedAt: number | null;
}
