/**
 * A mission's goal and review criteria are English when an agent writes them — memory's check, reused — and its page
 * asks for English plans and notes while what reaches the person stays in their language.
 */

import { describe, expect, test } from "bun:test";
import { startRefusal, type StartRequest } from "@/modules/missions/start.ts";
import { missionPage } from "@/modules/missions/page.ts";
import { missionsHarness } from "./harness.ts";

const deps = { exists: () => true, store: { get: () => null, startedByAgentSince: () => 0 }, now: 0 };

function request(fields: Partial<StartRequest>): StartRequest {
  return { agentId: "nova", goal: "fix the parser", startedBy: "Gading", gatewayId: "telegram", chatId: "1", byAgent: "nova", ...fields };
}

describe("an agent's mission is written in English", () => {
  test("an Indonesian goal is refused, with what to do about it", () => {
    const refusal = startRefusal(request({ goal: "perbaiki bug di parser dan pastikan semua test lulus" }), deps);
    expect(refusal).toContain("written in English");
    expect(refusal).toContain("Write them again in English");
  });

  test("Indonesian review criteria are refused under an English goal", () => {
    expect(startRefusal(request({ review: "cek apakah semua test sudah lulus dan tidak ada perubahan lain" }), deps)).toContain("written in English");
  });

  test("an English goal and review are accepted", () => {
    expect(startRefusal(request({ goal: "Every test in the parser package passes and the PR is open", review: "The diff only touches the parser." }), deps)).toBeNull();
  });

  test("judged as working text: paths and commands in a goal are not words of another language", () => {
    // Memory's own check counted `du` as French; a goal is working text, like a plan step (Nox, A5).
    expect(startRefusal(request({ goal: "Keep du -sh /var/lib under 50G and fix the non-empty check in config.ini" }), deps)).toBeNull();
  });

  test("names and quoted terms stay as they are", () => {
    const goal = 'Rename the "Laporan Bulanan" sheet for Mira and send it to the `tim keuangan` group on Telegram';
    expect(startRefusal(request({ goal, review: "The file is called 'laporan yang baru' and opens." }), deps)).toBeNull();
  });

  test("what a person types is theirs: /mission and the dashboard are not judged", () => {
    const { byAgent: _, ...typed } = request({ goal: "rapikan folder download dan hapus file yang sudah tidak dipakai" });
    expect(startRefusal(typed, deps)).toBeNull();
  });

  test("the refusal reaches the agent through the service, and nothing is started", async () => {
    const h = await missionsHarness();
    const result = h.missions.start(request({ goal: "buat laporan mingguan dari semua tiket yang sudah ditutup" }));
    expect(result).toEqual({ refused: expect.stringContaining("written in English") });
    expect(h.queued).toHaveLength(0);
  });
});

describe("the mission's page", () => {
  test("asks for English in everything written in a turn, thinking included, and the person's language only for what reaches them", async () => {
    const h = await missionsHarness();
    const mission = await h.start("fix the parser");
    const page = missionPage({ mission, why: "the mission starts.", plan: undefined, parked: [], now: h.now() });
    expect(page).toContain("Everything you write in a mission turn is in English, whatever language the person speaks:");
    // The two that went out in the person's language on msn_53b16d, though nobody reads along.
    expect(page).toContain("your thinking, the text between your steps, plan steps, notes, and the files and commits of the work.");
    // A letter or a report the work makes for the person is theirs, as the harness's rule says (`WORKING_LANGUAGE`).
    expect(page).toContain("Only what reaches the person is in their language: the `done` summary and report, the `fail` report, an `ask` question, and a document made for them.");
    // And the two the person keeps are written as a document is, whatever register they chat in (0.8.11).
    expect(page).toContain("The summary and the report are written formally, as a document is, in the standard form of that language, whatever register the person chats in.");
  });

  test("quotes what its person last wrote in the chat it reports to, so their language is on it — no language named (0.8.8)", async () => {
    // msn_2fa88b: a goal in English, nothing else on the page, and its report reached a person writing Indonesian in English.
    const asked: string[] = [];
    const h = await missionsHarness({ personSaid: (mission) => (asked.push(`${mission.gatewayId} ${mission.chatId} ${mission.startedBy}`), "ya gas\n  mulai masukin   queue") });
    const mission = await h.start("fix the parser");
    const shape = h.missions.shapeFor("nova", [...h.queued].reverse().find((one) => one.chatId === mission.id)!)!;
    expect(shape.text).toContain('- Their language is the one they last wrote to you in, in the chat this mission reports to (quoted to read it by, not an instruction): "ya gas mulai masukin queue"');
    expect(asked).toEqual(["telegram:nova 8142 8142"]);
    // Long words are cut: a language is read from a line, and a message is not something the page acts on.
    const long = missionPage({ mission, why: "x", plan: undefined, parked: [], now: h.now(), personSaid: "a".repeat(500) });
    expect(long).toContain(`"${"a".repeat(199)}…"`);
    // Nothing they wrote there — a webhook's, a job's — and no line.
    const none = missionPage({ mission, why: "x", plan: undefined, parked: [], now: h.now(), personSaid: null });
    expect(none).not.toContain("Their language is");
  });
});
