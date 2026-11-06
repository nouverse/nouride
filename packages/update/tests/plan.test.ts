/**
 * What an install is allowed to do to itself.
 *
 * Every test here is a refusal, because the refusals are the decisions. "Yes, download
 * this URL" is one line; "no, and here is the command you need instead" is the part that
 * has to be right, and each one corresponds to a way a self-update goes wrong quietly:
 * a container that reverts on the next deploy, a swap nothing restarts, a tarball that
 * was never published for this edition.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CHANNEL, githubSource } from "../src/release.ts";
import { planUpdate, type InstallFacts } from "../src/plan.ts";

const INSTALLED: InstallFacts = {
  version: "0.3.2",
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

const plan = (overrides: Partial<InstallFacts> = {}) =>
  planUpdate({ facts: { ...INSTALLED, ...overrides }, tag: "v0.3.3", channel: DEFAULT_CHANNEL });

describe("an ordinary systemd install", () => {
  test("can update, and names the artifact and both URLs", () => {
    const result = plan();
    expect(result.can).toBe(true);
    if (!result.can) throw new Error("unreachable");
    expect(result.artifact).toBe("nouride-linux-x64");
    expect(result.tarballUrl).toBe("https://get.nouride.com/v0.3.3/nouride-linux-x64.tar.gz");
    expect(result.checksumUrl).toBe("https://get.nouride.com/v0.3.3/SHA256SUMS");
    expect(result.from).toBe("0.3.2");
    expect(result.to).toBe("v0.3.3");
  });

  test("musl and arm change the artifact, not the shape", () => {
    const musl = plan({ musl: true });
    expect(musl.can && musl.artifact).toBe("nouride-linux-x64-musl");
    const arm = plan({ arch: "arm64" });
    expect(arm.can && arm.artifact).toBe("nouride-linux-arm64");
  });

  test("a device install asks for the device tarball and its own checksum file", () => {
    /**
     * Its own, not the release's: the three binary editions are built by separate jobs
     * and each uploads `SHA256SUMS-<variant>`. Reading the free one would find no line
     * for this artifact and fail at the verify step, after the download.
     */
    // Through a source that publishes a signature: a private edition installs nothing unsigned.
    const device = planUpdate({
      facts: { ...INSTALLED, edition: "pro" },
      tag: "v0.3.3",
      source: {
        tarballUrl: (tag, artifact) => `https://get.nouride.com/${tag}/${artifact}.tar.gz`,
        checksumUrl: (tag, sums) => `https://get.nouride.com/${tag}/${sums}`,
        signatureUrl: (tag, sums) => `https://get.nouride.com/${tag}/${sums}.sig`,
      },
    });
    expect(device.can).toBe(true);
    if (!device.can) throw new Error("unreachable");
    expect(device.artifact).toBe("nouride-pro-linux-x64");
    expect(device.checksumUrl).toBe("https://get.nouride.com/v0.3.3/SHA256SUMS-pro");
  });
});

describe("installs that must not update themselves", () => {
  test("a container is refused, and told to pull the image", () => {
    const result = plan({ supervisor: "docker" });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.reason).toContain("container");
    expect(result.instead.join("\n")).toContain("docker pull ghcr.io/nouverse/nouride:0.3.3");
    // Because the swap would be lost on the next recreate, which is the deploy nobody
    // connects to a daemon that reverted.
    expect(result.reason).toContain("recreated");
    // The free image is public, so no login line clutters the instructions for it.
    expect(result.instead.join("\n")).not.toContain("docker login");
  });

  test("a Router container is told to pull the Router image, which is public too", () => {
    // Told `nouride`, it would come back as the Community edition, without the gateway its config expects.
    const result = plan({ edition: "router", supervisor: "docker" });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.instead.join("\n")).toContain("docker pull ghcr.io/nouverse/nouride-router:0.3.3");
    expect(result.instead.join("\n")).not.toContain("docker login");
  });

  test("Pro in a container is told to pull its own image, which is private", () => {
    // The same edition runs on a Box from a tarball and in a pod from an image: the supervisor decides.
    const result = plan({ edition: "pro", supervisor: "docker" });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.instead.join("\n")).toContain("docker pull ghcr.io/nouverse/nouride-pro:0.3.3");
    expect(result.instead.join("\n")).toContain("docker login ghcr.io");
  });

  test("a source checkout is told to use git, not a tarball", () => {
    const result = plan({ compiled: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.instead).toContain("git pull");
  });

  test("an install directory it cannot write is refused with the installer command", () => {
    const result = plan({ installDirWritable: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.reason).toContain("/srv/nouride");
    expect(result.instead.join("\n")).toContain("get.nouride.com/install.sh");
  });

  test("nothing to restart it is a refusal, not a warning", () => {
    /**
     * The swap would work and the daemon would then be gone until somebody noticed. By
     * the time they did, the process that could have said so is not running.
     */
    const result = plan({ supervisor: "none", restartsOnExit: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.reason).toContain("would be a stop");
    expect(result.instead.join("\n")).toContain("nouride service install");
  });

  test("a Pro install is told the command that installs it, which takes its tarball", () => {
    // It was `curl … | sudo sh -s -- --variant pro`, and install.sh refuses that: the Pro editions are not a public
    // download, so it asks for `--tarball`. A command that cannot work is worse than none.
    const result = plan({ edition: "pro", installDirWritable: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    const instead = result.instead.join("\n");
    expect(instead).toContain("sudo sh install.sh --tarball nouride-pro-linux-x64.tar.gz --variant pro");
    expect(instead).toContain("from the v0.3.3 release of the internal repository");
    expect(instead).not.toContain("curl");
  });

  test("a Router install is told to reinstall Router, not the Community edition", () => {
    // The same line with no `--variant` would have replaced it with the free build — its LLM gateway gone, and a
    // config that still expects one.
    const result = plan({ edition: "router", supervisor: "none", restartsOnExit: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.instead).toContain("curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --variant router");
  });

  test("a Mac is told to reinstall as itself, not with sudo", () => {
    // The install on a Mac is the account's own — a LaunchAgent in its home — and `sudo sh` would leave root's files
    // in it. A Linux server's install is root's to make, and keeps sudo.
    const mac = plan({ platform: "darwin", arch: "arm64", supervisor: "none", restartsOnExit: false });
    if (mac.can) throw new Error("unreachable");
    expect(mac.instead).toContain("curl -fsSL https://get.nouride.com/install.sh | sh");
    expect(mac.instead.join("\n")).not.toContain("sudo");
    const pro = plan({ platform: "darwin", arch: "arm64", edition: "pro", installDirWritable: false });
    if (pro.can) throw new Error("unreachable");
    expect(pro.instead).toContain("sh install.sh --tarball nouride-pro-darwin-arm64.tar.gz --variant pro");
  });

  test("a build the channel does not publish is said before what this install could do about it", () => {
    // Not "this daemon cannot write /srv/nouride": with nothing published for it, no permission would help.
    const pro = planUpdate({ facts: { ...INSTALLED, edition: "pro", installDirWritable: false }, tag: "v0.3.3", channel: DEFAULT_CHANNEL, unpublished: "edition" });
    expect(!pro.can && pro.reason).toBe("no pro build is published on this release channel");
    // And a container is still a container: its answer is the image, whatever the tarballs.
    const pod = planUpdate({ facts: { ...INSTALLED, edition: "pro", supervisor: "docker" }, tag: "v0.3.3", channel: DEFAULT_CHANNEL, unpublished: "edition" });
    expect(!pod.can && pod.reason).toContain("container");
  });

  test("an unpublished platform is named rather than attempted", () => {
    const result = plan({ arch: "arm", platform: "linux" });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.reason).toContain("linux/arm");
  });
});

describe("the order of the refusals", () => {
  test("a container in Kubernetes is told about the image, not about permissions", () => {
    /**
     * A read-only container filesystem is also not writable, and answering with "this
     * daemon cannot write /srv/nouride" sends somebody to fix a permission that is not
     * the problem.
     */
    const result = plan({ supervisor: "docker", installDirWritable: false, restartsOnExit: false });
    expect(result.can).toBe(false);
    if (result.can) throw new Error("unreachable");
    expect(result.reason).toContain("container");
  });
});

describe("a public release's signature (D7)", () => {
  const signed = (assets?: string[]) =>
    planUpdate({ facts: INSTALLED, tag: "v0.7.4", source: githubSource(DEFAULT_CHANNEL), ...(assets ? { assets } : {}) });

  test("required from 0.7.4 on — listed, it is checked; unsaid, it is asked for", () => {
    const listed = signed(["nouride-linux-x64.tar.gz", "SHA256SUMS", "SHA256SUMS.sig"]);
    expect(listed.can && listed.signatureUrl).toBe("https://get.nouride.com/v0.7.4/SHA256SUMS.sig");
    // A caller that did not say what the release carries still gets the demand: the install fails without it.
    const unsaid = signed();
    expect(unsaid.can && unsaid.signatureUrl).toBe("https://get.nouride.com/v0.7.4/SHA256SUMS.sig");
  });

  test("a release from 0.7.4 on with its signature taken away is refused before anything is downloaded", () => {
    // Whoever can edit a release drops the .sig and swaps the tarball and SHA256SUMS together. This went through.
    const stripped = signed(["nouride-linux-x64.tar.gz", "SHA256SUMS"]);
    expect(stripped.can).toBe(false);
    expect(!stripped.can && stripped.reason).toContain("lists no signature for SHA256SUMS");
  });

  test("a release before 0.7.4, published before there was a key, still installs unsigned", () => {
    const old = planUpdate({ facts: INSTALLED, tag: "v0.7.3", source: githubSource(DEFAULT_CHANNEL), assets: ["nouride-linux-x64.tar.gz", "SHA256SUMS"] });
    expect(old.can && old.signatureUrl).toBeUndefined();
  });
});
