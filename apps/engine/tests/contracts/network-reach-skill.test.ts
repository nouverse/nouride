/**
 * The shipped `network-reach` skill sweeps a network, and the one it may sweep is the one this machine is on. Its
 * example named `192.168.0.0/24` as a literal: on a machine on any other subnet that command scans somebody else's
 * range, or nothing, and the skill's own rule is never to invent an address (0.8.12).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../../../../content/skills/network-reach/SKILL.md"), "utf8");
const commands = [...source.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]!).join("\n");

test("its commands carry no private address, only placeholders", () => {
  expect(commands.match(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+(?:\.\d+)?(?:\/\d+)?\b/g) ?? []).toEqual([]);
  expect(commands).toContain("nmap -sn --host-timeout 3s <subnet>");
  expect(commands).toContain("HostName <address>");
});

test("the sweep stays on this machine's own subnet", () => {
  expect(source.replace(/\s+/g, " ")).toContain("sweep **this machine's own subnet only**");
  expect(source).toContain("Never scan a network this machine is not on, and never invent an address or a tailnet name.");
});

test("a camera frame without ffmpeg installed: a static build into the bin directory, not the Remotion one (0.8.12)", () => {
  // Tried on the box: no `ffmpeg` there, and the FFmpeg a Remotion project bundles lists no RTSP demuxer. The static
  // build reads RTSP; this exact command was run there and left `ffmpeg` and `ffprobe` in the folder.
  const said = source.replace(/\s+/g, " ");
  expect(said).toContain("`ffmpeg` is often not installed, and the one a Remotion project bundles cannot read RTSP.");
  expect(commands).toContain('"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-$a-static.tar.xz"');
  expect(commands).toContain("tar -xJ --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'");
});

describe("asked \"can you access my …?\" (0.8.12)", () => {
  // Live: asked about an air purifier and a laptop at the office, a small model never opened this skill, said "no" to
  // the first and only named Tailscale for the second. The owner: an agent asked about any device must know the way in,
  // and away from home the way is Tailscale.
  const said = source.replace(/\s+/g, " ");
  const description = source.split("\n").find((line) => line.startsWith("description:")) ?? "";

  test("the description is what a question about a device matches, within the 500 every prompt carries", () => {
    expect(description).toContain("an air purifier, an AC, a robot vacuum");
    expect(description).toContain("whether you can access or control a device of theirs");
    expect(description).toContain("through Tailscale");
    expect(description.length - "description: ".length).toBeLessThanOrEqual(500);
  });

  test("never no because nothing is set up; each kind of device has its way in, at home and away", () => {
    expect(said).toContain('Never answer "no" because nothing is set up yet');
    for (const row of ["| A computer (Linux, macOS, Windows) |", "| An Android phone |", "| CCTV, a camera, an NVR |", "| An air purifier, AC, robot vacuum, lights, plugs, a TV, a speaker |"]) expect(source).toContain(row);
    expect(said).toContain("Away from this network, **Tailscale is the way**: never open a port on their router");
  });

  test("what cannot run Tailscale is reached through a subnet router at home, not a port forward", () => {
    expect(commands).toContain("sudo tailscale up --advertise-routes=<home subnet>");
    expect(said).toContain("Never port-forward on the router instead");
  });
});

test("an iPhone: said plainly that nothing logs into it, then the ways that work (0.8.12)", () => {
  // The owner asked what an agent says about an iPhone; the skill had one line. Guideline only, by their word.
  const said = source.replace(/\s+/g, " ");
  expect(source).toContain("## An iPhone or iPad");
  expect(said).toContain("iOS lets nothing log into it: no shell, no ssh, no `adb`. Say so plainly");
  expect(said).toContain("**A Shortcut that calls a webhook.**");
  expect(said).toContain("`nouride webhook add --name <name> --agent <you> --gateway <gateway> --chat <chat>");
  expect(said).toContain("*Run Script over SSH*");
  expect(said).toContain("never by logging into iCloud with their password");
  expect(said).toContain("it does not let you into the phone");
});
