/**
 * Whether this particular install can replace itself, and what it would do.
 *
 * Separated from actually doing it because the answer is worth reading on its own: the
 * dashboard and the CLI both show it, and an agent has to be able to say "there is a new
 * version and here is why I cannot install it" rather than trying and failing.
 *
 * Every refusal carries what to do instead. A refusal that only says no is one the person
 * reading it has to go and research, and the thing they need is one command.
 */

import { buildFromSource, reinstallByHand } from "./advice.ts";
import { artifactName, checksumName, deliveryFor, isPrivateEdition, targetFor, type TargetFacts } from "./edition.ts";
import type { Edition } from "./edition.ts";
import { DEFAULT_CHANNEL, githubSource, type ReleaseChannel, type ReleaseSource } from "./release.ts";
import { requiresSignature, SIGNED_SINCE, signatureName } from "./signing.ts";

export interface InstallFacts extends TargetFacts {
  /** What this daemon reports as its version. */
  version: string;
  edition: Edition;
  /** Where the executable and its dashboard live. */
  installDir: string;
  /** Whether the daemon may write there. It owns the directory on an ordinary install. */
  installDirWritable: boolean;
  /** `systemd`, `launchd`, `docker`, `external`, `none`. */
  supervisor: string;
  /** Whether exiting brings it back. Without this, an update is a stop. */
  restartsOnExit: boolean;
  /** False when running from a source checkout rather than a compiled binary. */
  compiled: boolean;
}

export interface UpdateSteps {
  /** `<installDir>/nouride`, replaced by rename. */
  artifact: string;
  tarballUrl: string;
  checksumUrl: string;
  checksumFile: string;
  /** Where the checksum file's signature is, when the source publishes one. */
  signatureUrl?: string;
}

export type UpdatePlan =
  | ({ can: true; from: string; to: string } & UpdateSteps)
  | { can: false; from: string; to: string; reason: string; instead: string[] };

export interface PlanInput {
  facts: InstallFacts;
  /** The tag the channel published, e.g. `v0.3.3`. */
  tag: string;
  /** Where the release's files are. The public GitHub channel when neither is given. */
  source?: Pick<ReleaseSource, "tarballUrl" | "checksumUrl" | "signatureUrl">;
  channel?: ReleaseChannel;
  /**
   * The release's own files. A public edition is verified against a signature when the release carries one —
   * from 0.7.4 on, each public checksum file is signed — and installs unsigned when it does not, as every
   * release before did; a private edition needs one either way.
   */
  assets?: readonly string[];
  /**
   * What the channel publishes none of, when no release on it carries this build: `edition`, when it carries no build
   * of this edition at all — the Pro editions on the public mirror — or `target`, when it carries the edition and
   * never for this platform — a macOS install. `checkForUpdate` decides it from the release list.
   */
  unpublished?: "edition" | "target";
}

/**
 * Build the plan, or the refusal.
 *
 * The order of the checks is the order in which they are *true*, not the order of
 * severity: a container is a container whether or not the version parses, and telling
 * somebody their install directory is read-only when the real answer is "you are in
 * Kubernetes" sends them to the wrong place.
 */
export function planUpdate(input: PlanInput): UpdatePlan {
  const { facts, tag } = input;
  const source = input.source ?? githubSource(input.channel ?? DEFAULT_CHANNEL);
  const base = { from: facts.version, to: tag };

  if (!facts.compiled) {
    return {
      ...base,
      can: false,
      reason: "this daemon is running from a source checkout, not an installed binary",
      instead: ["git pull", "bun install", "bun run build:binary"],
    };
  }

  const delivery = deliveryFor(facts.edition, facts.supervisor);
  if (delivery === "container") {
    /**
     * A container cannot replace its own image, and pretending otherwise would produce
     * the worst version of this: a daemon that swaps the binary inside a writable layer,
     * restarts, works — and reverts the moment the container is recreated, which is the
     * next deploy and is also when somebody is least expecting it.
     */
    // Each edition is its own image. A Router container told to pull `nouride` would come back as the
    // Community edition, without the gateway its config expects. The Pro images are private.
    const priv = isPrivateEdition(facts.edition);
    const image = `ghcr.io/nouverse/${facts.edition === "basic" ? "nouride" : `nouride-${facts.edition}`}`;
    // The release is `v0.7.10`; its image is not. `release.yml` tags an image by the version — `0.7.10`, and `0.7` —
    // and `:v0.7.10` is no tag at all, so every line below that a person copied failed with `manifest unknown`.
    const version = tag.replace(/^v/, "");
    return {
      ...base,
      can: false,
      reason:
        `this install is a container (${facts.edition} edition), and an image is replaced from ` +
        `outside it: a swap made in here is lost the next time the container is recreated`,
      /**
       * Compose first, because it is the shape most people are in and it needs no image name —
       * the compose file already knows which one. The explicit `docker pull` is underneath for a
       * container started by hand, and the tag is spelled out because `:latest` is the mistake
       * that makes an update look like it did nothing.
       */
      instead: [
        `# in the directory with your compose file:`,
        `docker compose pull && docker compose up -d`,
        ``,
        `# or by hand, naming the version rather than :latest`,
        ...(priv
          ? [`echo "$GHCR_TOKEN" | docker login ghcr.io -u <you> --password-stdin   # ${image} is private`]
          : []),
        `docker pull ${image}:${version}`,
        `docker rm -f nouride && docker run -d --name nouride ... ${image}:${version}`,
        ``,
        `# or on Kubernetes`,
        `kubectl set image deploy/<name> nouride=${image}:${version}`,
      ],
    };
  }

  const target = targetFor(facts);
  if (!target) {
    return {
      ...base,
      can: false,
      reason: `no build is published for ${facts.platform}/${facts.arch}`,
      instead: ["build one from source: bun run build:binary --target <target>"],
    };
  }

  const artifact = artifactName(facts.edition, target);
  const checksums = checksumName(facts.edition, tag);

  /**
   * The channel publishes no build this install could take, and says so by carrying none: a newer release exists, and
   * it is not here. An off-box Pro server on the public mirror was told "up to date" while it missed fixes, and the
   * one command it could be offered was `curl … | sudo sh -s -- --variant pro`, which the installer refuses.
   */
  if (input.unpublished === "edition") {
    return {
      ...base,
      can: false,
      reason: `no ${facts.edition} build is published on this release channel`,
      instead: isPrivateEdition(facts.edition)
        ? ["a Nouride Box takes its updates from Nouverse once it is paired (My Box)", ...reinstallByHand(facts.edition, target, tag)]
        : reinstallByHand(facts.edition, target, tag),
    };
  }
  if (input.unpublished === "target") {
    return {
      ...base,
      can: false,
      reason: `no build for ${facts.platform}/${facts.arch} is published on this release channel`,
      instead: buildFromSource(facts.edition, target),
    };
  }

  if (!facts.installDirWritable) {
    /**
     * The daemon owns its install directory on an ordinary install — `install.sh` chowns it
     * to the service user precisely so an upgrade does not need root. When it does not,
     * the install was arranged differently and only a person with the rights can fix it.
     */
    return {
      ...base,
      can: false,
      reason: `this daemon cannot write ${facts.installDir}, so it cannot replace its own binary`,
      instead: reinstallByHand(facts.edition, target, tag),
    };
  }

  if (!facts.restartsOnExit) {
    /**
     * The swap would work and then nothing would bring the daemon back, which is a stop
     * wearing an update's name. Refused rather than warned: the person who asked for an
     * update is not expecting to have to start it again by hand, and by the time they
     * find out, the process that would have told them is gone.
     */
    return {
      ...base,
      can: false,
      reason:
        `nothing would restart this daemon after the swap (supervisor: ${facts.supervisor}), ` +
        `so an update here would be a stop`,
      instead: ["install a service first: nouride service install", "or update by hand:", ...reinstallByHand(facts.edition, target, tag)],
    };
  }

  /**
   * A private edition installs only a signed release, and says so before anything is downloaded
   * rather than after. The requirement is this plugin's, not the source's: a source that offered no
   * signature must not be how a Device box ends up running an unsigned build.
   */
  const signed = requiresSignature(facts.edition, tag);
  if (signed && !source.signatureUrl) {
    const isPrivate = requiresSignature(facts.edition);
    return {
      ...base,
      can: false,
      reason: isPrivate
        ? `the ${facts.edition} edition installs only signed releases, and this release channel publishes no signature`
        : `${tag} is a release that must be signed, and this release channel publishes no signature`,
      instead: isPrivate
        ? ["check that this box is paired with Nouverse (My Box), then check for updates again"]
        : [`update by hand, which checks the signature itself: curl -fsSL https://get.nouride.com/install.sh | sudo sh`],
    };
  }
  /**
   * A public release that must be signed and lists no signature has had one taken away: refused here, before
   * anything is downloaded. Whoever can edit a release can swap the tarball and its checksum file together, and the
   * signature is the one part they cannot make. A private edition's source serves its signature apart from the
   * release's files, which never list it; the install verifies it there, and refuses without it.
   */
  if (signed && !requiresSignature(facts.edition) && input.assets && !input.assets.includes(signatureName(checksums))) {
    return {
      ...base,
      can: false,
      reason: `${tag} lists no signature for ${checksums}, which a release from ${SIGNED_SINCE} on always has; refusing it`,
      instead: ["report it: this release may have been tampered with"],
    };
  }

  return {
    ...base,
    can: true,
    artifact,
    tarballUrl: source.tarballUrl(tag, artifact),
    checksumUrl: source.checksumUrl(tag, checksums),
    checksumFile: checksums,
    ...(source.signatureUrl && (signed || input.assets?.includes(signatureName(checksums)))
      ? { signatureUrl: source.signatureUrl(tag, checksums) }
      : {}),
  };
}
