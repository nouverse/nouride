/**
 * The dashboard's graph of memory: conversations, and the people, tags and agents they link to — and, as a layer asked
 * for (0.8.20, KNOWLEDGE_BASE §12), the knowledge base's collections and documents.
 *
 * Not the vault's own graph (`graph.ts` writes the stubs and day hubs a markdown editor draws). This
 * one is read from the index and built small on purpose — the browser lays it out, so the daemon
 * only answers with ids, short labels and pairs:
 *
 * - **Bounded**: the newest `limit` episodes a filter matches, never the whole vault.
 * - **Light**: a label is the summary's first line, cut short. A conversation is read whole only when
 *   someone opens it, through `/memory/episodes/:id`.
 * - **Readable**: a tag only one shown conversation has is left out — it links nothing to anything,
 *   and on a real vault three tags in four are like that.
 * - **Cached**: by the filter and the index's revision, so a graph is built once per change to the
 *   vault — in practice once a night, after the pass — however often it is opened.
 */

import type { Person } from "@nouride/shared";
import type { EpisodeFilter } from "./episode-filter.ts";
import { documentKey, nearestEach } from "./knowledge/related.ts";
import type { Facet, IndexedEpisode, MemoryIndexPort } from "./memory-index.store.ts";

export type GraphNodeKind = "episode" | "person" | "tag" | "agent" | "collection" | "document";
/**
 * The knowledge layer's: a document in its `collection`, a `link` from one document to another, a document `about` a
 * person, two documents close in meaning (`similar`, drawn dashed), a conversation that `opened` a document, and a
 * document's own `tag` (0.8.23).
 */
export type GraphLinkKind = "agent" | "participant" | "mention" | "tag" | "related" | "collection" | "link" | "about" | "similar" | "opened";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** How many shown conversations link to it; for a conversation, its own links. */
  degree: number;
  /** A conversation's: its day and importance, what the page colours and sizes by. */
  day?: string;
  importance?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  kind: GraphLinkKind;
}

export interface MemoryGraph {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Conversations shown, and how many the filter matched. */
  episodes: number;
  total: number;
  /**
   * The knowledge layer, when it was asked for: the documents shown, how many could have been, and whether documents
   * close in meaning could be drawn — only while search by meaning is on.
   */
  knowledge?: { documents: number; total: number; byMeaning: boolean };
}

/** Several of one kind match any of them; different kinds must all match — Nouva or Nix, and #homelab. */
export type GraphFilter = Pick<EpisodeFilter, "agents" | "people" | "tags" | "since" | "until">;

/** What the graph can be filtered by, across the whole vault — not just what a filter shows. */
export interface MemoryFacets {
  agents: Facet[];
  /** A person by name where they have a profile, else by the identity the index has. */
  people: (Facet & { label: string })[];
  tags: Facet[];
}

const LABEL_MAX = 110;
/** Graphs kept: one per filter someone looked at lately. Small — each is a few hundred kilobytes at most. */
const CACHE_SIZE = 8;
/**
 * Documents the knowledge layer shows at most, whatever the conversations' limit: each is compared with every other
 * shown by meaning, and a few hundred are tens of millions of sums. An estimate of what a small box does in well under a
 * second, not a measurement.
 */
const DOCUMENTS_MAX = 300;

const episodeNode = (id: string) => `e:${id}`;
const personNode = (key: string) => `p:${key}`;
const tagNode = (tag: string) => `t:${tag}`;
const agentNode = (id: string) => `a:${id}`;
const collectionNode = (id: string) => `c:${id}`;
/** `d:<collection>/<path>`: a collection's id has no `/`, so the page reads the two back at the first one. */
const documentNode = (key: string) => `d:${key}`;

function short(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1).trimEnd()}…` : line;
}

/** A person by name when they have a profile; else their identity, which is all the index knows. */
function personLabel(people: readonly Person[], who: string): string {
  return people.find((person) => person.key === who)?.name ?? who;
}

export function buildGraph(episodes: readonly IndexedEpisode[], total: number, people: readonly Person[], keepTags: ReadonlySet<string> = new Set()): MemoryGraph {
  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const shown = new Set(episodes.map((episode) => episode.id));

  const tagCounts = new Map<string, number>();
  for (const episode of episodes) for (const tag of episode.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);

  const hub = (id: string, kind: GraphNodeKind, label: string): void => {
    const node = nodes.get(id);
    if (node) node.degree += 1;
    else nodes.set(id, { id, kind, label, degree: 1 });
  };

  for (const episode of episodes) {
    const id = episodeNode(episode.id);
    nodes.set(id, {
      id,
      kind: "episode",
      label: short(episode.summary ?? episode.preview ?? episode.id),
      degree: 0,
      day: episode.day,
      ...(episode.importance !== undefined ? { importance: episode.importance } : {}),
    });
    for (const agent of episode.agents) {
      hub(agentNode(agent), "agent", agent);
      links.push({ source: id, target: agentNode(agent), kind: "agent" });
    }
    // Someone both taking part and talked about is one link, the stronger one.
    const participants = new Set(episode.participants);
    for (const who of participants) {
      hub(personNode(who), "person", personLabel(people, who));
      links.push({ source: id, target: personNode(who), kind: "participant" });
    }
    for (const who of new Set(episode.mentions)) {
      if (participants.has(who)) continue;
      hub(personNode(who), "person", personLabel(people, who));
      links.push({ source: id, target: personNode(who), kind: "mention" });
    }
    for (const tag of episode.tags) {
      if ((tagCounts.get(tag) ?? 0) < 2 && !keepTags.has(tag)) continue;
      hub(tagNode(tag), "tag", tag);
      links.push({ source: id, target: tagNode(tag), kind: "tag" });
    }
  }

  // `related` is kept on both ends; one link per pair, and only between conversations shown.
  const paired = new Set<string>();
  for (const episode of episodes) {
    for (const other of episode.related) {
      if (!shown.has(other) || other === episode.id) continue;
      const pair = episode.id < other ? `${episode.id}|${other}` : `${other}|${episode.id}`;
      if (paired.has(pair)) continue;
      paired.add(pair);
      links.push({ source: episodeNode(episode.id), target: episodeNode(other), kind: "related" });
    }
  }

  for (const link of links) {
    const source = nodes.get(link.source);
    if (source?.kind === "episode") source.degree += 1;
    if (link.kind === "related") {
      const target = nodes.get(link.target);
      if (target) target.degree += 1;
    }
  }

  return { nodes: [...nodes.values()], links, episodes: episodes.length, total };
}

/** What the knowledge layer is drawn from (`knowledge/surface.ts` reads it): plain rows, no store. */
export interface KnowledgeGraphInput {
  /** The collections not archived, with whom each is about. */
  collections: readonly { id: string; name: string; about: readonly string[] }[];
  /** Their documents that were read, with when each file last changed, and the tags its frontmatter gives it. */
  documents: readonly { collection: string; path: string; title: string; mtime: number; tags?: readonly string[] }[];
  /** Document → document, by `documentKey`, from the links in their words. */
  links: readonly (readonly [string, string])[];
  /** Each document's mean vector by `documentKey`, while search by meaning is on. */
  vectors?: ReadonlyMap<string, Int8Array>;
}

export interface KnowledgeLayer {
  nodes: GraphNode[];
  links: GraphLink[];
  documents: number;
  total: number;
  byMeaning: boolean;
}

/** One key per pair of documents, whichever way round. */
const pairOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The knowledge layer: each collection and its documents, the links between them, the people each is about, and, with
 * search by meaning on, a dashed line from each document to its nearest. Bounded as the conversations are: the most
 * linked documents first, then the newest, at most `limit` and `DOCUMENTS_MAX`, their labels cut short.
 */
export function buildKnowledgeLayer(input: KnowledgeGraphInput, limit: number, people: readonly Person[]): KnowledgeLayer {
  const collections = new Map(input.collections.map((collection) => [collection.id, collection]));
  const documents = input.documents.filter((document) => collections.has(document.collection)).map((document) => ({ ...document, key: documentKey(document.collection, document.path) }));
  const kept = new Set(documents.map((document) => document.key));

  // One line per pair, between two documents both kept; a document's reach is how many it links with.
  const pairs = new Map<string, readonly [string, string]>();
  for (const [a, b] of input.links) if (a !== b && kept.has(a) && kept.has(b) && !pairs.has(pairOf(a, b))) pairs.set(pairOf(a, b), [a, b]);
  const reach = new Map<string, number>();
  for (const [a, b] of pairs.values()) for (const key of [a, b]) reach.set(key, (reach.get(key) ?? 0) + 1);
  const shown = documents
    .sort((a, b) => (reach.get(b.key) ?? 0) - (reach.get(a.key) ?? 0) || b.mtime - a.mtime || a.key.localeCompare(b.key))
    .slice(0, Math.min(limit, DOCUMENTS_MAX));
  const showing = new Set(shown.map((document) => document.key));

  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];
  const node = (id: string, kind: GraphNodeKind, label: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label, degree: 0 });
  };
  const join = (source: string, target: string, kind: GraphLinkKind) => {
    links.push({ source, target, kind });
    nodes.get(source)!.degree += 1;
    nodes.get(target)!.degree += 1;
  };

  for (const document of shown) {
    const collection = collections.get(document.collection)!;
    node(collectionNode(collection.id), "collection", short(collection.name));
    node(documentNode(document.key), "document", short(document.title || document.path));
    join(collectionNode(collection.id), documentNode(document.key), "collection");
    for (const person of collection.about) {
      node(personNode(person), "person", personLabel(people, person));
      join(personNode(person), documentNode(document.key), "about");
    }
    // A conversation's tag and a document's of the same name are one dot (0.8.23): what joins the two worlds.
    for (const tag of document.tags ?? []) {
      node(tagNode(tag), "tag", tag);
      join(documentNode(document.key), tagNode(tag), "tag");
    }
  }
  const drawn = new Set<string>();
  for (const [pair, [a, b]] of pairs) {
    if (!showing.has(a) || !showing.has(b)) continue;
    drawn.add(pair);
    join(documentNode(a), documentNode(b), "link");
  }
  if (input.vectors) {
    // Among the documents shown, a pair already linked drawn once, as its link.
    const among = new Map([...input.vectors].filter(([key]) => showing.has(key)));
    for (const [key, near] of nearestEach(among)) {
      for (const other of near) {
        const pair = pairOf(key, other.key);
        if (drawn.has(pair)) continue;
        drawn.add(pair);
        join(documentNode(key), documentNode(other.key), "similar");
      }
    }
  }
  return { nodes: [...nodes.values()], links, documents: shown.length, total: documents.length, byMeaning: input.vectors !== undefined };
}

/**
 * The conversations' graph with the knowledge layer over it: a person or a tag both draw is one dot. Neither is changed.
 * `opened` is each shown conversation's documents (0.8.23), joined where the layer shows the document: a conversation
 * that opened one the layer left out has no line to draw.
 */
export function withKnowledge(graph: MemoryGraph, layer: KnowledgeLayer, opened: readonly (readonly [string, string])[] = []): MemoryGraph {
  const nodes = new Map(graph.nodes.map((node) => [node.id, { ...node }]));
  for (const node of layer.nodes) {
    const there = nodes.get(node.id);
    nodes.set(node.id, there ? { ...there, degree: there.degree + node.degree } : { ...node });
  }
  const links = [...graph.links, ...layer.links];
  for (const [episode, document] of opened) {
    const from = nodes.get(episodeNode(episode));
    const to = nodes.get(documentNode(document));
    if (from?.kind !== "episode" || to?.kind !== "document") continue;
    links.push({ source: from.id, target: to.id, kind: "opened" });
    from.degree += 1;
    to.degree += 1;
  }
  return {
    ...graph,
    nodes: [...nodes.values()],
    links,
    knowledge: { documents: layer.documents, total: layer.total, byMeaning: layer.byMeaning },
  };
}

/** The graph for a filter, and the facets, each rebuilt only when the filter is new or the vault changed since. */
export function createGraphView(deps: { index: MemoryIndexPort; people: () => readonly Person[] }) {
  const cache = new Map<string, MemoryGraph>();
  let facets: { revision: string; value: MemoryFacets } | null = null;

  const facetsOf = (): MemoryFacets => {
    const revision = deps.index.revision();
    if (facets?.revision === revision) return facets.value;
    const found = deps.index.facets();
    const people = deps.people();
    const value = { ...found, people: found.people.map((facet) => ({ ...facet, label: personLabel(people, facet.value) })) };
    facets = { revision, value };
    return value;
  };

  const graphOf = (filter: GraphFilter, limit: number): MemoryGraph => {
    const key = `${deps.index.revision()}|${limit}|${JSON.stringify(filter)}`;
    const hit = cache.get(key);
    if (hit) {
      // Most recently used last, so the oldest is the one dropped.
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const episodes = deps.index.allEpisodes(filter, limit);
    const total = episodes.length < limit ? episodes.length : deps.index.countEpisodes(filter);
    const graph = buildGraph(episodes, total, deps.people(), new Set(filter.tags ?? []));
    cache.set(key, graph);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return graph;
  };

  return { graph: graphOf, facets: facetsOf };
}
