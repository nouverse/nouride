/**
 * Every save in the dashboard says what happened: "Applied", or "Saved — takes effect after a
 * restart" with the Restart button beside it — in the words the CLI uses, and decided by the daemon's answer.
 *
 * The forms each said it their own way, or not at all: the config editor told the person to find Overview → Restart,
 * web search and the connections had restart buttons of their own, and most cards saved silently. Each save path is
 * held here to the one hook that says it (`useSaved`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { APPLIED, RESTART_NEEDED, needsRestart } from "@/commons/hooks/use-saved";

const SRC = join(dirname(import.meta.path), "..", "src");
const CLI_SAVED = join(dirname(import.meta.path), "..", "..", "cli", "src", "saved.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

/** Every call that writes the daemon's config or an agent's pack. */
const SAVES = [
  "setAccessMode", "setMemorySettings", "setPersonFacts", "setPersonRecall", "setWebSearch", "setPasswordLogin", "saveMcpServer", "deleteMcpServer",
  "saveAgentModel", "saveAgentSkills", "setAgentApprovals", "setJobQuietMinutes", "setAgentJobQuietMinutes", "setGroupContext",
  "setDailyCostCap", "setMentionSettings", "saveGateway", "deleteGateway", "saveProviderProfile",
  "deleteProvider", "writeConfig", "setTurnSeconds", "setAgentTurnSeconds", "setToolIterations", "setAgentToolIterations",
  "setMcpServerEnabled", "setSkillOffGlobally", "saveRsiSettings", "savePerson", "deletePerson", "setRetention",
];

/** Saves that report themselves another way, and why. */
const SAID_ELSEWHERE: Record<string, string> = {
  "modules/setup/MemoryStep.tsx": "a step of the setup wizard, which moves on when it is done — the step is the outcome",
  "commons/components/people/PersonNotes.tsx": "notes, saved through NotesModal, which says Saved itself and keeps the text open",
};

describe("a save says what happened", () => {
  test("from the daemon's answer: a restart only when it says one is required", () => {
    expect(needsRestart({ ok: true, restartRequired: true })).toBe(true);
    expect(needsRestart({ ok: true, restartRequired: false })).toBe(false);
    // An answer that says nothing of a restart changed nothing the daemon reads at boot.
    expect(needsRestart({ ok: true, maxDailyCostUsd: 5 })).toBe(false);
    expect(needsRestart(undefined)).toBe(false);
  });

  test("in the words the CLI uses", () => {
    // Without its colour codes, which sit inside the words.
    const cli = readFileSync(CLI_SAVED, "utf8").replace(/\$\{[A-Z]+\}/g, "");
    expect(cli).toContain(`: ${APPLIED.toLowerCase()}`);
    expect(cli).toContain(`: ${RESTART_NEEDED.toLowerCase()}`);
  });

  test("on every form that saves a setting", () => {
    const callers = sources(SRC)
      .filter((path) => !/commons\/lib\/api(\.[\w-]+)?\.ts$/.test(path))
      .map((path) => ({ file: relative(SRC, path), text: readFileSync(path, "utf8") }))
      .filter(({ text }) => SAVES.some((name) => new RegExp(`\\bapi\\.${name}\\b`).test(text)));
    // The fail-open shape: a renamed call would leave nothing to check.
    expect(callers.length).toBeGreaterThan(25);
    const silent = callers.filter(({ file, text }) => !(file in SAID_ELSEWHERE) && !/\buseSaved\(\)/.test(text)).map(({ file }) => file);
    expect(silent).toEqual([]);
  });

  test("and a save that waits for a restart has the Restart button beside it, wherever it is said", () => {
    for (const file of ["commons/components/box/RestartNeeded.tsx", "commons/components/layout/Reconnecting.tsx"]) {
      const text = readFileSync(join(SRC, file), "utf8");
      expect({ file, button: /<RestartButton\b/.test(text) }).toEqual({ file, button: true });
    }
    // The pending strip is above every page.
    expect(readFileSync(join(SRC, "commons/components/layout/RootLayout.tsx"), "utf8")).toContain("<RestartPendingBar />");
  });
});
