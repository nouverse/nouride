/**
 * What the engine needs from `nouride-update`, declared here rather than imported.
 *
 * The same choice — and the same reasons — as `gateways/wa-bridge.d.ts`, `users/oauth.d.ts` and
 * `users/nouride-multi-user.d.ts`: a path mapping would drag the plugin's source into this
 * project's program, and it would make an optional component required.
 *
 * "Optional" is doing less work here than for the other three — every edition links this one —
 * but the resolution is still dynamic, so a build with a dropped symlink has to degrade rather
 * than fail to start. `assertEmbedded` in `scripts/build/core.ts` asserts the marker so that build does not get made.
 *
 * `scripts/check-seams.ts` (`bun run lint:seams`) compiles the plugin's module against everything
 * below — each function's parameters and result, each type — and fails on any difference.
 * `apps/engine/tests/daemon/update-external.test.ts` checks how the engine reaches it.
 */

declare module "nouride-update" {
  /** Value: "update provider active in this daemon process". The build assertion marker. */
  export const UPDATE_CAPABILITY: string;

  /** Called by the boot resolver; also what keeps the marker alive through minification. */
  export function verifyUpdateProvider(): string;

  export type Edition = "basic" | "router" | "pro";

  /** Everything the plugin needs to know about this install to decide anything. */
  export interface InstallFacts {
    version: string;
    edition: Edition;
    installDir: string;
    installDirWritable: boolean;
    supervisor: string;
    restartsOnExit: boolean;
    compiled: boolean;
    platform: string;
    arch: string;
    musl: boolean;
  }

  /** What an update would do here, or why it cannot and what to do instead. */
  export type UpdatePlan =
    | {
        can: true;
        from: string;
        to: string;
        artifact: string;
        tarballUrl: string;
        checksumUrl: string;
        checksumFile: string;
        /** The checksum file's signature, when the source publishes one. */
        signatureUrl?: string;
      }
    | { can: false; from: string; to: string; reason: string; instead: string[] };

  export interface UpdateCheck {
    current: string;
    /** The newest release carrying a build for *this* edition. Not simply the newest tag. */
    latest: string;
    newer: boolean;
    /** The track the check followed (`[update] track`); `latest` is the newest release on it. */
    track: UpdateTrack;
    /** The newest release on the other track, when it is newer than this version and is not `latest`. */
    otherTrack?: { track: UpdateTrack; tag: string };
    publishedAt: string | null;
    notesUrl: string | null;
    /** A newer tag that exists and that this install cannot take. */
    latestElsewhere?: string;
    /** Why it is not on offer, in a sentence a person can read. */
    blockedReason?: string;
    /** Set when the channel could not be reached and this is the last answer it gave. */
    stale?: string;
    /** What the channel says about this install that is not an outage: a licence whose updates ended. */
    notice?: string;
    plan?: UpdatePlan;
    /** The newest release for this edition needs a newer version first; `latest` is then the stepping stone. */
    floor?: UpdateFloor;
  }

  /** A release this install cannot take until `needs` has run, and the sentence that says so. */
  export interface UpdateFloor {
    release: string;
    needs: string;
    message: string;
  }

  /** A published release, as a source describes it. */
  export interface Release {
    tag: string;
    publishedAt: string | null;
    notesUrl: string | null;
    assets: string[];
  }

  /**
   * Where releases come from. The public GitHub mirror unless something — the appliance plugin, on a
   * Device build — supplies another. It answers *where*; the plugin still decides *whether*.
   */
  export interface ReleaseSource {
    readonly name: string;
    /** Whether `releases()` is everything the channel publishes — the public mirror's is; a box's is what it is offered. */
    readonly complete?: boolean;
    releases(options?: { force?: boolean; track?: UpdateTrack }): Promise<Release[]>;
    tarballUrl(tag: string, artifact: string): string;
    checksumUrl(tag: string, checksums: string): string;
    signatureUrl?(tag: string, checksums: string): string;
    staleness(): string | null;
    notice?(): string | null;
  }

  export function githubSource(channel?: ReleaseChannel): ReleaseSource;

  /** `latest`: the newest release. `lts`: the first long-term line at or above this one (0.8.18, PLAN §3.3). */
  export type UpdateTrack = "latest" | "lts";

  export function checkForUpdate(options: {
    facts: InstallFacts;
    /** Where releases come from; the public GitHub channel when absent. */
    source?: ReleaseSource;
    /** Which releases this install follows; `latest` when absent. */
    track?: UpdateTrack;
    /** Skip the plugin's five-minute channel cache. What "Check again" passes. */
    force?: boolean;
  }): Promise<UpdateCheck>;

  export type DownloadStatus = "idle" | "downloading" | "paused" | "ready" | "failed";

  export interface DownloadSnapshot {
    status: DownloadStatus;
    received: number;
    total: number | null;
    tag: string | null;
    artifact: string | null;
    path: string | null;
    error: string | null;
  }

  /** One transfer at a time, resumable, held for as long as the process lives. */
  export class ReleaseDownload {
    snapshot(): DownloadSnapshot;
    start(request: {
      installDir: string;
      url: string;
      tag: string;
      artifact: string;
      fetchImpl: typeof fetch;
    }): Promise<DownloadSnapshot>;
    pause(): DownloadSnapshot;
    discard(): Promise<DownloadSnapshot>;
    settle(): Promise<DownloadSnapshot>;
  }

  export interface ApplyReport {
    replaced: string[];
    backupDir: string;
    bytes: number;
    sha256: string;
  }

  export interface ReleaseChannel {
    downloadBase: string;
    releasesUrl: string;
  }

  /** `SHA256SUMS`, or `SHA256SUMS-<variant>`. Null for an edition with no tarball. */
  export function checksumName(edition: Edition, tag: string): string | null;
  /** A private edition's release always; a public one's from 0.7.4 on, when `tag` says which. */
  export function requiresSignature(edition: Edition, tag?: string): boolean;

  export function checksumUrl(channel: ReleaseChannel, tag: string, checksums: string): string;

  /** Verify what was downloaded, then swap it in. Does not restart anything. */
  export function installStaged(input: {
    installDir: string;
    tarball: string;
    /** The names to swap: `SWAPPED`, which the unit's guard and `--rollback` put back. Nothing else is moved. */
    swap: readonly string[];
    checksumUrl: string;
    artifact: string;
    /** Required for the private editions: installs only a checksum file Nouverse signed. */
    signatureUrl?: string;
    edition?: Edition;
    /** The release — with the edition, whether a signature is required. */
    tag?: string;
    /** The version installing it: a release whose upgrade floor is above it is refused. */
    from?: string;
    fetchImpl: typeof fetch;
  }): Promise<ApplyReport>;
}
