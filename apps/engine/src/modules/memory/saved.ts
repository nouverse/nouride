/**
 * A conversation another tool saves — Claude Code, an editor, over MCP (`memory_save_conversation`).
 *
 * Condensed by the client's model to what is worth remembering, and kept in exactly the shape of every
 * other conversation here: its turns become the same entries a chat is cut into, and `episodesOf`
 * writes them — the same transcript lines (`HH:MM · Name`), the same split by day and size, the same
 * ids, a raw episode the nightly pass files like any other. The person is the token's; the replies
 * are the client's, under the agent it saved for, so recall finds it where it finds that agent's.
 *
 * A `session` makes it one conversation however often it is saved: saving again replaces what was
 * kept for that session, with whatever it had taught, and it is filed again that night.
 */

import { fileExistsSync } from "@nouride/runtime";
import type { Person } from "@nouride/shared";
import { episodesOf, type Entry } from "./cut.ts";
import { creatingEpisodes } from "./episodes.ts";
import { ensureStubs } from "./graph.ts";
import { deleteEpisodes } from "./maintain.ts";
import type { MemoryIndexPort } from "./memory-index.store.ts";
import type { MemoryStatePort } from "./memory-state.store.ts";
import type { MemoryVectorPort } from "./memory-vectors.store.ts";
import { nameOf } from "./people.ts";
import { slugOf, type Vault } from "./vault.ts";
import { writeEpisode } from "./write.ts";

/**
 * Characters a saved conversation may carry. Enough for the points of a long session; not enough to
 * paste one whole — a client that tries is told to condense.
 */
export const SAVED_MAX_CHARS = 12_000;

export interface SavedTurn {
  role: "user" | "assistant";
  text: string;
}

export interface SaveRequest {
  /** The token's person, by key. */
  person: string;
  /** The agent it is saved for. */
  agentId: string;
  /** The client, as its replies are named: `claude_code`. */
  label: string;
  session?: string;
  turns: readonly SavedTurn[];
}

export async function saveConversation(
  deps: { vault: Vault; index: MemoryIndexPort; state: Pick<MemoryStatePort, "forget" | "recordChanges">; vectors?: MemoryVectorPort; people: readonly Person[]; timeZone: string; now: () => number },
  request: SaveRequest,
): Promise<{ saved: string[]; replaced: number } | { refused: string }> {
  const turns = request.turns.map((turn) => ({ role: turn.role, text: turn.text.trim() })).filter((turn) => turn.text);
  if (!turns.some((turn) => turn.role === "user") || !turns.some((turn) => turn.role === "assistant")) {
    return { refused: "A conversation needs at least one user turn and one assistant turn." };
  }
  const size = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  if (size > SAVED_MAX_CHARS) {
    return { refused: `That is ${size} characters; a saved conversation holds ${SAVED_MAX_CHARS}. Condense it to the points worth remembering, not the whole chat.` };
  }

  const session = request.session ? slugOf(request.session) : undefined;
  const chat = { gatewayId: "mcp", chatId: session ? `${request.label}:${session}` : request.label };
  // One instant per turn, in order: the turns are the points of a conversation, not its timing.
  const now = deps.now();
  const entries: Entry[] = turns.map((turn, n) =>
    turn.role === "user"
      ? { at: now + n, who: request.person, name: nameOf(deps.people, request.person), agent: false, text: turn.text }
      : { at: now + n, who: request.agentId, name: request.label, agent: true, text: turn.text },
  );

  // Ids chosen and written in turn with every other writer of new episodes, so two saves at once — or a
  // save while a chat is cut — never pick the same one.
  return await creatingEpisodes(deps.vault, async () => {
    const before = session ? deps.index.episodes({ scope: { chat: `mcp:${chat.chatId}` } }, 1_000).map((episode) => episode.id) : [];
    await deleteEpisodes(deps, before);

    const saved: string[] = [];
    for (const episode of episodesOf({ chat, kind: "dm", entries, timeZone: deps.timeZone, taken: (id) => fileExistsSync(deps.vault.episode(id)) })) {
      await writeEpisode(deps, episode);
      await ensureStubs(deps.vault, episode);
      saved.push(episode.id);
    }
    return { saved, replaced: before.length };
  });
}
