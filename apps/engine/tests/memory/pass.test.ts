/**
 * The nightly pass, end to end over a real vault and index: cut the day's chats, file each episode,
 * keep or propose facts by who was there, compact what is past its days, and draw the day hubs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gunzipText, readFileBytes, readTextFileIfExists, writeTextFile } from "@nouride/runtime";
import { FAMILY, GADING_DM, SAM_DM, at, household, scripted, speaker, type Household } from "./fixture.ts";

let h: Household;

beforeEach(async () => {
  h = await household();
});

afterEach(() => h.close());

const profile = async (key: string) => (await readTextFileIfExists(h.vault.person(key))) ?? "";

describe("cutting", () => {
  test("every chat active since its last cut, once; a running turn waits for the next cut", async () => {
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9));
    h.dm(SAM_DM, "nix", "Resep rendang dong", "Ini resepnya.", at(10));
    h.exchanges.push({ gatewayId: "telegram:nouva", chatId: "814", agentId: "nouva", senderId: "814", prompt: "masih jalan", reply: "", startedAt: at(22), endedAt: at(22), running: true });

    expect(await h.memory.cutAll()).toBe(2);
    expect(await h.memory.cutAll()).toBe(0);
    expect(h.memory.episodes({}, 10).map((episode) => episode.id).sort()).toEqual(["2026-09-25-0900-nouva", "2026-09-25-1000-nix"]);

    h.exchanges.at(-1)!.running = false;
    h.exchanges.at(-1)!.reply = "selesai";
    expect(await h.memory.cutAll()).toBe(1);
  });

  test("a conversation not summarized yet is listed by the first thing a person said, a line long", async () => {
    h.dm(GADING_DM, "nouva", `Nouride bisa jalan di android lawas?\nYang RAM-nya 2GB ${"x".repeat(300)}`, "Bisa, pakai Termux.", at(9));
    await h.memory.cutAll();
    const [episode] = h.memory.episodes({}, 10);
    expect(episode?.status).toBe("raw");
    expect(episode?.preview).toStartWith("Nouride bisa jalan di android lawas? Yang RAM-nya 2GB");
    expect(episode?.preview?.length).toBeLessThanOrEqual(160);
    expect(episode?.preview).not.toContain("Termux");
  });

  test("a group's episode: the people from the room log, the agent from its reply, the group stub written once", async () => {
    h.group(FAMILY, "Lampu teras jam berapa matinya?", at(13, 9));
    h.group({ ...FAMILY, senderId: "62877" }, "@nix lampu teras?", at(13, 10), { agentId: "nix", text: "Jam 22:00." });
    await h.memory.cutAll();
    const [episode] = h.memory.episodes({}, 10);
    expect(episode).toMatchObject({ kind: "group", participants: ["gading", "sam"], agents: ["nix"] });
    expect(await readTextFileIfExists(h.vault.group("whatsapp-1203-g-us"))).toContain('chat: "whatsapp:main:1203@g.us"');
  });
});

describe("filing", () => {
  test("a summary, tags and a fact kept with where it came from and who may read it", async () => {
    h.dm(GADING_DM, "nouva", "Aku pakai MacBook M3 sekarang", "Oke, dicatat.", at(9));
    const model = scripted([
      { when: "MacBook", answer: { summary: "Gading switched to a MacBook M3.", tags: ["#Hardware", "chat"], importance: 3, facts: [{ person: "gading", op: "add", section: "Work", text: "Uses a MacBook M3." }] } },
    ]);
    const report = await h.memory.pass(model.ask);
    expect(report).toMatchObject({ cut: 1, filed: 1, applied: 1, proposed: 0, failed: [] });

    const [episode] = h.memory.episodes({}, 10);
    expect(episode).toMatchObject({ status: "summarized", summary: "Gading switched to a MacBook M3.", tags: ["hardware"], importance: 3 });
    expect(await profile("gading")).toContain(`## Work\n- Uses a MacBook M3. ([[${episode!.id}]]) {gading}`);
    // The graph's nodes: the day's hub linking the episode. No stub for a tag one conversation has —
    // it is written on the tag's second use (`graph.ts:ensureStubs`).
    expect(await readTextFileIfExists(h.vault.tag("hardware"))).toBeNull();
    expect(await readTextFileIfExists(h.vault.day("2026-09-25"))).toContain(`[[${episode!.id}]]`);
  });

  test("rewrites, removals and facts about someone absent are kept at once; only shared knowledge waits", async () => {
    h.dm(GADING_DM, "nouva", "Pakai MacBook M3, suka kopi", "Oke.", at(8));
    h.clock.now = at(8, 30);
    await h.memory.pass(scripted([{ when: "M3", answer: { summary: "M3.", facts: [{ person: "gading", op: "add", section: "Work", text: "Pakai MacBook M3." }, { person: "gading", op: "add", section: "Food", text: "Suka kopi." }] } }]).ask);

    h.dm(GADING_DM, "nouva", "Ganti M4, udah ga ngopi", "Oke.", at(12));
    h.clock.now = at(12, 30);
    expect(
      await h.memory.pass(scripted([{ when: "Ganti M4", answer: { summary: "M4.", facts: [{ person: "gading", op: "update", n: 1, text: "Pakai MacBook M4." }, { person: "gading", op: "remove", n: 2 }] } }]).ask),
    ).toMatchObject({ applied: 2, proposed: 0 });
    expect(await profile("gading")).toContain("Pakai MacBook M4. ([[2026-09-25-1200-nouva]]) {gading}");
    expect(await profile("gading")).not.toContain("kopi");

    h.dm(SAM_DM, "nix", "Mas Gading udah ganti laptop, lampu teras mati jam 22", "Oke.", at(20));
    h.clock.now = at(20, 30);
    const report = await h.memory.pass(
      scripted([
        {
          when: "ganti laptop",
          answer: {
            summary: "Sam cerita.",
            facts: [
              { person: "gading", op: "update", n: 1, text: "Pakai MacBook M5." },
              { person: "gading", op: "add", section: "Work", text: "Laptop baru." },
            ],
            shared: [{ op: "add", section: "Rumah", text: "Lampu teras mati jam 22:00." }],
          },
        },
      ]).ask,
    );
    // The update names a fact Sam's conversation was not shown (it came from Gading's DM): dropped.
    // Sam's word about Gading is kept, readable only where she said it. The house rule waits: every
    // agent reads shared knowledge in every chat.
    expect(report).toMatchObject({ applied: 1, proposed: 1, dropped: 1 });
    expect((await h.memory.proposals()).map((p) => [p.subject, p.why])).toEqual([["shared", "shared"]]);
    expect(await profile("gading")).toContain("Laptop baru. ([[2026-09-25-2000-nix]]) {sam}");
    expect(await profile("gading")).toContain("Pakai MacBook M4.");
  });

  test("changes left waiting under ask are kept by the next pass once it is auto again", async () => {
    h.config.memory.facts = "ask";
    h.dm(GADING_DM, "nouva", "Aku alergi kacang, lampu teras jam 22", "Dicatat.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "alergi", answer: { summary: "Alergi.", facts: [{ person: "gading", op: "add", section: "Health", text: "Alergi kacang." }], shared: [{ op: "add", section: "House", text: "Porch light at 22:00." }] } }]).ask);
    expect(await h.memory.proposals()).toHaveLength(2);

    h.config.memory.facts = "auto";
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ applied: 1 });
    expect(await profile("gading")).toContain("Alergi kacang.");
    expect((await h.memory.proposals()).map((p) => p.subject)).toEqual(["shared"]);
    expect((await h.memory.search(speaker(GADING_DM), { query: "kacang" }))[0]).toMatchObject({ kind: "fact" });
  });

  test("the model sees only the facts this conversation's audience may read", async () => {
    h.dm(SAM_DM, "nix", "Aku hamil, jangan bilang siapa-siapa", "Rahasia aman.", at(9));
    await h.memory.pass(scripted([{ when: "hamil", answer: { summary: "Sam cerita kabar pribadi.", facts: [{ person: "sam", op: "add", section: "Life", text: "Sedang hamil." }] } }]).ask);
    expect(await profile("sam")).toContain("Sedang hamil. ([[2026-09-25-0900-nix]]) {sam}");

    h.group({ ...FAMILY, senderId: "62877" }, "Masak apa malam ini?", at(18), { agentId: "nouva", text: "Rendang." });
    const model = scripted([]);
    await h.memory.pass(model.ask);
    const prompt = model.asked.find((ask) => ask.user.includes("Masak apa"))!.user;
    expect(prompt).not.toContain("hamil");
  });

  test("the owner's word about someone absent is kept, readable only where the owner was", async () => {
    h.dm(GADING_DM, "nouva", "Sam mau pindah ke Bandung", "Oke.", at(9));
    await h.memory.pass(scripted([{ when: "Bandung", answer: { summary: "Sam is moving.", mentions: ["sam"], facts: [{ person: "sam", op: "add", section: "Life", text: "Moving to Bandung." }] } }]).ask);
    expect(await profile("sam")).toContain("Moving to Bandung. ([[2026-09-25-0900-nouva]]) {gading}");
    expect(h.memory.episodes({}, 10)[0]).toMatchObject({ mentions: ["sam"] });
  });

  test("facts = ask proposes every change; off keeps none", async () => {
    h.config.memory.facts = "ask";
    h.dm(GADING_DM, "nouva", "Aku alergi kacang", "Dicatat.", at(9));
    await h.memory.pass(scripted([{ when: "alergi", answer: { summary: "Alergi.", facts: [{ person: "gading", op: "add", section: "Health", text: "Alergi kacang." }] } }]).ask);
    expect((await h.memory.proposals()).map((p) => p.why)).toEqual(["review"]);

    h.config.memory.facts = "off";
    // Later than the first pass's cut, as a real turn always is.
    h.dm(GADING_DM, "nouva", "Aku suka kopi", "Oke.", at(23, 10));
    h.clock.now = at(23, 30);
    expect(await h.memory.pass(scripted([{ when: "kopi", answer: { summary: "Kopi.", facts: [{ person: "gading", op: "add", section: "Food", text: "Suka kopi." }] } }]).ask)).toMatchObject({ applied: 0, dropped: 1 });
  });

  test("a person's own facts overrides [memory] facts, either way", async () => {
    h.config.memory.facts = "off";
    h.config.people.find((person) => person.key === "gading")!.facts = "auto";
    h.dm(GADING_DM, "nouva", "Aku suka kopi, Sam pindah ke Bandung", "Oke.", at(9));
    const answer = { summary: "Kopi.", mentions: ["sam"], facts: [{ person: "gading", op: "add", section: "Food", text: "Suka kopi." }, { person: "sam", op: "add", section: "Life", text: "Moving to Bandung." }] };
    expect(await h.memory.pass(scripted([{ when: "kopi", answer }]).ask)).toMatchObject({ applied: 1, dropped: 1 });
    expect(await profile("gading")).toContain("Suka kopi.");
    expect(await profile("sam")).not.toContain("Bandung");

    h.config.memory.facts = "auto";
    h.config.people.find((person) => person.key === "gading")!.facts = "off";
    h.dm(GADING_DM, "nouva", "Aku alergi kacang", "Dicatat.", at(23, 10));
    h.clock.now = at(23, 30);
    expect(await h.memory.pass(scripted([{ when: "alergi", answer: { summary: "Alergi.", facts: [{ person: "gading", op: "add", section: "Health", text: "Alergi kacang." }] } }]).ask)).toMatchObject({ applied: 0, dropped: 1 });
    expect(await profile("gading")).not.toContain("kacang");
  });

  test("shared knowledge is proposed only with propose_shared, whatever facts is", async () => {
    h.config.memory.proposeShared = false;
    h.dm(GADING_DM, "nouva", "Lampu teras dimatikan jam 22", "Dicatat.", at(9));
    const shared = { summary: "Lampu.", importance: 4, shared: [{ op: "add", section: "House", text: "Porch light off at 22:00." }] };
    await h.memory.pass(scripted([{ when: "Lampu", answer: shared }]).ask);
    expect(await h.memory.proposals()).toHaveLength(0);

    h.config.memory.facts = "off";
    h.config.memory.proposeShared = true;
    h.dm(GADING_DM, "nouva", "Lampu garasi dimatikan jam 23", "Dicatat.", at(23, 10));
    h.clock.now = at(23, 30);
    await h.memory.pass(scripted([{ when: "garasi", answer: { ...shared, shared: [{ op: "add", section: "House", text: "Garage light off at 23:00." }] } }]).ask);
    expect((await h.memory.proposals()).map((p) => p.subject)).toEqual(["shared"]);
  });

  test("an answer with no summary is a failed attempt, retried until it is left for a person", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo juga", at(9));
    const broken = async () => "not json";
    for (let night = 1; night <= 3; night += 1) expect((await h.memory.pass(broken)).failed).toHaveLength(1);
    expect(await h.memory.pass(broken)).toMatchObject({ failed: [], filed: 0 });
    expect(h.memory.failed()).toEqual([{ episodeId: "2026-09-25-0900-nouva", attempts: 3, lastError: "the answer had no usable summary" }]);

    h.memory.retry("2026-09-25-0900-nouva");
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ filed: 1 });
  });

  test("a model that cannot be asked is not held against the conversation: tried again every night until it answers", async () => {
    h.dm(GADING_DM, "nouva", "halo", "halo juga", at(9));
    const down = async () => null;
    for (let night = 1; night <= 5; night += 1) expect((await h.memory.pass(down)).failed).toEqual([{ episode: "2026-09-25-0900-nouva", reason: "the model could not be asked" }]);
    expect(h.memory.failed()).toEqual([]);
    // The model is fixed (another one set, an account added): the next pass files it, no Retry needed.
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ filed: 1, failed: [] });
  });

  test("the queue: direct conversations first, and a cap per agent", async () => {
    h.config.memory.passPerNight = 1;
    h.group(FAMILY, "grup", at(8), { agentId: "nouva", text: "ok" });
    h.dm(GADING_DM, "nouva", "dm", "ok", at(9));
    h.dm(SAM_DM, "nix", "dm sam", "ok", at(10));
    const model = scripted([]);
    const report = await h.memory.pass(model.ask);
    expect(report).toMatchObject({ filed: 2, waiting: 1 });
    expect(model.asked.map((ask) => ask.agentId)).toEqual(["nouva", "nix"]);
    expect(model.asked[0]!.user).toContain("A direct conversation.");
  });

  test("a stop mid-night — today's budget spent — files nothing more and fails nothing", async () => {
    h.dm(GADING_DM, "nouva", "satu", "ok", at(8));
    h.dm(SAM_DM, "nix", "dua", "ok", at(9));
    let calls = 0;
    const report = await h.memory.pass(scripted([]).ask, () => (calls++ > 0 ? "over today's budget" : null));
    expect(report).toMatchObject({ filed: 1, failed: [], waiting: 1, stopped: "over today's budget" });
    expect(h.memory.failed()).toEqual([]);
  });
});

describe("one proposal per change", () => {
  // Rewrites wait only under `facts = "ask"` (and in shared knowledge), so that is where they stack.
  /** Gading's laptop, learned in the family group so both his DM and the group may read it. */
  async function laptopFact() {
    h.group(FAMILY, "Aku pakai MacBook M3", at(8), { agentId: "nouva", text: "Oke." });
    h.clock.now = at(8, 30);
    await h.memory.pass(scripted([{ when: "MacBook M3", answer: { summary: "Laptop.", facts: [{ person: "gading", op: "add", section: "Work", text: "Uses a MacBook M3." }] } }]).ask);
  }

  test("a second rewrite of a fact revises the waiting one, built on it, readable only where both were", async () => {
    await laptopFact();
    h.config.memory.facts = "ask";
    h.group(FAMILY, "RAM laptopku baru", at(12));
    h.group({ ...FAMILY, senderId: "62877" }, "Mas Gading upgrade RAM jadi 32GB", at(12, 5), { agentId: "nouva", text: "Oke." });
    h.clock.now = at(12, 35);
    await h.memory.pass(scripted([{ when: "32GB", answer: { summary: "RAM.", facts: [{ person: "gading", op: "update", n: 1, text: "Uses a MacBook M3 with 32GB RAM." }] } }]).ask);
    const [first] = await h.memory.proposals();

    h.dm(GADING_DM, "nouva", "Laptopku sekarang pakai IP 192.168.0.12", "Dicatat.", at(16));
    h.clock.now = at(16, 30);
    const model = scripted([{ when: "192.168.0.12", answer: { summary: "IP.", facts: [{ person: "gading", op: "update", n: 1, text: "Uses a MacBook M3 with 32GB RAM at 192.168.0.12." }] } }]);
    await h.memory.pass(model.ask);

    // The model was shown the waiting change, so its answer could carry it.
    expect(model.asked.find((ask) => ask.user.includes("192.168.0.12"))!.user).toContain('waiting for approval: change to "Uses a MacBook M3 with 32GB RAM."');
    const proposals = await h.memory.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: first!.id,
      createdAt: first!.createdAt,
      episode: "2026-09-25-1600-nouva",
      current: "Uses a MacBook M3.",
      operation: { op: "update", n: 1, text: "Uses a MacBook M3 with 32GB RAM at 192.168.0.12." },
      // Sam's word is in it, and so is Gading's DM: only Gading's DM may read both.
      provenance: { readers: { people: ["gading"] } },
    });
    expect(proposals[0]!.revisedAt).toBeNumber();
  });

  test("a waiting change the conversation may not see is neither shown nor revised", async () => {
    await laptopFact();
    h.config.memory.facts = "ask";
    h.dm(GADING_DM, "nouva", "Laptopku di IP 192.168.0.12", "Oke.", at(12));
    h.clock.now = at(12, 35);
    await h.memory.pass(scripted([{ when: "192.168.0.12", answer: { summary: "IP.", facts: [{ person: "gading", op: "update", n: 1, text: "Uses a MacBook M3 at 192.168.0.12." }] } }]).ask);

    h.group(FAMILY, "RAM laptopku baru", at(16));
    h.group({ ...FAMILY, senderId: "62877" }, "Mas Gading upgrade RAM jadi 32GB", at(16, 5), { agentId: "nouva", text: "Oke." });
    h.clock.now = at(16, 35);
    const model = scripted([{ when: "32GB", answer: { summary: "RAM.", facts: [{ person: "gading", op: "update", n: 1, text: "Uses a MacBook M3 with 32GB RAM." }] } }]);
    await h.memory.pass(model.ask);

    expect(model.asked.find((ask) => ask.user.includes("32GB"))!.user).not.toContain("192.168.0.12");
    expect((await h.memory.proposals()).map((p) => p.operation)).toEqual([
      { op: "update", n: 1, text: "Uses a MacBook M3 at 192.168.0.12." },
      { op: "update", n: 1, text: "Uses a MacBook M3 with 32GB RAM." },
    ]);
  });

  test("the same addition proposed twice is one proposal, and the model is told it is waiting", async () => {
    const lamp = { summary: "Lamp.", shared: [{ op: "add", section: "House", text: "The porch light turns off at 22:00." }] };
    h.dm(GADING_DM, "nouva", "Lampu teras mati jam 22", "Oke.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "Lampu teras", answer: lamp }]).ask);
    h.dm(GADING_DM, "nouva", "Ingat ya lampu teras jam 22", "Siap.", at(15));
    h.clock.now = at(15, 30);
    const model = scripted([{ when: "Ingat ya", answer: { ...lamp, shared: [{ op: "add", section: "House", text: "the porch light turns off at  22:00." }] } }]);
    await h.memory.pass(model.ask);

    expect(model.asked.find((ask) => ask.user.includes("Ingat ya"))!.user).toContain('+ waiting for approval: add "The porch light turns off at 22:00."');
    expect(await h.memory.proposals()).toHaveLength(1);
  });

  test("the same fact told again in another chat, reworded, revises the waiting one; a different fact does not", async () => {
    const camera = (path: string) => `The CCTV has a primary camera at 192.168.0.31 (RTSP 554, ONVIF) and a secondary at 192.168.0.32; FFmpeg is a static binary at ${path}.`;
    h.dm(GADING_DM, "nouva", "kamera cctv di 192.168.0.31", "Oke.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "kamera cctv", answer: { summary: "CCTV.", shared: [{ op: "add", section: "Homelab", text: camera("~/workspace/bin/ffmpeg") }] } }]).ask);
    const [first] = await h.memory.proposals();

    // Sam's DM cannot see what waits from Gading's, so the model could not have been told.
    h.dm(SAM_DM, "nix", "ffmpeg pindah ke /srv/nouride/.nouride/bin", "Oke.", at(12));
    h.clock.now = at(12, 30);
    await h.memory.pass(
      scripted([
        {
          when: "ffmpeg pindah",
          answer: { summary: "FFmpeg.", shared: [{ op: "add", section: "Homelab", text: camera("/srv/nouride/.nouride/bin/ffmpeg") }, { op: "add", section: "House", text: "The porch light turns off at 22:00." }] },
        },
      ]).ask,
    );

    const proposals = await h.memory.proposals();
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ id: first!.id, episode: "2026-09-25-1200-nix", operation: { text: camera("/srv/nouride/.nouride/bin/ffmpeg") } });
    // Only where both conversations could be read: neither DM's reader is the other's.
    expect(proposals[0]!.provenance.readers.people).toEqual([]);
    expect(proposals[1]!.operation).toMatchObject({ text: "The porch light turns off at 22:00." });
  });

  test("a long session adds at most three facts about a person; keeping facts current is not capped", async () => {
    h.dm(GADING_DM, "nouva", "Sesi kerja panjang", "Oke.", at(9));
    h.clock.now = at(9, 30);
    const facts = Array.from({ length: 6 }, (_, n) => ({ person: "gading", op: "add", section: "Work", text: `Did work item ${n + 1}.` }));
    expect(await h.memory.pass(scripted([{ when: "Sesi kerja", answer: { summary: "A work session.", facts } }]).ask)).toMatchObject({ applied: 3, dropped: 3 });
    expect((await profile("gading")).match(/Did work item/g)).toHaveLength(3);

    const model = scripted([]);
    h.dm(GADING_DM, "nouva", "halo", "halo", at(12));
    h.clock.now = at(12, 30);
    await h.memory.pass(model.ask);
    expect(model.asked[0]!.system).toContain("what was built, fixed, designed or decided inside a piece of work. The summary keeps that");
  });

  test("shared knowledge only from a conversation that mattered, two at most", async () => {
    const house = (n: number) => ({ op: "add", section: "House", text: `House rule number ${n} about ${["shoes", "lights", "trash", "guests"][n]}.` });
    h.dm(GADING_DM, "nouva", "cuma nanya jam", "Jam 9.", at(9));
    h.clock.now = at(9, 30);
    expect(await h.memory.pass(scripted([{ when: "nanya jam", answer: { summary: "Time.", importance: 2, shared: [house(0)] } }]).ask)).toMatchObject({ proposed: 0, dropped: 1 });

    h.dm(GADING_DM, "nouva", "aturan rumah baru", "Dicatat.", at(12));
    h.clock.now = at(12, 30);
    expect(await h.memory.pass(scripted([{ when: "aturan rumah", answer: { summary: "Rules.", importance: 4, shared: [house(1), house(2), house(3)] } }]).ask)).toMatchObject({ proposed: 2, dropped: 1 });
  });

  test("an addition restating a kept fact updates it, or is nothing new; never a second version", async () => {
    h.dm(GADING_DM, "nouva", "laptopku MacBook Air M1 di 192.168.0.12", "Oke.", at(8));
    h.clock.now = at(8, 30);
    await h.memory.pass(scripted([{ when: "MacBook Air", answer: { summary: "Laptop.", facts: [{ person: "gading", op: "add", section: "Hardware", text: "Owns a MacBook Air M1 at 192.168.0.12." }] } }]).ask);

    h.dm(GADING_DM, "nouva", "laptopku sekarang user gadingnst", "Oke.", at(12));
    h.clock.now = at(12, 30);
    const told = await h.memory.pass(
      scripted([{ when: "user gadingnst", answer: { summary: "Laptop user.", facts: [{ person: "gading", op: "add", section: "Hardware", text: "Owns a MacBook Air M1 at 192.168.0.12, user gadingnst." }, { person: "gading", op: "add", section: "Hardware", text: "owns a MacBook Air M1 at 192.168.0.12." }] } }]).ask,
    );
    // The first restates it with something new: it replaces the line. The second says nothing new.
    expect(told).toMatchObject({ applied: 1, dropped: 1 });
    expect((await profile("gading")).match(/MacBook Air/g)).toHaveLength(1);
    expect(await profile("gading")).toContain("- Owns a MacBook Air M1 at 192.168.0.12, user gadingnst. ([[2026-09-25-1200-nouva]])");
  });

  test("a shared addition restating shared knowledge proposes an update of it", async () => {
    await writeTextFile(h.vault.shared, "## House\n- The porch light turns off at 22:00.\n");
    await h.memory.sync();
    h.dm(GADING_DM, "nouva", "lampu teras sekarang jam 23", "Oke.", at(9));
    h.clock.now = at(9, 30);
    await h.memory.pass(scripted([{ when: "lampu teras", answer: { summary: "Lamp.", shared: [{ op: "add", section: "House", text: "The porch light turns off at 23:00." }] } }]).ask);
    expect((await h.memory.proposals()).map((p) => [p.operation, p.current])).toEqual([[{ op: "update", n: 1, text: "The porch light turns off at 23:00." }, "The porch light turns off at 22:00."]]);
  });

  test("the pass writes summaries and facts in English, whatever the conversation was in", async () => {
    h.dm(GADING_DM, "nouva", "Halo", "Halo juga.", at(9));
    h.clock.now = at(9, 30);
    const model = scripted([]);
    await h.memory.pass(model.ask);
    expect(model.asked[0]!.system).toContain("Write the summary and every fact in English, whatever language the conversation was in.");
  });
});

describe("after filing", () => {
  test("a transcript past its days is archived compressed, then dropped from the episode; the summary stays", async () => {
    // Fifteen days old against a week: past it, whatever the default is.
    h.config.memory.transcriptDays = 7;
    h.dm(GADING_DM, "nouva", "hal lama", "ok", at(9, 0, 10));
    await h.memory.pass(scripted([{ when: "hal lama", answer: { summary: "Hal lama." } }]).ask);
    const id = "2026-09-10-0900-nouva";
    expect(h.memory.episodes({}, 10)[0]).toMatchObject({ id, status: "compacted", summary: "Hal lama." });
    const file = await h.memory.episode(id);
    expect(file?.episode.transcript).toBe("");
    expect(file?.archived).toContain("hal lama");
    expect(gunzipText(await readFileBytes(h.vault.archive(id)))).toContain("status: summarized");
  });

  test("what the archive holds is counted for the dashboard, and an empty one is nothing", async () => {
    expect(h.memory.archiveSize()).toEqual({ files: 0, bytes: 0 });
    h.config.memory.transcriptDays = 7;
    h.dm(GADING_DM, "nouva", "hal lama", "ok", at(9, 0, 10));
    await h.memory.pass(scripted([{ when: "hal lama", answer: { summary: "Hal lama." } }]).ask);
    const size = h.memory.archiveSize();
    expect(size.files).toBe(1);
    expect(size.bytes).toBe((await readFileBytes(h.vault.archive("2026-09-10-0900-nouva"))).length);
  });

  test("kept forever (transcript_days = 0), however old it is: not compacted, not archived", async () => {
    h.config.memory.transcriptDays = 0;
    h.dm(GADING_DM, "nouva", "hal lama sekali", "ok", at(9, 0, 10));
    h.clock.now = at(23, 0, 365 * 3);
    await h.memory.pass(scripted([{ when: "hal lama", answer: { summary: "Hal lama." } }]).ask);
    const file = await h.memory.episode("2026-09-10-0900-nouva");
    expect(file?.episode).toMatchObject({ status: "summarized", summary: "Hal lama." });
    expect(file?.episode.transcript).toContain("hal lama sekali");
    expect(await readTextFileIfExists(h.vault.archive("2026-09-10-0900-nouva"))).toBeNull();
  });

  test("switched to forever, a compacted episode gets its transcript back from the archive, summary as it is now", async () => {
    h.config.memory.transcriptDays = 7;
    h.dm(GADING_DM, "nouva", "hal lama sekali", "ok", at(9, 0, 10));
    await h.memory.pass(scripted([{ when: "hal lama", answer: { summary: "Hal lama." } }]).ask);
    const id = "2026-09-10-0900-nouva";
    expect((await h.memory.episode(id))?.episode.status).toBe("compacted");

    h.config.memory.transcriptDays = 0;
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ restored: 1, compacted: 0 });
    const back = await h.memory.episode(id);
    expect(back?.episode).toMatchObject({ status: "summarized", summary: "Hal lama." });
    expect(back?.episode.transcript).toContain("hal lama sekali");
    expect(await readFileBytes(h.vault.archive(id))).toBeDefined();
    expect(h.memory.episodes({}, 10)[0]).toMatchObject({ id, status: "summarized" });
    // Once back, the next pass has nothing left to restore.
    expect(await h.memory.pass(scripted([]).ask)).toMatchObject({ restored: 0 });
  });

  test("without archive, the transcript is simply dropped", async () => {
    h.config.memory.archive = false;
    h.config.memory.transcriptDays = 7;
    h.dm(GADING_DM, "nouva", "hal lama", "ok", at(9, 0, 10));
    await h.memory.pass(scripted([]).ask);
    expect(await readTextFileIfExists(h.vault.archive("2026-09-10-0900-nouva"))).toBeNull();
    expect((await h.memory.episode("2026-09-10-0900-nouva"))?.episode.status).toBe("compacted");
  });

  test("a stretch across days is one episode per day, and day hubs link their neighbours", async () => {
    h.dm(GADING_DM, "nouva", "senin", "ok", at(9, 0, 21));
    h.dm(GADING_DM, "nouva", "kamis", "ok", at(9, 0, 24));
    await h.memory.pass(scripted([]).ask);
    // One chat, no pass in between — the daemon was down — and still two episodes, one per day.
    expect(h.memory.episodes({}, 10).map((episode) => episode.day)).toEqual(["2026-09-24", "2026-09-21"]);
    const hub = (await readTextFileIfExists(h.vault.day("2026-09-24"))) ?? "";
    expect(hub).toContain('previous: "[[days/2026/09/2026-09-21]]"');
    expect(hub).not.toContain("next:");
    expect(await readTextFileIfExists(h.vault.day("2026-09-21"))).toContain('next: "[[days/2026/09/2026-09-24]]"');
  });
});

describe("what one call reads", () => {
  test("a message of any size is kept by its head and tail, so no episode outgrows one call", async () => {
    const log = `START ${"x".repeat(200_000)} END`;
    h.dm(GADING_DM, "nouva", `tolong cek log ini\n${log}`, "Sudah dicek.", at(9));
    const model = scripted([]);
    await h.memory.pass(model.ask);
    const prompt = model.asked[0]!.user;
    expect(prompt).toContain("tolong cek log ini");
    expect(prompt).toContain("END");
    expect(prompt).toMatch(/\[… \d+ characters left out …\]/);
    expect(prompt.length).toBeLessThan(20_000);
  });
});

describe("whether the pass runs", () => {
  test("is [memory] pass alone", async () => {
    expect(h.memory.passing()).toBe(true);
    h.config.memory.pass = false;
    expect(h.memory.passing()).toBe(false);
  });
});
