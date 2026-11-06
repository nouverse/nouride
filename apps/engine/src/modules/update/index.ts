/**
 * Keeping this daemon current: the seam, and nothing else.
 *
 * Where the version comes from, which release is for this edition, how a download is resumed,
 * what is verified and in what order files are swapped all live in `packages/update`. What is
 * here is the part that has to be in the engine because it is about *this process*: gathering
 * the facts, resolving the plugin once, holding the one transfer in flight — and the part that
 * must never move, which is the approval.
 *
 * ## The approval is not the plugin's to grant
 *
 * An update runs a binary fetched over the network as this daemon's own user, and then ends the
 * process. That is the largest thing an agent can ask for, so it is on `@nouride/policy`'s fixed list as `replace`:
 *
 * - asked every time under `careful`, which a new install writes
 * - never grantable, so `allow-always` cannot turn it into a standing permission
 * - refused outright when there is nobody to ask and the level does not answer it, rather than proceeding
 *
 * Keeping that in the engine rather than in the plugin is the point: a plugin edit could
 * otherwise quietly widen the one gate that stands in front of replacing the binary.
 */

import { createLogger } from "@nouride/shared";
import { gatherInstallFacts } from "@/modules/update/facts.ts";
import { markPendingUpdate } from "@/modules/update/confirm.ts";
import { SWAPPED } from "@/service/update-guard.ts";
import { recordKeptBuild } from "./rollback.ts";

export { installDirFor } from "@/modules/update/facts.ts";

const log = createLogger("update");

type UpdateModule = typeof import("nouride-update");

let provider: UpdateModule | null = null;

/**
 * Where releases come from, when something other than the public GitHub mirror should answer.
 *
 * Null on every public edition, which is what keeps them on GitHub. A Device build's appliance
 * plugin sets it through the engine seam: its source
 * asks the Nouverse service and downloads from short-lived storage URLs. Nothing about verifying
 * or swapping changes with it — those stay the update plugin's.
 */
let releaseSource: import("nouride-update").ReleaseSource | null = null;

export function setReleaseSource(source: import("nouride-update").ReleaseSource | null): void {
  releaseSource = source;
}

/**
 * Which releases this install follows, `[update] track` (0.8.18, PLAN §3.3), read at each check so a save on the
 * dashboard counts at the next one. `latest` until boot hands over the running config.
 */
let trackOf: () => import("nouride-update").UpdateTrack = () => "latest";

export function followUpdateTrack(read: () => import("nouride-update").UpdateTrack): void {
  trackOf = read;
}

/** The source in force: the one set above, else the plugin's own GitHub source. */
function activeSource(mod: UpdateModule): import("nouride-update").ReleaseSource {
  return releaseSource ?? mod.githubSource();
}

export type UpdateCheck = Awaited<ReturnType<UpdateModule["checkForUpdate"]>>;
export type UpdatePlan = NonNullable<UpdateCheck["plan"]>;
export type ApplyReport = Awaited<ReturnType<UpdateModule["installStaged"]>>;
export type DownloadSnapshot = ReturnType<InstanceType<UpdateModule["ReleaseDownload"]>["snapshot"]>;

/**
 * The one transfer, held for as long as the process lives.
 *
 * Deliberately not in the database. A `.part` file that outlives a restart is resumable by
 * looking at it; a *status* that outlived a restart would claim a transfer is running when the
 * thing running it is gone.
 */
let download: InstanceType<UpdateModule["ReleaseDownload"]> | null = null;

/**
 * Resolve the plugin once, at boot.
 *
 * Every edition links it, so a failure here is a broken build rather than a mode —
 * `assertEmbedded` in `scripts/build/core.ts` asserts the marker for exactly that reason. It is still dynamic and still
 * caught, because a daemon that cannot check for updates should carry on serving chat.
 */
export async function resolveUpdateProvider(): Promise<boolean> {
  try {
    const mod = await import("nouride-update");
    provider = typeof mod.verifyUpdateProvider === "function" && mod.verifyUpdateProvider() ? mod : null;
    if (provider) download = new provider.ReleaseDownload();
  } catch {
    provider = null;
  }
  if (!provider) {
    log.warn("this build cannot check for updates", {
      hint: "packages/update did not resolve: the binary was built without it",
    });
  }
  return provider !== null;
}

export function updateSupported(): boolean {
  return provider !== null;
}

/** What this daemon is, in the shape the plugin and the dashboard both read. */
export async function describeInstall(dataDir: string): ReturnType<typeof gatherInstallFacts> {
  return await gatherInstallFacts(dataDir);
}

class UpdatesUnavailable extends Error {
  override name = "UpdatesUnavailable";
  constructor() {
    super("this build cannot check for updates: it was built without the update provider");
  }
}

function required(): UpdateModule {
  if (!provider) throw new UpdatesUnavailable();
  return provider;
}

/**
 * Is there something newer *for this edition*, and could this install take it?
 *
 * Served from the plugin's five-minute cache unless `force`. That cache is not an optimisation:
 * the dashboard polls this once a second while a download runs, and the unauthenticated GitHub
 * API allows sixty requests an hour.
 */
export async function checkForUpdate(dataDir: string, force = false): Promise<UpdateCheck> {
  const mod = required();
  return await mod.checkForUpdate({ facts: await gatherInstallFacts(dataDir), force, source: activeSource(mod), track: trackOf() });
}

/** Where the transfer has got to. `idle` in a build with no provider, rather than an error. */
export function downloadState(): DownloadSnapshot {
  if (!download) {
    return { status: "idle", received: 0, total: null, tag: null, artifact: null, path: null, error: null };
  }
  return download.snapshot();
}

/**
 * Start, or pick up where a pause left off.
 *
 * Re-checks rather than trusting anything the caller is holding: between one press and the next
 * the release can move, and a resume that appended a different version to the same file would
 * produce something that passes no checksum and explains nothing. The plugin compares the tag
 * and starts again when it differs, which it can only do if it is told the current one.
 */
export async function startDownload(dataDir: string): Promise<{ check: UpdateCheck; download: DownloadSnapshot }> {
  const mod = required();
  const facts = await gatherInstallFacts(dataDir);
  const check = await mod.checkForUpdate({ facts, source: activeSource(mod), track: trackOf() });

  if (!check.newer || !check.plan) throw new Error(`already on the newest release for this edition (${check.current})`);
  if (!check.plan.can) throw new Error(`${check.plan.reason}. Instead: ${check.plan.instead.join(" ; ")}`);

  const plan = check.plan;
  log.info("downloading update", { from: plan.from, to: plan.to, artifact: plan.artifact });
  const snapshot = await download!.start({
    installDir: facts.installDir,
    url: plan.tarballUrl,
    tag: plan.to,
    artifact: plan.artifact,
    fetchImpl: fetch,
  });
  return { check, download: snapshot };
}

export function pauseDownload(): DownloadSnapshot {
  return download ? download.pause() : downloadState();
}

export async function discardDownload(): Promise<DownloadSnapshot> {
  return download ? await download.discard() : downloadState();
}

/** For the agent's one-shot path: wait for the transfer in flight. */
async function settleDownload(): Promise<DownloadSnapshot> {
  return download ? await download.settle() : downloadState();
}

/**
 * Verify what was downloaded and swap it in.
 *
 * Does not restart anything — `self-update.ts` owns that, because the follow-up turn has to be
 * armed between the swap and the exit and that ordering is the safety property.
 *
 * Refuses a staged file that is not for the release this install would take now. A `.part`
 * finished against v0.3.3 and installed after v0.3.4 appeared would put the wrong version on
 * disk and report the right one.
 */
export async function installDownloaded(dataDir: string): Promise<{ report: ApplyReport; plan: UpdatePlan }> {
  const mod = required();
  return await installStagedDownload({
    mod,
    source: activeSource(mod),
    facts: await gatherInstallFacts(dataDir),
    download: download ?? { snapshot: downloadState, discard: async () => downloadState() },
    fetchImpl: fetch,
  });
}

/**
 * Its own refusal, which `installStagedDownload` must not mistake for a check that could not be made: what is on
 * disk is not the release this install would take now. It was told apart by a regex on the message, so rewording
 * the sentence would have turned a refusal into "installing without a fresh check".
 */
class StagedReleaseRefused extends Error {
  override name = "StagedReleaseRefused";
}

/** What `installStagedDownload` reads: the plugin, where releases come from, this install, and the transfer. */
export interface StagedInstallDeps {
  mod: Pick<UpdateModule, "checkForUpdate" | "installStaged" | "checksumName" | "requiresSignature">;
  source: import("nouride-update").ReleaseSource;
  facts: Awaited<ReturnType<typeof gatherInstallFacts>>;
  download: { snapshot(): DownloadSnapshot; discard(): Promise<unknown> };
  fetchImpl: typeof fetch;
}

/**
 * `installDownloaded`, with what it reads handed in: four decisions and two side effects, each of which used to be
 * reachable only through the process's one provider and one transfer — so none was tested.
 */
export async function installStagedDownload(deps: StagedInstallDeps): Promise<{ report: ApplyReport; plan: UpdatePlan }> {
  const { mod, facts } = deps;
  const staged = deps.download.snapshot();
  if (staged.status !== "ready" || !staged.path || !staged.tag || !staged.artifact) {
    throw new StagedReleaseRefused("nothing has been downloaded yet: start the download first");
  }

  /**
   * The re-check is a staleness guard, not a precondition.
   *
   * It exists so a `.part` finished against v0.3.3 is not installed after v0.3.4 appeared. But
   * a *failed* check is not evidence of staleness, and refusing on it means a rate-limited API
   * can block an install whose file is already on disk and whose checksums live on a different
   * host entirely. That happened: a finished download answered "the release channel answered
   * 403" instead of installing.
   *
   * So a check that answers is obeyed, and a check that cannot be made is noted and stepped
   * over. What is installed was verified as newer when it was downloaded, and it is verified
   * again by checksum before anything moves.
   *
   * Obeyed when it answers "this install cannot take it", too. That answer used to fall through to the install, so
   * a download finished before the service was removed swapped the binary and then exited with nothing to start it
   * again: the stop the plan refuses to call an update.
   */
  let plan: UpdatePlan | null = null;
  try {
    const check = await mod.checkForUpdate({ facts, source: deps.source, track: trackOf() });
    if (check.newer && check.plan?.can) {
      if (check.plan.to !== staged.tag) {
        throw new StagedReleaseRefused(
          `the downloaded release is ${staged.tag}, and the newest is now ${check.plan.to}: download again`,
        );
      }
      plan = check.plan;
    } else if (check.newer && check.plan && !check.plan.can) {
      throw new StagedReleaseRefused(`${check.plan.reason}. Instead: ${check.plan.instead.join(" ; ")}`);
    } else if (!check.newer) {
      throw new StagedReleaseRefused(`there is nothing to install: this install is on ${check.current}`);
    }
  } catch (err) {
    // A refusal is this function's own and must not be swallowed by the fallback.
    if (err instanceof StagedReleaseRefused) throw err;
    log.warn("installing without a fresh check", {
      staged: staged.tag,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  const checksumFile = plan ? plan.checksumUrl : stagedChecksumUrl(mod, deps.source, facts, staged.tag);
  const signatureUrl = plan?.can ? plan.signatureUrl : stagedSignatureUrl(mod, deps.source, facts, staged.tag);
  const report = await mod.installStaged({
    installDir: facts.installDir,
    tarball: staged.path,
    // What the unit's guard and `--rollback` put back, handed over so the plugin swaps exactly that.
    swap: SWAPPED,
    checksumUrl: checksumFile,
    artifact: staged.artifact,
    ...(signatureUrl ? { signatureUrl } : {}),
    // Which edition and release decide whether a signature is required — a private edition's always, a public one's
    // from 0.7.4 — and the plugin refuses one that must be signed and is not.
    edition: facts.edition,
    tag: staged.tag,
    // A release whose upgrade floor is above this version is refused from its signed checksum file, whatever the
    // check said — including when no fresh check could be made.
    from: facts.version,
    fetchImpl: deps.fetchImpl,
  });
  log.info("update installed", { replaced: report.replaced, sha256: report.sha256, backup: report.backupDir });
  // What was kept, by whom and when, so `nouride update --rollback` can name it, tell it is the build before this
  // one, and find the snapshot this update takes (D7).
  recordKeptBuild(report.backupDir, { version: facts.version, by: staged.tag });
  await deps.download.discard();
  // Unconfirmed until the new version proves itself; the unit's guard restores the old one otherwise.
  markPendingUpdate(facts.installDir, { from: facts.version, to: staged.tag });
  return {
    report,
    plan: plan ?? {
      can: true,
      from: facts.version,
      to: staged.tag,
      artifact: staged.artifact,
      tarballUrl: "",
      checksumUrl: checksumFile,
      checksumFile: "",
    },
  };
}

/**
 * Where the checksums for a staged release live, worked out without asking the channel.
 *
 * Same derivation the plan uses — the tag is on the download and the file name comes from the
 * edition — so an install can verify itself when the releases API is unreachable. `SHA256SUMS`
 * is served by the download host, not by the API, so this is not wishful.
 */
function stagedChecksumUrl(
  mod: Pick<UpdateModule, "checksumName">,
  source: import("nouride-update").ReleaseSource,
  facts: { edition: string },
  tag: string,
): string {
  const name = mod.checksumName(facts.edition as Parameters<UpdateModule["checksumName"]>[0], tag);
  if (!name) throw new Error(`the ${facts.edition} edition has no checksum file`);
  return source.checksumUrl(tag, name);
}

/**
 * The same, for the checksum file's signature — for a release that requires one: a private edition's, and a public
 * one's from 0.7.4. This path is taken without a fresh check, and it used to skip the signature of every public
 * release — the one way to install a stripped release that the plan, which can see its files, refuses.
 */
export function stagedSignatureUrl(
  mod: Pick<UpdateModule, "checksumName" | "requiresSignature">,
  source: Pick<import("nouride-update").ReleaseSource, "signatureUrl">,
  facts: { edition: string },
  tag: string,
): string | undefined {
  const edition = facts.edition as Parameters<UpdateModule["checksumName"]>[0];
  const name = mod.checksumName(edition, tag);
  return name && source.signatureUrl && mod.requiresSignature(edition, tag) ? source.signatureUrl(tag, name) : undefined;
}

/**
 * Download and install in one call, for a caller that is not going to press two buttons.
 *
 * The agent's path. A model asked to update does not want a progress bar; it wants the thing
 * done and a turn scheduled to check it. The approval it had to pass to get here covered both
 * halves, which is why this is one call rather than a shortcut around a second confirmation.
 */
export async function applyUpdate(dataDir: string): Promise<{ report: ApplyReport; plan: UpdatePlan }> {
  await startDownload(dataDir);
  const settled = await settleDownload();
  if (settled.status !== "ready") {
    throw new Error(`the download did not finish: ${settled.error ?? settled.status}`);
  }
  return await installDownloaded(dataDir);
}
