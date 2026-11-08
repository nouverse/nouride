/**
 * One conversation, as a file — `docs/SPEC.md` §12.2.
 *
 * The frontmatter is a day summary's format moved onto the conversation it describes, so every field
 * is about one conversation and nothing has to say whose mood or which chat. Links are written as wikilinks so the file is a node in the graph as it stands:
 *
 * ```markdown
 * ---
 * id: 2026-09-25-0459-nouva
 * type: episode
 * status: summarized
 * kind: dm
 * chat: telegram:nouva:5550001111
 * started: "2026-09-25T04:59:44+07:00"
 * ended: "2026-09-25T05:31:10+07:00"
 * day: "[[days/2026/09/2026-09-25]]"
 * agents: ["[[agents/nouva]]"]
 * people: ["[[people/gading]]"]
 * tags: ["[[tags/nouride]]"]
 * importance: 3
 * summary: "Gading asked whether Nouride runs on an old Android phone."
 * ---
 *
 * 04:59 · Gading
 * Nouride bisa dipakein di android lawas gak ya?
 * ```
 *
 * `people` are identities: a person key becomes a link, a sender with no `[[people]]` entry stays a
 * platform id (`telegram:814…`), which is not a file and so not a link. The body is the transcript
 * while it is kept; a compacted episode has none.
 *
 * Pure.
 */

import { frontList, frontText, link, parseFront, renderFront, unlink, type Front } from "./frontmatter.ts";
import { dayPath, EPISODE_ID, isDay } from "./vault.ts";

export type EpisodeStatus = "raw" | "summarized" | "compacted";
export type EpisodeKind = "dm" | "group" | "archive";

export interface Episode {
  id: string;
  status: EpisodeStatus;
  kind: EpisodeKind;
  /** `<gatewayId>:<chatId>`, the chat it happened in. */
  chat: string;
  started: string;
  ended: string;
  /** `2026-09-25`, in the daemon's time zone. */
  day: string;
  agents: string[];
  /** Who took part: person keys, or platform ids for people without one. */
  people: string[];
  /** Person keys talked about but not present. */
  mentions: string[];
  /** The group's slug, for a group episode. */
  group?: string;
  tags: string[];
  importance?: number;
  related: string[];
  /**
   * The knowledge documents it opened, as `<collection>/<path>` (0.8.23): what the memory graph joins it to. Kept on the
   * file, which is the truth; absent on an episode from before, and on one that opened none.
   */
  documents?: string[];
  summary?: string;
  /** The conversation, while it is kept. */
  transcript: string;
}

/**
 * An episode's `ended` is written to the second, and its last line may be later in that second: the end of the
 * second is where the conversation is certainly over.
 */
export const WITHIN_THE_SECOND_MS = 999;

const STATUSES: readonly EpisodeStatus[] = ["raw", "summarized", "compacted"];
const KINDS: readonly EpisodeKind[] = ["dm", "group", "archive"];

/** A person key links to their profile; a platform id is not a file. */
function personLink(identity: string): string {
  return identity.includes(":") ? identity : link(`people/${identity}`);
}

function stripped(values: string[], folder: string): string[] {
  return values.map(unlink).map((value) => (value.startsWith(`${folder}/`) ? value.slice(folder.length + 1) : value)).filter(Boolean);
}

export function renderEpisode(episode: Episode): string {
  const front: Front = {
    id: episode.id,
    type: "episode",
    status: episode.status,
    kind: episode.kind,
    chat: episode.chat,
    started: episode.started,
    ended: episode.ended,
    day: link(dayPath(episode.day)),
    agents: episode.agents.map((agent) => link(`agents/${agent}`)),
    people: episode.people.map(personLink),
    mentions: episode.mentions.map((key) => link(`people/${key}`)),
    ...(episode.group ? { group: link(`groups/${episode.group}`) } : {}),
    tags: episode.tags.map((tag) => link(`tags/${tag}`)),
    ...(episode.importance !== undefined ? { importance: episode.importance } : {}),
    related: episode.related.map((id) => link(id)),
    ...(episode.documents?.length ? { documents: episode.documents } : {}),
    ...(episode.summary ? { summary: episode.summary } : {}),
  };
  return renderFront(front, episode.transcript);
}

/** The episode a file holds, or why it holds none. `id` is the file's name, which wins over a hand edit of the field. */
export function parseEpisode(text: string, id: string): Episode | { problem: string } {
  if (!EPISODE_ID.test(id)) return { problem: `"${id}" is not an episode id` };
  const parsed = parseFront(text);
  if (!parsed) return { problem: "no frontmatter" };
  const { front, body } = parsed;
  const status = frontText(front, "status") as EpisodeStatus | undefined;
  const kind = frontText(front, "kind") as EpisodeKind | undefined;
  const chat = frontText(front, "chat");
  const started = frontText(front, "started");
  // The day is the link's last segment, and the link is to the hub where `dayPath` puts it: `days/2026/09/2026-09-25`.
  const dayLink = frontList(front, "day").map(unlink)[0];
  const day = dayLink?.split("/").pop();
  if (!status || !STATUSES.includes(status)) return { problem: `status "${status ?? ""}"` };
  if (!kind || !KINDS.includes(kind)) return { problem: `kind "${kind ?? ""}"` };
  if (!chat || !started || !day) return { problem: "chat, started and day are required" };
  // Read by the same rule the day hubs are written by (`vault.ts`): a date fixed by hand as `25-09-2026`
  // was accepted here and then stopped every reindex, and every delete beside it, at its hub.
  if (!isDay(day)) return { problem: `day "${day}" is not YYYY-MM-DD` };
  // 0.6 linked the hub flat, `days/2026-09-25`; every 0.7.x relinked it on its first start. One still flat — a file
  // copied back from an old vault — is reported rather than read: its link leads to no hub.
  if (dayLink !== dayPath(day)) return { problem: `day "${dayLink}" is not where its hub is: link it as [[${dayPath(day)}]]` };
  const importance = Number(front.importance);
  const group = stripped(frontList(front, "group"), "groups")[0];
  const summary = frontText(front, "summary");
  // A document's key is its collection and its path: a value without the `/` between them is no document.
  const documents = frontList(front, "documents").filter((document) => document.indexOf("/") > 0);
  return {
    id,
    status,
    kind,
    chat,
    started,
    ended: frontText(front, "ended") ?? started,
    day,
    agents: stripped(frontList(front, "agents"), "agents"),
    people: stripped(frontList(front, "people"), "people"),
    mentions: stripped(frontList(front, "mentions"), "people"),
    ...(group ? { group } : {}),
    tags: stripped(frontList(front, "tags"), "tags"),
    ...(Number.isInteger(importance) && importance >= 1 && importance <= 5 ? { importance } : {}),
    related: frontList(front, "related").map(unlink).filter((related) => EPISODE_ID.test(related)),
    ...(documents.length ? { documents } : {}),
    ...(summary ? { summary } : {}),
    transcript: body.trim() ? `${body.trim()}\n` : "",
  };
}
