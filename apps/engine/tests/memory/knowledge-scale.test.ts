/**
 * A knowledge base past `SECTIONS_SCORED_WHOLE` sections (0.8.20, KNOWLEDGE_BASE §8): documents ranked by their sections'
 * mean first, then the sections of the nearest scored, so a search over 50,000 sections costs what one over 10,000 does
 * (the bench, `search-bench.test.ts`). The section nearest the question is still found.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openAndMigrate } from "@/db/index.ts";
import { KnowledgeStore } from "@/modules/memory/knowledge/knowledge.store.ts";
import { MemoryIndexStore } from "@/modules/memory/memory-index.store.ts";
import { MemoryVectorStore } from "@/modules/memory/memory-vectors.store.ts";
import { searchMemory } from "@/modules/memory/search.ts";
import { tempDir } from "../helpers.ts";

const MODEL = "fake/vec@4";

describe("past ten thousand sections", () => {
  test("the section nearest by meaning is found, in the document nearest by its mean", async () => {
    const dir = tempDir("knowledge-scale");
    const db = await openAndMigrate(join(dir, "test.db"));
    const store = new KnowledgeStore(db);
    const vectors = new MemoryVectorStore(db);
    // 101 documents of 100 sections: one about gardens, pointing one way; the rest pointing another.
    for (let doc = 0; doc <= 100; doc += 1) {
      const sections = Array.from({ length: 100 }, (_, n) => ({ n, trail: `Doc ${doc}`, text: `part ${n} of document ${doc}` }));
      store.replace({ collection: "big", path: `doc-${doc}.md`, size: 1, mtime: 1, title: `Doc ${doc}`, status: "indexed", sections: 100, indexedAt: 1 }, sections);
      vectors.put(
        sections.map((section) => ({
          item: `knowledge:big/doc-${doc}.md#${section.n}`,
          // The garden document's section 42 is the one nearest of all; its other sections lean the same way.
          vector: Int8Array.from(doc === 7 ? (section.n === 42 ? [127, 0, 0, 0] : [90, 90, 0, 0]) : [0, 127, 0, 0]),
          hash: "h",
        })),
        MODEL,
        1,
      );
    }
    const embedder = { model: MODEL, embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };
    const hits = await searchMemory(
      { index: new MemoryIndexStore(db), people: [], semantic: { vectors, embedder }, knowledge: store, now: () => 0, timeZone: "UTC" },
      { audience: { kind: "dm", chat: "telegram:nouva:1", person: "gading" }, query: "garden", knowledge: [{ id: "big", name: "Big", about: [] }] },
    );
    expect(hits[0]?.kind === "section" ? hits[0].section.item : null).toBe("knowledge:big/doc-7.md#42");
    expect(hits.every((hit) => hit.kind === "section" && hit.section.path === "doc-7.md")).toBe(true);
    db.close();
  });
});
