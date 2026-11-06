/**
 * What runs a catalog entry here (0.7.19): the badge a card shows when it cannot, and how the machine is asked — the
 * daemon's PATH, and for Docker whether its daemon runs and the service user can reach it.
 */

import { describe, expect, test } from "bun:test";
import { blockerLabel, blockerText, machineCan, machineKind, pickRunner, runnersOf } from "@/modules/mcp-registry/runners.ts";

describe("the badge", () => {
  test("names what is missing — any one of them would do — or that it is installed and unusable, or unsupported", () => {
    expect(blockerLabel({ needs: ["uvx"] })).toBe("needs uv");
    expect(blockerLabel({ needs: ["npx", "uvx", "docker"] })).toBe("needs Node.js or uv or Docker");
    expect(blockerLabel({ needs: ["docker"], unusable: { docker: "no daemon" } })).toBe("Docker not usable");
    // One missing, one unusable: what to install is the useful word.
    expect(blockerLabel({ needs: ["uvx", "docker"], unusable: { docker: "no daemon" } })).toBe("needs uv or Docker");
    expect(blockerLabel({ needs: [], forms: ["mcpb"] })).toBe("not supported");
  });

  test("the sentence behind it says how to get each — and why an installed one cannot be used", () => {
    expect(blockerText({ needs: ["uvx", "docker"], unusable: { docker: "its daemon is not running here (no /var/run/docker.sock)" } })).toBe(
      "It needs uv, which this machine does not have. uv: `nouride pkg install pipx`, then `pipx install uv` as the service user. " +
        "Docker is installed but cannot be used: its daemon is not running here (no /var/run/docker.sock).",
    );
  });
});

describe("choosing a runner", () => {
  test("easiest to have first, whatever order the entry lists its packages in", () => {
    expect(runnersOf(["oci", "pypi", "npm", "nuget"]).map((runner) => runner.id)).toEqual(["npx", "uvx", "docker"]);
    expect(pickRunner(runnersOf(["oci", "pypi"]), (command) => command === "docker")).toMatchObject({ runner: { id: "docker" } });
    expect(pickRunner(runnersOf(["oci", "pypi"]), () => false)).toEqual({ blocked: { needs: ["uvx", "docker"] } });
  });
});

describe("asking the machine", () => {
  const on = (programs: string[]) => (command: string) => (programs.includes(command) ? `/usr/bin/${command}` : null);

  test("a program is there when it is on the PATH", () => {
    const can = machineCan({ which: on(["npx"]), env: {} });
    expect(can("npx")).toBe(true);
    expect(can("uvx")).toBe(false);
  });

  test("Docker needs its daemon's socket, reachable by this process — or a DOCKER_HOST, which is trusted", () => {
    const docker = on(["docker"]);
    expect(machineCan({ which: docker, exists: () => false, env: {} })("docker")).toEqual({ unusable: "its daemon is not running here (no /var/run/docker.sock)" });
    expect(machineCan({ which: docker, exists: (path) => path === "/var/run/docker.sock", canReadWrite: () => false, env: {} })("docker")).toEqual({
      unusable: "the service user cannot reach /var/run/docker.sock",
    });
    expect(machineCan({ which: docker, exists: () => true, canReadWrite: () => true, env: {} })("docker")).toBe(true);
    expect(machineCan({ which: docker, exists: () => false, env: { DOCKER_HOST: "ssh://builder" } })("docker")).toBe(true);
  });

  test("the answer is kept half a minute — then a program installed meanwhile counts", () => {
    let clock = 0;
    let programs: string[] = [];
    let asked = 0;
    const can = machineCan({ which: (command) => (asked++, programs.includes(command) ? "/x" : null), env: {}, now: () => clock });
    expect(can("uvx")).toBe(false);
    programs = ["uvx"];
    expect(can("uvx")).toBe(false);
    expect(asked).toBe(1);
    clock = 30_000;
    expect(can("uvx")).toBe(true);
  });
});

describe("how to get what is missing, on the machine it is missing from", () => {
  test("the container image is told what works there: uv into the volume by anyone, Node.js through nouride pkg, no Docker", () => {
    expect(machineKind({ NOURIDE_CONTAINER_SUPERVISOR: "entrypoint" })).toBe("container");
    expect(machineKind({})).toBe("native");
    const inContainer = blockerText({ needs: ["uvx"] }, "container");
    expect(inContainer).toContain("UV_INSTALL_DIR=$NOURIDE_BIN");
    // The image has busybox's wget and no curl (checked in nouride:0.7.19's image).
    expect(inContainer).toContain("wget -qO-");
    // uv needs no root and no approval: one binary into the volume, not a system package.
    expect(inContainer).not.toContain("nouride pkg");
    // Node.js is a system package: the image serves nouride-pkg and keeps it across a recreate (0.8.15), or bakes it in.
    const node = blockerText({ needs: ["npx"] }, "container");
    expect(node).toContain("`nouride pkg install nodejs npm`, kept across a recreate");
    expect(node).toContain('EXTRA_PACKAGES="nodejs npm"');
    expect(node).not.toContain("cannot install it from inside");
    expect(blockerText({ needs: ["docker"] }, "container")).toContain("not from inside a container");
    expect(blockerText({ needs: ["uvx"] }, "native")).toContain("pipx install uv");
  });
});
