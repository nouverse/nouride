/**
 * The engine's half of system packages: knowing whether this box has them, and — only when an agent
 * needs one — the one command that turns them on, for the edition that is installed.
 */

import { describe, expect, test } from "bun:test";
import { installLadder } from "@/modules/llm/prompt/harness-skills.ts";
import { enableAdvice, INSTALLER_URL, packageSetup, type PackageFacts } from "@/modules/system-packages/setup.ts";
// @ts-expect-error — a plain .mjs module, read for its installer's URL
import { INSTALL_SCRIPT_URL } from "../../../site/src/consts.mjs";

const box: PackageFacts = {
  platform: "linux",
  inContainer: false,
  systemd: true,
  plugin: true,
  socketPresent: false,
  edition: "basic",
  installDir: "/srv/nouride",
};

describe("is it on", () => {
  test("off is a state with a way on, for the installer of this edition", () => {
    expect(packageSetup(box)).toEqual({ state: "off", command: "curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --allow-packages" });

    const router = packageSetup({ ...box, edition: "router" });
    // The same line for the name no build makes now: `--variant router` would also switch the gateway on, and this
    // command is about packages alone.
    expect(router.state === "off" && router.command).toBe("curl -fsSL https://get.nouride.com/install.sh | sudo sh -s -- --allow-packages");

    const elsewhere = packageSetup({ ...box, installDir: "/opt/nr" });
    expect(elsewhere.state === "off" && elsewhere.command).toEndWith("--allow-packages --dir /opt/nr");

    // A licensed edition has no public installer to name, and is not handed the free one.
    const device = packageSetup({ ...box, edition: "pro" });
    expect(device.state === "off" && device.command).toBeNull();
    expect(enableAdvice(device)).toContain("install.sh of the release this box was installed from");
  });

  test("the advice says what it costs a person, and that re-running loses nothing", () => {
    const advice = enableAdvice(packageSetup(box)) ?? "";
    expect(advice).toContain("asking you before every change");
    expect(advice).toContain("safe to re-run: agents, memory and settings stay");
  });

  test("the socket is the answer; where the service cannot exist, there is nothing to turn on", () => {
    expect(packageSetup({ ...box, socketPresent: true })).toEqual({ state: "ready" });
    for (const facts of [
      { ...box, plugin: false },
      { ...box, platform: "darwin" },
      { ...box, inContainer: true },
      { ...box, systemd: false },
      // A flashed Box: privileged, root, and runs the package manager itself.
      { ...box, daemonRoot: true },
    ]) {
      const setup = packageSetup(facts);
      expect(setup.state).toBe("not-applicable");
      expect(enableAdvice(setup)).toBeNull();
    }
  });

  test("in Nouride's own image the service is served unless turned off, and the advice is the container's (0.8.15)", () => {
    const container = { ...box, inContainer: true, systemd: false };
    expect(packageSetup({ ...container, containerService: true, socketPresent: true })).toEqual({ state: "ready" });
    const off = packageSetup({ ...container, containerService: true });
    expect(off).toEqual({ state: "off", command: null, container: true });
    const advice = enableAdvice(off) ?? "";
    expect(advice).toContain("without NOURIDE_SYSTEM_PACKAGES=off");
    expect(advice).toContain("docker compose up -d");
    // Not an installer to run: none turns it on in a container.
    expect(advice).not.toContain("install.sh");
    // Another image has nothing that would serve it.
    expect(packageSetup(container).state).toBe("not-applicable");
  });

  test("the installer is the one the site publishes", () => {
    expect(INSTALLER_URL).toBe(INSTALL_SCRIPT_URL);
  });
});

describe("the install ladder", () => {
  const host = { root: false, sudo: false, manager: "apt-get install -y <pkg>" };

  test("on, step 2 is nouride pkg, never sudo", () => {
    const text = installLadder("/srv/nouride/.nouride/bin", { host: { ...host, sudo: true, packages: { state: "ready" } } });
    expect(text).toContain("`nouride pkg install <pkg>`");
    expect(text).toContain("a person approves each one");
    expect(text).not.toContain("`sudo ");
  });

  test("off, the agent knows the limit, and raises it only when a task needs a system package", () => {
    const text = installLadder("/srv/nouride/.nouride/bin", { host: { ...host, packages: packageSetup(box) } });
    expect(text).toContain("System packages are off on this box, so do not try `sudo`");
    expect(text).toContain("If the task really needs one");
    expect(text).toContain("--allow-packages");
    expect(text).toContain("go to step 3");
  });
});
