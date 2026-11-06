/**
 * Which signature a plan asks for, through a source that may publish none — and the keys that may answer it.
 *
 * `plan.test.ts` and `signing.test.ts` cover the default GitHub source and one key. Each case here is a mutant the
 * 0.7.11 mutation sweep found nothing catching: a source with no signatures at all (what the engine's appliance
 * source is when unpaired), a release that lists a signature it was not required to have, and a second key during a
 * rotation.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { planUpdate, type InstallFacts } from "../src/plan.ts";
import { verifyChecksums } from "../src/signing.ts";

const INSTALLED: InstallFacts = {
  version: "0.7.2",
  edition: "basic",
  installDir: "/srv/nouride",
  installDirWritable: true,
  supervisor: "systemd",
  restartsOnExit: true,
  compiled: true,
  platform: "linux",
  arch: "x64",
  musl: false,
};

const UNSIGNED_SOURCE = {
  tarballUrl: (tag: string, artifact: string) => `https://mirror.invalid/${tag}/${artifact}.tar.gz`,
  checksumUrl: (tag: string, sums: string) => `https://mirror.invalid/${tag}/${sums}`,
};
const SIGNED_SOURCE = { ...UNSIGNED_SOURCE, signatureUrl: (tag: string, sums: string) => `https://mirror.invalid/${tag}/${sums}.sig` };

describe("a source that publishes no signature", () => {
  test("still installs a public release from before signing, even one that lists a signature it cannot serve", () => {
    for (const assets of [undefined, ["nouride-linux-x64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"]]) {
      const plan = planUpdate({ facts: INSTALLED, tag: "v0.7.3", source: UNSIGNED_SOURCE, ...(assets ? { assets } : {}) });
      expect(plan.can).toBe(true);
      expect(plan.can && plan.signatureUrl).toBeUndefined();
    }
  });

  test("refuses a public release that must be signed, and offers the installer, which checks the signature itself", () => {
    const plan = planUpdate({ facts: INSTALLED, tag: "v0.7.4", source: UNSIGNED_SOURCE });
    if (plan.can) throw new Error("an unsigned 0.7.4 was planned");
    expect(plan.reason).toBe("v0.7.4 is a release that must be signed, and this release channel publishes no signature");
    expect(plan.instead).toEqual([
      "update by hand, which checks the signature itself: curl -fsSL https://get.nouride.com/install.sh | sudo sh",
    ]);
  });

  test("refuses a private edition, and sends it to pairing rather than to the public installer", () => {
    const plan = planUpdate({ facts: { ...INSTALLED, edition: "pro" }, tag: "v0.7.4", source: UNSIGNED_SOURCE });
    if (plan.can) throw new Error("an unsigned private build was planned");
    expect(plan.instead).toEqual(["check that this box is paired with Nouverse (My Box), then check for updates again"]);
  });
});

describe("a release that lists a signature", () => {
  test("is verified against it even before signing was required", () => {
    // Listed means checked: a signature that is there and wrong must stop the install, whatever the release's age.
    const plan = planUpdate({
      facts: INSTALLED,
      tag: "v0.7.3",
      source: SIGNED_SOURCE,
      assets: ["nouride-linux-x64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"],
    });
    expect(plan.can && plan.signatureUrl).toBe("https://mirror.invalid/v0.7.3/SHA256SUMS.sig");
  });
});

describe("an edition the channel does not publish", () => {
  test("a private edition is pointed at its box first; a public one is not", () => {
    const pro = planUpdate({ facts: { ...INSTALLED, edition: "pro" }, tag: "v0.7.4", source: SIGNED_SOURCE, unpublished: "edition" });
    if (pro.can) throw new Error("unreachable");
    expect(pro.instead[0]).toBe("a Nouride Box takes its updates from Nouverse once it is paired (My Box)");
    const router = planUpdate({ facts: { ...INSTALLED, edition: "router" }, tag: "v0.7.4", source: SIGNED_SOURCE, unpublished: "edition" });
    if (router.can) throw new Error("unreachable");
    expect(router.instead).toEqual(["curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router"]);
  });
});

describe("rotating the release key", () => {
  test("a box that carries the old key and the new one verifies a release signed with either", () => {
    const old = generateKeyPairSync("ed25519");
    const next = generateKeyPairSync("ed25519");
    const pem = (k: typeof old) => k.publicKey.export({ type: "spki", format: "pem" }).toString();
    const SUMS = "abcd  ./nouride-linux-x64.tar.gz\n";
    const byNext = sign(null, Buffer.from(SUMS), next.privateKey).toString("base64");
    const byOld = sign(null, Buffer.from(SUMS), old.privateKey).toString("base64");
    expect(verifyChecksums(SUMS, byNext, [pem(old), pem(next)])).toBe(true);
    expect(verifyChecksums(SUMS, byOld, [pem(old), pem(next)])).toBe(true);
  });
});
