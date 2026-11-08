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
}
