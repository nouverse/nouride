/**
 * Documents close in meaning (0.8.20, KNOWLEDGE_BASE §11 and §12): a document's **Related documents** on the dashboard,
 * and the dashed lines between documents in the memory graph.
 *
 * Read from the vectors memory already holds for search (`rankingVectors`): a document is the mean of its sections'
 * vectors, and two documents are as close as the cosine of their means. No model is asked, so it costs nothing beyond
 * the vectors search holds anyway, and there is nothing while search by meaning is off or before a document's sections
 * have their vectors.
 *
 * Pure.
 */

import { centroid, similarity } from "../semantic.ts";
import { parseItem } from "./knowledge.store.ts";

/** How many of a document's nearest are shown: the dashboard's list, and the graph's lines from each document. */
const NEAREST = 3;

/**
 * The cosine below which two documents are not called close. A design value, not measured on documents: with bge-m3,
 * memory's facts measured a related but different fact at 0.79 and a restatement at 0.86 or more (`same-fact.ts`), and
 * documents on different subjects are expected well under 0.6. The bench on the box sets it (KNOWLEDGE_BASE §14 item 8).
 */
const SIMILAR_FLOOR = 0.6;

export interface Near {
  /** The other document, by `documentKey`. */
  key: string;
  score: number;
}

/** A document as these maps know it: its collection, and its path in the collection. A collection id has no `/`. */
export const documentKey = (collection: string, path: string): string => `${collection}/${path}`;

/** A `documentKey` read back. */
export function documentOf(key: string): { collection: string; path: string } {
  const at = key.indexOf("/");
  return { collection: key.slice(0, at), path: key.slice(at + 1) };
}

/** Each document's mean vector, from its sections' vectors (`items` are section ids); a document with none is left out. */
export function documentVectors(items: readonly string[], vectors: ReadonlyMap<string, Int8Array>): Map<string, Int8Array> {
  const sections = new Map<string, Int8Array[]>();
  for (const item of items) {
    const parsed = parseItem(item);
    const vector = vectors.get(item);
    if (!parsed || parsed.n === "all" || !vector) continue;
    const key = documentKey(parsed.collection, parsed.path);
    const list = sections.get(key);
    if (list) list.push(vector);
    else sections.set(key, [vector]);
  }
  const out = new Map<string, Int8Array>();
  for (const [key, list] of sections) {
    const mean = centroid(list);
    if (mean) out.set(key, mean);
  }
  return out;
}

const closestFirst = (a: Near, b: Near) => b.score - a.score || a.key.localeCompare(b.key);

/** The documents nearest one, most similar first: at most `limit`, none under `floor`, never itself. */
export function nearest(key: string, documents: ReadonlyMap<string, Int8Array>, limit = NEAREST, floor = SIMILAR_FLOOR): Near[] {
  const target = documents.get(key);
  if (!target) return [];
  const found: Near[] = [];
  for (const [other, vector] of documents) {
    if (other === key) continue;
    const score = similarity(target, vector);
    if (score >= floor) found.push({ key: other, score });
  }
  return found.sort(closestFirst).slice(0, limit);
}

/**
 * Every document's nearest among `documents`, as `nearest` gives each: the same cosine, each pair worked out once with
 * each vector's length worked out once, so a graph of a few hundred documents is tens of millions of sums, not hundreds.
 */
export function nearestEach(documents: ReadonlyMap<string, Int8Array>, limit = NEAREST, floor = SIMILAR_FLOOR): Map<string, Near[]> {
  const entries = [...documents];
  const lengths = entries.map(([, vector]) => Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)));
  const found = new Map<string, Near[]>(entries.map(([key]) => [key, []]));
  for (let i = 0; i < entries.length; i += 1) {
    const [a, va] = entries[i]!;
    for (let j = i + 1; j < entries.length; j += 1) {
      const [b, vb] = entries[j]!;
      if (va.length !== vb.length || !lengths[i] || !lengths[j]) continue;
      let dot = 0;
      for (let d = 0; d < va.length; d += 1) dot += va[d]! * vb[d]!;
      const score = dot / (lengths[i]! * lengths[j]!);
      if (score < floor) continue;
      found.get(a)!.push({ key: b, score });
      found.get(b)!.push({ key: a, score });
    }
  }
  for (const [key, list] of found) found.set(key, list.sort(closestFirst).slice(0, limit));
  return found;
}
