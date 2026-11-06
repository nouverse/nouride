/**
 * The commands a refusal offers instead, when an install cannot take an update by itself.
 *
 * A refusal that offers a command that cannot work is worse than one that offers none. The Pro editions were told
 * `curl … | sudo sh -s -- --variant pro`, which `install.sh` refuses: they are not a public download, so it asks for
 * `--tarball`. And a Router install was told the same line with no `--variant` at all, which would have replaced it
 * with the Community edition — its LLM gateway gone, with a config that still expects one.
 */

import { artifactName, checksumName, isPrivateEdition, variantFor, type Edition } from "./edition.ts";

const variantArg = (edition: Edition) => (variantFor(edition) ? ` --variant ${variantFor(edition)}` : "");

/** Reinstalling this edition by hand with the installer, from where its builds are published. */
export function reinstallByHand(edition: Edition, target: string, tag: string): string[] {
  // No sudo on a Mac: the install there is the account's own, a LaunchAgent in its home, and run as root it would
  // leave root's files in it.
  const sudo = target.startsWith("darwin-") ? "" : "sudo ";
  if (!isPrivateEdition(edition)) {
    return [`curl -fsSL https://get.nouride.com/install.sh | ${sudo}sh${variantFor(edition) ? ` -s --${variantArg(edition)}` : ""}`];
  }
  const artifact = artifactName(edition, target);
  // The signature too: install.sh checks the checksum file against it when it sits beside the tarball, and without it
  // the install is checked against a file nothing vouches for. The internal release carries it from v0.7.10.
  const sums = checksumName(edition, tag);
  return [
    `put ${artifact}.tar.gz, ${sums} and ${sums}.sig from the ${tag} release of the internal repository in one directory, then there:`,
    `${sudo}sh install.sh --tarball ${artifact}.tar.gz${variantArg(edition)}`,
  ];
}

/** Building this edition for a target no release publishes, and installing what that makes. */
export function buildFromSource(edition: Edition, target: string): string[] {
  // The edition's own build flag: `--router` on the public entry point, `--pro` on the private one.
  const flag = variantFor(edition) ? ` --${variantFor(edition)}` : "";
  const build = isPrivateEdition(edition) ? `bun run build:pro${flag}` : `bun run build:binary${flag}`;
  return [
    `build it from source: ${build} --target ${target}`,
    `then: sh scripts/install.sh --tarball dist/${artifactName(edition, target)}.tar.gz${variantArg(edition)}`,
  ];
}
