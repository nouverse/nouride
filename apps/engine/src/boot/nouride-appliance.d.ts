/**
 * What the engine needs from `nouride-appliance`, declared here rather than imported.
 *
 * The same choice — and the same two reasons — as `users/nouride-multi-user.d.ts` and
 * `users/oauth.d.ts`:
 *
 * - A path mapping would drag the plugin's source into this project's program, so the engine's
 *   typecheck would start reporting the plugin's problems as its own.
 * - It would make the plugin **required**. Every edition but Pro is compiled with
 *   `--external nouride-appliance`, and an optional component must never become a required one.
 *
 * `scripts/check-seams.ts` (`bun run lint:seams`) compiles the plugin's module against everything
 * below — the runner's methods, the report's fields, the options — and fails on any difference, so
 * the duplication cannot drift silently. It skips when `internals/pro` is not checked out.
 */

declare module "nouride-appliance" {
  /**
   * Human-readable capability description used as the build assertion marker.
   * Value: "appliance pairing and licensing active in this daemon process"
   */
  export const APPLIANCE_CAPABILITY: string;

  /** Verification function called by the engine's boot resolver. */
  export function verifyApplianceEdition(): string;

  /** A line the plugin wants in the daemon log. The plugin cannot reach the logger itself. */
  export type ApplianceEvent = {
    level: "info" | "warn" | "error";
    message: string;
    data?: Record<string, unknown>;
  };

  /** What `/health` and the dashboard are told about this box. */
  export interface ApplianceReport {
    deviceId: string;
    claimed: boolean;
    claimUrl?: string;
    license: "absent" | "valid" | "hardware_mismatch" | "invalid";
    fingerprintQuality: "strong" | "weak";
    lastSyncAt: number | null;
    issues: string[];
  }

  export interface ApplianceRunner {
    report(): ApplianceReport;
    /** One sync, returning the seconds until the next one and whatever deserves a log line. */
    sync(): Promise<{ nextInSeconds: number; events: ApplianceEvent[] }>;
    /**
     * One step of the box's local work: Wi-Fi onboarding where the board has Wi-Fi, and on every board the upkeep
     * that must not depend on it — the local names, settling this power-up, the lines the dashboard caused. Null ends
     * the loop; this plugin no longer answers it.
     */
    onboard(): Promise<{ nextInSeconds: number; events: ApplianceEvent[] } | null>;
    /** The dashboard's My Box API; the engine forwards `/api/control/appliance/*` here for admins. */
    handle(request: Request): Promise<Response>;
    /*
     * The update half, required. The plugin is compiled into the binary that reads it, from the commit the release
     * pins, so an older plugin never meets this engine — and the optional shape cost something: a missing
     * `syncedSinceBoot` was taken as proof that a new version is alive.
     */
    /**
     * Where this box gets its releases: the Nouverse service's update gate and short-lived storage
     * URLs, instead of the public GitHub mirror that carries no Pro build.
     */
    releaseSource(): import("nouride-update").ReleaseSource;
    /** Tell the fleet what happened to an update. Best effort. */
    reportUpdate(report: {
      tag: string;
      outcome: "installed" | "rolled_back" | "failed_download" | "failed_verify" | "failed_install";
      reason?: string;
    }): Promise<void>;
    /** Whether the owner lets the box install updates by itself, overnight. */
    updatePolicy(): { automatic: boolean };
    /** Whether Nouverse marked this offered release critical: install at once, whatever the hour. */
    isCritical(tag: string): boolean;
    /** Whether the service has answered a sync since this process started. */
    syncedSinceBoot(): boolean;
  }

  /**
   * Load this box's identity and licence, or null when there is no `device.json`.
   *
   * Schedules nothing: the engine owns the timer, because the engine owns shutdown.
   */
  export function createAppliance(options: {
    dataDir: string;
    version: string;
    /**
     * What the engine knows about this install, so the plugin does not work it out again: `[dashboard] port`, the
     * hosted gateway's port (null when there is none), the install directory, and the build target this machine
     * takes (null where none is built). Worked out in the plugin, an owner who moved the dashboard got links that
     * pointed at the old port.
     */
    dashboardPort: number;
    gatewayPort: number | null;
    installDir: string;
    target: string | null;
    /** This daemon's dashboard accounts, reset by the daemon: the setup console's reset asks it, not the database. */
    accounts: { reset(): Promise<number> };
    /**
     * The gateway hosted in this process, when there is one (Pro, with `[nougate] in_process` on): the setup console's
     * account reset asks it to reset its own accounts rather than opening its database.
     */
    gateway?: { resetAccounts(): Promise<number> };
  }): {
    runner: ApplianceRunner;
    events: ApplianceEvent[];
  } | null;
}
