# Memory at scale

What a household's vault costs once it is not a household's any more: one `memory_search` with meaning, and a migration
over the memory tables, at 1k, 10k and 50k items. Run it when search, the vector store or a memory migration changes,
before and after the change, on the same machine, and put both tables in the change.

```bash
NOURIDE_BENCH_SEARCH=1 bun test apps/engine/tests/memory/search-bench.test.ts
```

`apps/engine/tests/memory/search-bench.test.ts` is skipped unless asked. It builds a synthetic vault straight into the
index in a temp directory (search reads the index, never the files): one episode an hour, every one in a chat the
person asking took part in, so the whole vault is visible to them; 512-dimension vectors; about 1% of summaries holding
the word searched for, so the keyword half has hits to fuse. Per size, one search cold — the first, which reads the
vectors into memory — then twenty warm:

- **time**, cold and the warm median and p95;
- **rows read whole** — what `episodes()` returned, counted through a proxy on the index: what hydration cost.

The second table takes a database as the previous release left it, at 50k items with every vector in the old form,
through `openAndMigrate` — the snapshot before migrating included, which is most of the time — and checks every vector
came out converted.

**What the held vectors cost resident** wants a collection forced before and after the read, which `bun test` cannot do
(`--expose-gc` does not reach a test file, and `Bun.gc` is the runtime package's alone), so it is measured outside it: a
script in a scratch directory that imports the store by absolute path, fills a vault the same way, and reads
`process.memoryUsage().heapUsed` around `vectors.of(model)` with `Bun.gc(true)` on both sides.

**The before numbers** come from the same bench over the old code: `git checkout <base> -- <the changed source files>`,
run, `git checkout HEAD -- …` — the bench must compile against both, so keep its calls to what both have.

## Reading the numbers

Timings on a laptop are noisy when anything else is running (another worktree's suite is enough to double one): run it
two or three times and quote the medians, with the machine named. The rows-read-whole column does not move between
runs, and it is the one a change to search should be held to — `search-by-id.test.ts` holds it in the suite.

## 0.7.12 (M5): one Apple-silicon laptop, Bun 1.4.2, SQLite 3.51.0, medians of three runs

| Items | Before: cold / warm / p95 ms | Rows read whole | After: cold / warm / p95 ms | Rows read whole |
|---|---|---|---|---|
| 1,000 | 26.1 / 16.8 / 19.7 | 1,015 | 14.4 / 4.7 / 9.3 | 45 |
| 10,000 | 92.8 / 86.7 / 93.0 | 5,094 | 36.8 / 17.9 / 22.1 | 122 |
| 50,000 | 106.1 / 97.2 / 103.7 | 5,203 | 115.6 / 26.6 / 37.4 | 232 |

Before, a search read every visible episode whole, up to the 5,000 newest — five statements over 5,000 ids — and
decoded each one's vector from base64. After, it reads ids, scores them against vectors in memory, and reads whole
the top three times its limit and the keyword hits. The cold search at 50k is the one read of 50,000 vectors into
memory, once per model per process. What a warm search at 50k still spends, measured apart: the id query 5.3 ms,
ranking 5,000 candidates by meaning 8 ms, FTS5 2.4 ms, reading 230 episodes whole 2.6 ms. The machine was busy with
other work during the after runs — the warm times spread 4.0–7.4 ms at 1k — which is why the rows column is the one
to hold a change to.

Held in memory at 50,000 × 512 (24.4 MB of vectors): 30.4 MB of heap after a collection, in one buffer per model; a
buffer per vector had held 44.2 MB. `056` on a 0.7.11 database of 50,000 vectors (77 MB): 1.7 s for the whole of
`openAndMigrate`, the snapshot before it included — the median of three, the slowest 4.6 s.

## 0.8.20: with the knowledge base, one Apple-silicon laptop, Bun 1.4.4, one run each

The second test of the bench puts a knowledge collection beside 50,000 episodes: documents of a hundred sections, every
section with a vector and searchable by this audience, so each search scores them all by meaning (no age cap for
documents). Warm median and p95, ms:

| Sections | Before | After |
|---|---|---|
| 0 | 12.2 / 18.4 | 10.5 / 12.0 |
| 1,000 | 13.2 / 14.9 | 12.0 / 12.8 |
| 10,000 | 22.2 / 23.6 | 16.4 / 23.3 |
| 50,000 | 66.2 / 86.3 | 19.1 / 22.4 |

Before, every section was scored and every score sorted, each vector's length worked out again at each comparison, and
the collection's section ids read from SQLite at every search. After: lengths held per vector, only the best few dozen
kept while scoring, each collection's ids held until it changes, and past 10,000 sections the documents ranked by their
sections' mean first and only the sections of the 50 nearest scored (`search.ts`, `SECTIONS_SCORED_WHOLE`). The cold
search, the first read of every vector into memory, was 63 to 188 ms. The bar is 0.7.12's, above: 26.6 / 37.4 at 50k.
