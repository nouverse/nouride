/**
 * A household for memory tests: a real database and vault, a turn log and room log to cut from, and
 * three places to speak from — the admin's DM (`GADING_DM`), the family group, Sam's DM with another agent.
 *
 * The logs are in-memory stand-ins for `TurnStore` and `RoomMessageStore`, shaped exactly like the
 * adapter `boot/memory.ts` builds, so a test drives memory the way the daemon does: say things, cut,
 * run the pass with a scripted model, then ask.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flattenSystem, systemBlocks } from "@nouride/llm";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatType, GlobalConfig, Person, SystemBlock } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { renderEpisode, type Episode } from "@/modules/memory/episode.ts";
import { createMemory, type Memory, type Speaker } from "@/modules/memory/index.ts";
import { MemoryAnalyticsStore } from "@/modules/memory/memory-analytics.store.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { KnowledgeStore } from "@/modules/memory/knowledge/knowledge.store.ts";
import type { ActivitySource } from "@/modules/memory/run.ts";
import { vaultAt, type Vault } from "@/modules/memory/vault.ts";
import { tempDir } from "../helpers.ts";

export const TZ = "Asia/Jakarta";

/** 2026-09-25 at hh:mm in Jakarta. */
export const at = (hh: number, mm = 0, day = 25) => Date.UTC(2026, 8, day, hh - 7, mm);

const PEOPLE: Person[] = [
  { key: "gading", ids: ["telegram:814", "whatsapp:62811"], name: "Gading" },
  { key: "sam", ids: ["telegram:777", "whatsapp:62877"], name: "Kak Sam" },
  { key: "raka", ids: ["discord:444"], name: "Raka" },
];

/** Where each is talking from, as a speaker minus the agent. */
export const GADING_DM = { gatewayId: "telegram:nouva", senderId: "814", chatId: "814", chatType: "dm" as ChatType };
export const SAM_DM = { gatewayId: "telegram:nix", senderId: "777", chatId: "777", chatType: "dm" as ChatType };
export const FAMILY = { gatewayId: "whatsapp:main", senderId: "62811", chatId: "1203@g.us", chatType: "group" as ChatType };

export const speaker = (where: typeof GADING_DM, agentId = "nouva"): Speaker => ({ agentId, ...where });

interface Exchange {
  gatewayId: string;
  chatId: string;
  agentId: string;
  senderId?: string;
  prompt: string;
  reply: string;
  startedAt: number;
  endedAt: number;
  running?: boolean;
}

interface RoomMessage {
  gatewayId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  at: number;
}

export interface Household {
  dir: string;
  db: SqliteDb;
  memory: Memory;
  /**
   * The vector store memory was built with — the table's one writer, as in the daemon, which holds what it read in
   * memory. A test writes vectors through this one; another store over `db` is only for reading what the file holds.
   */
  vectors: MemoryVectorStore;
  /**
   * The vault's files, by the same layout memory writes them in. A test's own: nothing outside `modules/memory` is
   * handed a path into the vault, so a test that reads a file or writes one by hand builds it from the config.
   */
  vault: Vault;
  config: Pick<GlobalConfig, "memory" | "people" | "daemon">;
  /** The knowledge folder (0.8.20): a test writes collections and documents here, then syncs. The person of `GADING_DM` is its one admin. */
  knowledgeRoot: string;
  clock: { now: number };
  /** A DM question and its answer. */
  dm(where: typeof GADING_DM, agentId: string, prompt: string, reply: string, when: number): void;
  /** Something said in a group, and optionally an agent's reply to it. */
  group(where: typeof FAMILY, text: string, when: number, reply?: { agentId: string; text: string }): void;
  exchanges: Exchange[];
  close(): void;
}

export async function household(
  options: {
    /** Embeddings, by the model asked — `[memory.semantic]` in use, or the one a vector key names. */
    embed?: (texts: string[], semantic: { provider: string; model: string; dimensions: number }) => number[][] | null;
    /** The turn and room logs as memory sees them, changed — one that breaks for one chat, say. */
    source?: (logs: ActivitySource) => ActivitySource;
    /** The knowledge base's wait for room on the box, before each batch of embeddings (0.8.20). */
    knowledgeRoom?: () => Promise<unknown>;
  } = {},
): Promise<Household> {
  const dir = tempDir("memory");
  const db = await openAndMigrate(join(dir, "test.db"));
  const config = {
    // Running and learning: these tests are about what the pass keeps. The shipped defaults do neither.
    memory: { ...structuredClone(DEFAULT_CONFIG.memory), dir: join(dir, "memory"), pass: true, facts: "auto" as const, proposeShared: true },
    people: structuredClone(PEOPLE),
    // Its own data directory: the default is relative, and a backup written there lands in the checkout's.
    daemon: { ...DEFAULT_CONFIG.daemon, timezone: TZ, dataDir: join(dir, "data") },
  };
  if (options.embed) config.memory.semantic = { enabled: true, provider: "fake", model: "vec", dimensions: 4 };
  const exchanges: Exchange[] = [];
  const messages: RoomMessage[] = [];
  const clock = { now: at(23, 0) };

  const source: ActivitySource = {
    exchangesBetween: (gatewayId, chatId, after, until) =>
      exchanges
        .filter((e) => e.gatewayId === gatewayId && e.chatId === chatId && e.startedAt > after && e.startedAt <= until && !e.running)
        .sort((a, b) => a.startedAt - b.startedAt),
    roomMessagesBetween: (gatewayId, chatId, after, until) =>
      messages.filter((m) => m.gatewayId === gatewayId && m.chatId === chatId && m.at > after && m.at <= until).sort((a, b) => a.at - b.at),
    isRoom: (gatewayId, chatId) => messages.some((m) => m.gatewayId === gatewayId && m.chatId === chatId),
    chatsActiveSince: (after) => {
      const chats = new Map<string, { gatewayId: string; chatId: string; runningSince: number | null }>();
      for (const e of exchanges) {
        if (e.startedAt <= after) continue;
        const key = `${e.gatewayId}|${e.chatId}`;
        const known = chats.get(key) ?? { gatewayId: e.gatewayId, chatId: e.chatId, runningSince: null };
        if (e.running) known.runningSince = Math.min(known.runningSince ?? e.startedAt, e.startedAt);
        chats.set(key, known);
      }
      return [...chats.values()];
    },
  };

  const vectors = new MemoryVectorStore(db, () => clock.now);
  const memory = createMemory({
    config,
    index: new MemoryIndexStore(db),
    analytics: new MemoryAnalyticsStore(db),
    state: new MemoryStateStore(db),
    vectors,
    source: options.source ? options.source(source) : source,
    speakersIn: (gatewayId, chatId) => [...new Set(messages.filter((m) => m.gatewayId === gatewayId && m.chatId === chatId).map((m) => m.senderId))],
    ...(options.embed ? { embed: async (semantic: { provider: string; model: string; dimensions: number }, texts: string[]) => options.embed!(texts, semantic) } : {}),
    now: () => clock.now,
    knowledge: { root: join(dir, "knowledge"), store: new KnowledgeStore(db), admins: () => ["gading"], ...(options.knowledgeRoom ? { room: { wait: options.knowledgeRoom } } : {}) },
  });

  return {
    dir,
    db,
    memory,
    vectors,
    vault: vaultAt(config.memory.dir),
    config,
    knowledgeRoot: join(dir, "knowledge"),
    clock,
    exchanges,
    dm(where, agentId, prompt, reply, when) {
      exchanges.push({ gatewayId: where.gatewayId, chatId: where.chatId, agentId, senderId: where.senderId, prompt, reply, startedAt: when, endedAt: when + 30_000 });
    },
    group(where, text, when, reply) {
      messages.push({ gatewayId: where.gatewayId, chatId: where.chatId, senderId: where.senderId, text, at: when });
      if (reply) exchanges.push({ gatewayId: where.gatewayId, chatId: where.chatId, agentId: reply.agentId, senderId: where.senderId, prompt: text, reply: reply.text, startedAt: when, endedAt: when + 30_000 });
    },
    close() {
      db.close();
      removePath(dir);
    },
  };
}

/** An episode's file put in the vault by hand — as a restore, a sync tool or a person leaves one — for the next sync to find. */
export function plant(vault: Vault, episode: Episode): void {
  const file = vault.episode(episode.id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderEpisode(episode));
}

/** A model that answers every episode from a script: by what the transcript contains, else a plain summary. */
export function scripted(answers: { when: string; answer: Record<string, unknown> }[], fallback: Record<string, unknown> = { summary: "A conversation.", tags: [], importance: 2 }) {
  // `system` as one string, as a provider without cache hints reads it; `blocks` as the pass sent it.
  const asked: { agentId: string; system: string; blocks: SystemBlock[]; user: string }[] = [];
  const ask = async (agentId: string, prompt: { system: string | SystemBlock[]; user: string }) => {
    asked.push({ agentId, system: flattenSystem(prompt.system), blocks: systemBlocks(prompt.system), user: prompt.user });
    const hit = answers.find((candidate) => prompt.user.includes(candidate.when));
    return JSON.stringify(hit ? hit.answer : fallback);
  };
  return { ask, asked };
}
