/**
 * Memory, built once for the process (`docs/SPEC.md` §12).
 *
 * Here rather than in `index.ts` because the stores need the database handle, which only boot holds,
 * and because the adapters below are where memory meets the rest of the daemon:
 *
 * - **The turn and room logs** it cuts episodes from, as `ActivitySource`. A scheduled job's prompt
 *   is left without a sender here, so a reminder is never mistaken for a person taking part.
 * - **Who has been speaking in a group**, from the room log, so a group's prompt carries the profiles
 *   of the people actually in the conversation.
 * - **Embeddings**, resolved per call from `[memory.semantic]` — memory itself knows nothing about
 *   providers. Every call is recorded in the usage table under the agent id `memory`, so what search
 *   costs shows up where spend is read.
 *
 * The index is synced with the vault before anything reads it, so files edited while the daemon was
 * down are what memory answers from. And before that, before anything touches the vault at all, its
 * format is read: one this build does not read — 0.6's, or one a newer build wrote — refuses the boot
 * (`modules/memory/format.ts`). The daemon reads it once already, before the database is migrated
 * (`checkMemoryVault`), so a refused vault leaves the schema as it was too.
 */

import { ensureDir, join, type SqliteDb } from "@nouride/runtime";
import { contained, createLogger, type GlobalConfig } from "@nouride/shared";
import type { RoomMessagesPort } from "@/modules/chat-events/room-messages.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import { keyEveryone, movePeopleToFiles, type PeopleWriteDeps } from "@/modules/config/settings/people.ts";
import { vaultBackupDir } from "@/modules/memory/backup.ts";
import { checkVaultFormat, markVault, VAULT_FORMAT, type FoundFormat } from "@/modules/memory/format.ts";
import { createMemory, knowledgeDirOf, KnowledgeStore, type KnowledgeDeps, type Memory } from "@/modules/memory/index.ts";
import { MemoryAnalyticsStore } from "@/modules/memory/memory-analytics.store.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { MemoryStateStore } from "@/modules/memory/memory-state.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { vaultAt } from "@/modules/memory/vault.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("memory");

/** Room messages looked at to say who is in a group's conversation now. */
const RECENT_SPEAKERS = 30;

/**
 * The vault's format, refused when this build does not read it — before anything writes: the database's migrations
 * too, so a vault refused at 0.8.0 does not leave a schema the release before it would refuse in turn.
 */
export async function checkMemoryVault(config: GlobalConfig): Promise<FoundFormat> {
  const vault = vaultAt(config.memory.dir);
  const found = await checkVaultFormat(vault, vaultBackupDir(config.daemon.dataDir));
  if (found.unreadable) log.warn("the memory vault's format file could not be read, so its format was taken from its files", { file: vault.formatFile, problem: found.unreadable, format: found.format });
  return found;
}

export async function bootMemory(
  config: GlobalConfig,
  db: SqliteDb,
  with_: {
    turns: Pick<TurnsPort, "exchangesBetween" | "chatsActiveSince">;
    roomMessages: Pick<RoomMessagesPort, "between" | "isRoom" | "forChat">;
    providers: Pick<ProviderRegistry, "get">;
    usage?: Pick<UsagePort, "record" | "since">;
    /** Where `[[people]]` is written, so an entry from before keys existed can be given one (`keyEveryone`). */
    people?: PeopleWriteDeps;
    /** What `checkMemoryVault` found, read before the database was opened. */
    vaultFormat: FoundFormat;
    /** The knowledge base's admins and its wait for room, filled in once boot has them (0.8.20). */
    knowledge?: Pick<KnowledgeDeps, "admins" | "room">;
    /** The built-in skills, whose `document-reading` reads PDF and Office files for the knowledge base. */
    builtinSkillsDir?: string;
    /** The audit log, where a conversation's opened documents are read from when it is filed (0.8.23). */
    audit?: Pick<AuditLog, "documentsOpened">;
  },
): Promise<Memory> {
  const { turns, roomMessages, providers, usage, vaultFormat } = with_;
  ensureDir(config.memory.dir);
  const knowledgeRoot = knowledgeDirOf(config.daemon.dataDir);
  ensureDir(knowledgeRoot);
  const vault = vaultAt(config.memory.dir);
  if (with_.people) {
    await keyEveryone(with_.people);
    // People one file each (0.8.18): moved once, keyed first so each file is named by the key it already had.
    await movePeopleToFiles(with_.people);
  }
  const memory = createMemory({
    config,
    index: new MemoryIndexStore(db),
    analytics: new MemoryAnalyticsStore(db),
    state: new MemoryStateStore(db),
    vectors: new MemoryVectorStore(db),
    source: {
      exchangesBetween: (gatewayId, chatId, after, until) =>
        turns.exchangesBetween(gatewayId, chatId, after, until).map(({ senderId, ...exchange }) => ({
          ...exchange,
          ...(senderId && senderId !== SYSTEM_SENDER ? { senderId } : {}),
        })),
      roomMessagesBetween: (gatewayId, chatId, after, until) =>
        roomMessages.between(gatewayId, chatId, after, until).filter((message) => message.senderId !== SYSTEM_SENDER),
      isRoom: (gatewayId, chatId) => roomMessages.isRoom(gatewayId, chatId),
      chatsActiveSince: (after) => turns.chatsActiveSince(after),
      ...(with_.audit ? { documentsOpenedBetween: with_.audit.documentsOpened.bind(with_.audit) } : {}),
    },
    speakersIn: (gatewayId, chatId) => [...new Set(roomMessages.forChat(gatewayId, chatId, RECENT_SPEAKERS).map((message) => message.senderId))],
    embed: embedder({ providers, usage, config }),
    // Without boot's answers (a test's memory), nobody is an admin: a folder with no settings is searched by nobody.
    knowledge: {
      root: knowledgeRoot,
      store: new KnowledgeStore(db),
      admins: () => [],
      ...with_.knowledge,
      ...(with_.builtinSkillsDir ? { office: { script: join(with_.builtinSkillsDir, "document-reading", "scripts", "doc.py"), cacheDir: join(config.daemon.dataDir, "knowledge") } } : {}),
    },
  });
  // A new vault, or one whose marker could not be read, says from now on what its files already showed.
  if (!vaultFormat.marked) await markVault(vault, VAULT_FORMAT);
  const synced = await memory.sync();
  if (synced.episodes || synced.profiles || synced.dropped) log.info("memory index synced with the vault", { ...synced, problems: synced.problems.length });
  const pruned = await memory.pruneStubs();
  if (pruned) log.info("memory tag stubs no two conversations share were removed", { removed: pruned });
  // Files put in the knowledge folder while the daemon was down are what it answers from (0.8.20).
  const known = await memory.knowledge.sync();
  if (known.indexed || known.dropped) log.info("knowledge base synced with its folder", { ...known });
  return memory;
}

/** How often the knowledge folder is looked at for files a sync tool or a person put there by hand: a stat each. */
const KNOWLEDGE_LOOK_MS = 5 * 60_000;

/**
 * The knowledge folder, looked at every few minutes: a document dropped in by Syncthing, git or a
 * share is searchable minutes later. The dashboard, the command line and `memory_write` sync what they change at once.
 */
export function startKnowledgeLook(memory: Pick<Memory, "knowledge">): ReturnType<typeof setInterval> {
  return setInterval(
    contained(log, "could not look at the knowledge folder", () => {
      void memory.knowledge.sync().catch((err: unknown) => log.warn("the knowledge base could not be synced with its folder", { error: String(err) }));
    }),
    KNOWLEDGE_LOOK_MS,
  );
}

/**
 * Memory's embeddings, through the semantic provider: metered as `embedding` — an estimate said to be one when the
 * provider reported nothing — and past today's cap not asked at all: a catch-up of thousands of items, a
 * search's query. Null is "by words alone", which every caller already handles.
 */
export function embedder(deps: {
  providers: Pick<ProviderRegistry, "get">;
  usage?: Pick<UsagePort, "record" | "since">;
  config: Parameters<typeof todaysVerdict>[1];
}): (semantic: { provider: string; model: string; dimensions: number }, texts: string[]) => Promise<number[][] | null> {
  return async (semantic, texts) => {
    if (todaysVerdict(deps.usage, deps.config).action === "refuse") {
      log.info("embedding skipped: over today's cap, so searching by words alone", { provider: semantic.provider });
      return null;
    }
    try {
      const provider = metered(deps.providers.get(semantic.provider), meter(deps.usage, { agentId: "memory", provider: semantic.provider, purpose: "embedding" }));
      if (!provider.embed) {
        log.warn("the semantic search provider has no embeddings", { provider: semantic.provider });
        return null;
      }
      return (await provider.embed({ model: semantic.model, input: texts, dimensions: semantic.dimensions })).vectors;
    } catch (err) {
      // Not "by words alone" any more: a search ranked by the model before a change goes on with the model in use.
      log.warn("memory embedding failed", { provider: semantic.provider, model: semantic.model, error: String(err) });
      return null;
    }
  };
}
