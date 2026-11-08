/**
 * My Box: this Nouride Box's link to a Nouverse account, served by the appliance plugin (`scripts/check-seams.ts`
 * holds `BoxState` to the plugin's own).
 */

export interface BoxState {
  deviceId: string;
  edition: string | null;
  claimed: boolean;
  license: "absent" | "valid" | "hardware_mismatch" | "invalid";
  features: string[];
  owner: { email: string; name: string } | null;
  claimedAt: string | null;
  fingerprintQuality: "strong" | "weak";
  lastSyncAt: number | null;
  lastSync: "active" | "awaiting_claim" | "suspended" | "unauthorized" | "rate_limited" | "unreachable" | null;
  network: { lanIp: string | null; dashboardUrl: string | null };
  setup: { ssid: string; wifiQr: string };
  claimLink: { url: string; expiresAt: number } | null;
  appUrl: string;
  /** The box's setup console sign-in — the card's until changed there. */
  setupLogin: { username: string; cardDefault: boolean };
  /** `nouride.local`, and `nougate.local` where the gateway runs. */
  localNames: string[];
  /** Whether the setup hotspot is up, and its name. */
  setupHotspot: { open: boolean; ssid: string };
  /** Whether the box installs updates by itself, overnight. */
  updates: { automatic: boolean };
}

export interface ClaimLink {
  url: string;
  expiresAt: number;
}
