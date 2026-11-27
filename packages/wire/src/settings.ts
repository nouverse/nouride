/**
 * The daemon-wide settings the dashboard edits (`routes/gateways.ts`, `routes/providers.ts`): connections and provider
 * profiles.
 */

export interface GatewayInstance {
  id: string;
  platform: "telegram" | "discord" | "whatsapp";
  name: string;
  enabled: boolean;
  tokenSecret: string;
  agent?: string;
  /** Live connection state, or null for an instance added since the last restart. */
  status: string | null;
  /** What it waits on while it is not connected, where that is known: the reason as a sentence, and when the platform said to come back. */
  waiting?: { reason: string; since: number; until?: number };
  hasCredential: boolean;
  sessionDir?: string;
  /** Per-connection override for `[agents] group_context_messages`. Absent means it inherits. */
  groupContextMessages?: number;
}

export interface ProviderProfileView {
  name: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  apiKeySecret: string;
  hasCredential: boolean;
  builtIn: boolean;
  /** Its extra headers by name. A saved value is `null`, never sent, but for `{session}`: the one that is no secret. */
  headers: Record<string, string | null>;
  /**
   * On the gateway this build carries (Nougate): off, on with no account signed in there, or ready. Absent for any
   * other profile. An agent's model picker offers one only when it is ready.
   */
  bundled?: "off" | "no-account" | "ready";
}
