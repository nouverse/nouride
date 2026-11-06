/**
 * Indonesian roots in keyword search.
 *
 * Prefix matching reached `liburan` from `libur` but never `berlibur`. Roots are indexed and queried
 * beside each word, so a household that searches in Indonesian without semantic search still finds it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { indonesianRoots } from "@/modules/memory/stemmer/id.ts";
import { ftsDoc } from "@/modules/memory/terms.ts";
import { createMemorySearchTool } from "@/modules/tools/builtins/memory-search.ts";
import { GADING_DM, at, household, scripted, type Household } from "./fixture.ts";

describe("indonesianRoots", () => {
  test("prefixes and suffixes come off, down to a root of four letters or more", () => {
    expect(indonesianRoots("berlibur")).toContain("libur");
    expect(indonesianRoots("liburan")).toContain("libur");
    expect(indonesianRoots("liburannya")).toContain("libur");
    expect(indonesianRoots("dikerjakan")).toContain("kerja");
    expect(indonesianRoots("pekerjaan")).toContain("kerja");
  });

  test("a nasal prefix gives back the letter it swallowed", () => {
    expect(indonesianRoots("menulis")).toContain("tulis");
    expect(indonesianRoots("memakai")).toContain("pakai");
    expect(indonesianRoots("menyapu")).toContain("sapu");
    expect(indonesianRoots("mengirim")).toContain("kirim");
  });

  test("never the word itself, never a stub under four letters", () => {
    expect(indonesianRoots("libur")).not.toContain("libur");
    expect(indonesianRoots("makan").every((root) => root.length >= 4)).toBe(true);
    expect(indonesianRoots("laptop")).toEqual([]);
  });

  test("the word as written stays in the index beside its roots", () => {
    expect(ftsDoc({ body: "berlibur berlibur" })).toMatchObject({ body: "berlibur berlibur", roots: "libur libur" });
  });
});

let h: Household;

beforeEach(async () => {
  h = await household();
  h.dm(GADING_DM, "nouva", "Minggu depan aku berlibur ke Lombok", "Asik, hati-hati di jalan.", at(9));
  await h.memory.pass(scripted([{ when: "Lombok", answer: { summary: "Gading is going to Lombok next week.", importance: 3 } }]).ask);
});

afterEach(() => h.close());

describe("memory_search in Indonesian, without semantic search", () => {
  test("a query word finds a conversation that used another form of it", async () => {
    const search = createMemorySearchTool(h.memory);
    const ctx = { agentId: "nouva", agentDir: join(h.dir, "agents", "nouva"), sessionId: "s", signal: new AbortController().signal, ...GADING_DM } as never;
    expect((await search.execute({ query: "liburan" }, ctx)).content).toContain("Gading is going to Lombok");
  });
});
