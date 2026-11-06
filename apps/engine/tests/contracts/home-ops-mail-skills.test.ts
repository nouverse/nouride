/**
 * home-assistant, homelab-ops and mail-calendar (0.8.12): built-in skills with a helper each, so a small model drives a
 * script instead of writing one. What is held here is what keeps them safe and usable without a live server: each
 * helper answers `--help`, says plainly what is missing when a credential is, and the skills keep the rules that stop
 * an agent acting on its own — an unlock, a sent mail, a deleted one wait for the person.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "../../../../content/skills");
const read = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("python3", [join(SKILLS, script), ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, timeout: 120_000 });

describe("each helper runs on the standard library alone", () => {
  for (const script of ["home-assistant/scripts/ha.py", "homelab-ops/scripts/health.py", "mail-calendar/scripts/mail.py", "mail-calendar/scripts/cal.py"]) {
    test(`${script} --help`, () => {
      const out = run(script, ["--help"]);
      expect(out.status).toBe(0);
      expect(out.stdout.toString()).toContain("usage:");
    });
  }
});

describe("a missing credential is said, with how the person gives it — never a traceback", () => {
  test("home-assistant: no token", () => {
    const out = run("home-assistant/scripts/ha.py", ["ping"], { HA_TOKEN: "" });
    expect(out.status).not.toBe(0);
    expect(out.stderr.toString()).toContain("`/secret set ha_token <token>`");
    expect(out.stderr.toString()).not.toContain("Traceback");
  });

  test("mail-calendar: no mailbox", () => {
    const out = run("mail-calendar/scripts/mail.py", ["check"], { MAIL_USER: "", MAIL_PASSWORD: "" });
    expect(out.status).not.toBe(0);
    expect(out.stderr.toString()).toContain("`/secret set mail_password <app password>`");
    expect(out.stderr.toString()).not.toContain("Traceback");
  });
});

// A real report of this machine: on a Linux runner it reads the journal (20,000 lines), systemd and containers, and took
// over five seconds once on CI (2026-11-03), where the test's default 5 s ended it with the script still running.
test("homelab-ops: the report runs here, and --json is one object with its problems", () => {
  const out = run("homelab-ops/scripts/health.py", ["--json"]);
  expect(out.status).toBe(0);
  const report = JSON.parse(out.stdout.toString()) as Record<string, unknown>;
  expect(Object.keys(report)).toEqual(expect.arrayContaining(["host", "problems", "ok", "not_checked"]));
}, 120_000);

describe("what waits for the person", () => {
  test("home-assistant: an unlock, a door or a gate opened, an alarm disarmed — refused until --confirmed after a yes", () => {
    expect(read("home-assistant")).toContain("For the first four rows the script refuses (exit 2) until you add `--confirmed`");
  });

  test("mail-calendar: nothing is sent unseen, and a delete is for that mail only", () => {
    const skill = read("mail-calendar");
    expect(skill).toContain("**Nothing is sent without the person seeing it.** `mail.py send` without `--confirm` sends nothing");
    expect(skill).toContain("`python3 MAIL delete UID --confirm` (to Trash, recoverable)");
  });

  /**
   * A device Home Assistant does not have (0.8.12, the owner's own test): asked about a Xiaomi air purifier, Nouva swept
   * the network, got no answer from three guessed addresses and handed the hunt back. The page it should have read
   * asks one question, finds the device by what it announces, and brings it into HA — the person signing in there.
   */
  test("home-assistant: a device HA does not have is one question, then found by what it announces, then brought in", () => {
    expect(read("home-assistant")).toContain("A device HA does not have yet, or a house with no HA: `references/devices.md`");
    const page = readFileSync(join(SKILLS, "home-assistant/references/devices.md"), "utf8").replace(/\s+/g, " ");
    expect(page).toContain("Ask once, in one message: **the brand and model**");
    expect(page).toContain("`_miio._udp` Xiaomi Wi-Fi devices");
    expect(page).toContain("**No answer from any address is not \"local control is off\".**");
    expect(page).toContain("**never ask for their account password in the chat.**");
    expect(page).toContain("`/secret set miio_token <token>`, then `$MIIO_TOKEN` in your commands, never in a file");
  });

  test("homelab-ops: a daily check that speaks only when something is wrong, at no model cost", () => {
    const skill = read("homelab-ops");
    expect(skill).toContain('--command "python3 /srv/nouride/skills/homelab-ops/scripts/health.py --quiet"');
    expect(skill).toContain("a `--command` job with no output delivers nothing");
    expect(skill).toContain("run it in the foreground, not as a background job");
  });
});
