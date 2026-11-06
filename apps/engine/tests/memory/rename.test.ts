/**
 * A gateway renamed, in memory: the chat key `<gateway>:<chat>` moves in the vault as well as the index, so a group
 * on the renamed gateway still sees what it said, and the next cut does not file its retained history again.
 *
 * Before 0.7.9 the rename reached neither. Every group on the gateway lost its episodes and its group facts — a group
 * sees an episode only when the chat key matches — and the next pass re-cut every chat on it from the start of the
 * turn log, filing copies, a group's as a DM.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removePath } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { applyRename, planRename } from "@/modules/gateways/rename.ts";
import { audienceOf, canSeeEpisode, canSeeFact, scopeOf } from "@/modules/memory/access.ts";
import { syncIndex } from "@/modules/memory/index-sync.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { factsOf, readProfile } from "@/modules/memory/profile.ts";
import { applyVaultRename, planVaultRename, renameFactReaders, renameFrontChat, renameProposal } from "@/modules/memory/rename.ts";
import { vaultAt } from "@/modules/memory/vault.ts";
import { FAMILY, GADING_DM, at, household, type Household } from "./fixture.ts";
import { tempDir } from "../helpers.ts";

describe("the text of a vault file", () => {
  test("an episode's chat moves however it is quoted, and only in its frontmatter", () => {
    const bare = "---\nid: x\nchat: telegram:bot:-1001\nkind: group\n---\n\n09:00 · Gading\nchat: telegram:bot:-1001 is the group\n";
    expect(renameFrontChat(bare, "telegram:bot", "telegram:nouva")).toBe(
      "---\nid: x\nchat: telegram:nouva:-1001\nkind: group\n---\n\n09:00 · Gading\nchat: telegram:bot:-1001 is the group\n",
    );
    const quoted = '---\nchat: "whatsapp:main:1203@g.us"\n---\n';
    expect(renameFrontChat(quoted, "whatsapp:main", "whatsapp:rumah")).toBe('---\nchat: "whatsapp:rumah:1203@g.us"\n---\n');
    expect(renameFrontChat("---\nchat: 'telegram:bot:1'\n---\n", "telegram:bot", "telegram:nouva")).toBe("---\nchat: 'telegram:nouva:1'\n---\n");
  });

  test("another gateway whose name begins the same is its own", () => {
    const text = "---\nchat: telegram:bot2:-1001\n---\n";
    expect(renameFrontChat(text, "telegram:bot", "telegram:nouva")).toBe(text);
  });

  test("a fact's readers move; what the fact says does not", () => {
    const body = [
      "## Home",
      "- The porch light goes off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:bot:-1001}",
      "- Talks about telegram:bot:-1001 a lot. ([[2026-09-26-1310-nix]]) {gading}",
      "- Written by hand, no readers.",
      "Prose: {in telegram:bot:-1001}",
      "",
    ].join("\n");
    expect(renameFactReaders(body, "telegram:bot", "telegram:nouva")).toBe(
      [
        "## Home",
        "- The porch light goes off at 22:00. ([[2026-09-26-1310-nix]]) {gading, sam, in telegram:nouva:-1001}",
        "- Talks about telegram:bot:-1001 a lot. ([[2026-09-26-1310-nix]]) {gading}",
        "- Written by hand, no readers.",
        "Prose: {in telegram:bot:-1001}",
        "",
      ].join("\n"),
    );
  });

  test("a waiting proposal's readers move — they become the fact's when it is approved", () => {
    const proposal = { id: "abcdef123456", subject: "shared", operation: { op: "add", section: "Home", text: "telegram:bot:-1001 is loud" }, provenance: { source: "e", readers: { people: ["gading"], chat: "telegram:bot:-1001" } } };
    const after = JSON.parse(renameProposal(`${JSON.stringify(proposal, null, 2)}\n`, "telegram:bot", "telegram:nouva"));
    expect(after.provenance.readers.chat).toBe("telegram:nouva:-1001");
    expect(after.operation.text).toBe("telegram:bot:-1001 is loud");
    // Not JSON: left for a person, as the pass leaves it.
    expect(renameProposal("{broken", "telegram:bot", "telegram:nouva")).toBe("{broken");
  });
});

let h: Household | undefined;
afterEach(() => {
  h?.close();
  h = undefined;
});

const FROM = "whatsapp:main";
const TO = "whatsapp:rumah";

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

describe("renaming the gateway a group is on", () => {
  test("the group still sees its episodes and its facts — from the vault, which the index is rebuilt from", async () => {
    h = await household();
    h.group(FAMILY, "Lampu teras jam berapa matinya?", at(13, 9), { agentId: "nix", text: "Mati jam 22:00." });
    expect(await h.memory.cut(FAMILY.gatewayId, FAMILY.chatId)).toBe(1);
    const root = h.config.memory.dir;
    const family = `${FROM}:${FAMILY.chatId}`;
    put(root, "shared.md", `---\ntype: shared\n---\n\n## Home\n- The porch light goes off at 22:00. ([[x]]) {gading, in ${family}}\n`);
    put(root, ".history/shared.md/2026-09-25T00-00-00-000Z.md", `## Home\n- Older. ([[x]]) {gading, in ${family}}\n`);

    const vault = vaultAt(root);
    const plan = await planVaultRename(vault, FROM, TO);
    expect(plan.counts).toEqual({ episodes: 1, groups: 1, profiles: 1, history: 1, proposals: 0, deleted: 0 });
    applyRename(h.db, planRename({ db: h.db, config: "", from: FROM, to: TO, existing: [] }));
    await applyVaultRename(plan);

    // The index as the next boot builds it from nothing but the files.
    const dir = tempDir("rename-reindex");
    const fresh = await openAndMigrate(join(dir, "fresh.db"));
    try {
      const index = new MemoryIndexStore(fresh);
      expect((await syncIndex(vault, index)).problems).toEqual([]);
      const group = audienceOf({ chat: `${TO}:${FAMILY.chatId}`, chatType: "group", person: "gading", present: ["gading"] });
      // Asked the way recall asks — the SQL scope — and the way the access rule answers.
      const [episode, ...rest] = index.episodes({ scope: scopeOf(group) }, 10);
      expect(rest).toEqual([]);
      expect(episode).toMatchObject({ kind: "group", chat: `${TO}:${FAMILY.chatId}` });
      expect(canSeeEpisode({ chat: episode!.chat, people: episode!.participants }, group)).toBe(true);
      // The stub the cut wrote for the group, which is what ties its name to the conversation.
      expect(index.groups().has(`${TO}:${FAMILY.chatId}`)).toBe(true);
      const [fact] = factsOf(readProfile(readFileSync(join(root, "shared.md"), "utf8")).body);
      expect(canSeeFact(fact!, "shared", group)).toBe(true);
      expect(readFileSync(join(root, ".history/shared.md/2026-09-25T00-00-00-000Z.md"), "utf8")).toContain(`in ${TO}:${FAMILY.chatId}`);
    } finally {
      fresh.close();
      removePath(dir);
    }
  });

  test("the next cut files nothing again — the cursor moved with the chat", async () => {
    h = await household();
    h.dm(GADING_DM, "nouva", "Nouride bisa di android lawas?", "Bisa, pakai Termux.", at(9, 0));
    expect(await h.memory.cut(GADING_DM.gatewayId, GADING_DM.chatId)).toBe(1);

    const from = GADING_DM.gatewayId;
    const to = "telegram:nova";
    applyRename(h.db, planRename({ db: h.db, config: "", from, to, existing: [] }));
    await applyVaultRename(await planVaultRename(vaultAt(h.config.memory.dir), from, to));
    // What the rename did to `turn_records`, done to the fixture's stand-in for it.
    for (const exchange of h.exchanges) if (exchange.gatewayId === from) exchange.gatewayId = to;

    expect(await h.memory.cut(to, GADING_DM.chatId)).toBe(0);
  });
});
