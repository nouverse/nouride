/**
 * PDF and Office files in the knowledge base (0.8.20, KNOWLEDGE_BASE §6): read by `doc.py`, a PDF's sections keeping the
 * pages they span, a workbook's sheets each a table, the result cached by the file's hash, and a file that needs a
 * program the box lacks saying which, so the page can offer it, and read once it is there.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { whichBinary } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { KnowledgeStore } from "@/modules/memory/knowledge/knowledge.store.ts";
import { readOffice, sectionsOfPages } from "@/modules/memory/knowledge/office.ts";
import { syncKnowledge } from "@/modules/memory/knowledge/sync.ts";
import { ftsQuery } from "@/modules/memory/terms.ts";
import { tempDir } from "../helpers.ts";

const DOC_PY = join(import.meta.dir, "../../../../content/skills/document-reading/scripts/doc.py");

/**
 * A stand-in `doc.py`: what it is asked is counted in a file, and it answers as the real one does — a PDF's text with
 * its page markers, a workbook's sheets one CSV each, or exit 3 naming the program it needs.
 */
function standIn(dir: string, behaviour: "ok" | "missing" | "no-python" | "scan"): { script: string; calls: () => number } {
  const script = join(dir, "doc.py");
  const counter = join(dir, "calls");
  writeFileSync(
    script,
    `import os, sys
with open(${JSON.stringify(counter)}, "a") as fh: fh.write("x")
if ${behaviour === "missing" ? "True" : "False"}:
    sys.stderr.write("extracting PDF text needs pdftotext (\`nouride pkg install poppler-utils\`)\\n"); sys.exit(3)
if ${behaviour === "no-python" ? "True" : "False"}:
    sys.stderr.write("nice: can't execute 'python3': No such file or directory\\n"); sys.exit(127)
path = sys.argv[2]
if path.endswith(".pdf"):
    out = sys.argv[sys.argv.index("--out") + 1]
    open(out, "w").write(${behaviour === "scan" ? '"=== page 1 ===\\n\\n=== page 2 ===\\n"' : '"=== page 1 ===\\nOpening.\\n\\nHotels up to Rp 1.5 million.\\n=== page 2 ===\\nMeals with receipts.\\n"'})
else:
    tmp = os.environ["TMPDIR"]
    for name, rows in (("Prices", "sku,price\\nA,1\\n"), ("Stock", "sku,qty\\nA,9\\n")):
        p = os.path.join(tmp, name + ".csv"); open(p, "w").write(rows); print(f"- {name} -> {p}")
`,
  );
  chmodSync(script, 0o755);
  return { script, calls: () => (existsSync(counter) ? readFileSync(counter, "utf8").length : 0) };
}

describe("sections of a PDF", () => {
  test("each keeps the pages it spans; none past its size", () => {
    const text = ["=== page 1 ===", "Intro.", "", "Hotels.", "=== page 2 ===", "x".repeat(1_490), "=== page 3 ===", "Meals."].join("\n");
    const sections = sectionsOfPages(text, "Policy", 1_500);
    expect(sections.map((section) => [section.pageFrom, section.pageTo])).toEqual([
      [1, 1],
      [2, 3],
    ]);
    expect(sections.every((section) => section.text.length <= 1_500 && section.trail === "Policy")).toBe(true);
    expect(sections[0]!.text).toBe("Intro.\n\nHotels.");
  });
});

describe("read by doc.py", () => {
  test("a PDF with its pages, a workbook a table a sheet; read once, then from the cache", async () => {
    const dir = tempDir("knowledge-office");
    const reader = standIn(dir, "ok");
    const office = { script: reader.script, cacheDir: join(dir, "cache") };
    writeFileSync(join(dir, "policy.pdf"), "%PDF-1.4 stand-in");
    writeFileSync(join(dir, "book.xlsx"), "PK stand-in");

    const pdf = await readOffice(join(dir, "policy.pdf"), "pages", "policy", office);
    expect(pdf.kind === "read" ? pdf.sections.map((section) => [section.text, section.pageFrom, section.pageTo]) : pdf).toEqual([["Opening.\n\nHotels up to Rp 1.5 million.\n\nMeals with receipts.", 1, 2]]);
    const book = await readOffice(join(dir, "book.xlsx"), "book", "book", office);
    expect(book.kind === "read" ? book.sections.map((section) => [section.n, section.trail]) : book).toEqual([
      [0, "book › Prices"],
      [1, "book › Stock"],
    ]);
    expect(reader.calls()).toBe(2);
    await readOffice(join(dir, "policy.pdf"), "pages", "policy", office);
    expect(reader.calls()).toBe(2);
  });

  // The container image has no Python, and there every PDF and Office file said only that it could not be read, with
  // nothing to install and never tried again: python3 is started through \`nice\`, which answers 127 when it is missing,
  // and the error the reader looked for was never thrown (0.8.20's check on the image, 2026-11-06). Stood in here by a
  // reader that answers as \`nice\` did.
  test("Python missing, as the wrapper it runs through says so: needs python3, and read at the next sync once it is there", async () => {
    const dir = tempDir("knowledge-office");
    const root = join(dir, "knowledge");
    mkdirSync(join(root, "finance"), { recursive: true });
    writeFileSync(join(root, "finance", "policy.pdf"), "%PDF-1.4 stand-in");
    const db = await openAndMigrate(join(dir, "data", "test.db"));
    const store = new KnowledgeStore(db);
    mkdirSync(join(dir, "a"), { recursive: true });
    const none = standIn(join(dir, "a"), "no-python");
    await syncKnowledge({ root, store, now: () => 1, office: { script: none.script, cacheDir: join(dir, "cache") } });
    expect(store.document("finance", "policy.pdf")).toMatchObject({ status: "unreadable", needs: "python3", reason: "Reading this kind of file needs Python, which this box does not have yet." });
    mkdirSync(join(dir, "b"), { recursive: true });
    const now = standIn(join(dir, "b"), "ok");
    expect((await syncKnowledge({ root, store, now: () => 2, office: { script: now.script, cacheDir: join(dir, "cache") } })).indexed).toBe(1);
    expect(store.document("finance", "policy.pdf")).toMatchObject({ status: "indexed", sections: 1 });
  });

  // A scanned PDF reads without an error and without a word: the real doc.py notes "almost no text came out" and exits 0.
  // It was indexed with nothing in it, and the agent that kept it was told it could be searched now (2026-11-07, while
  // Nestor planned the owner's legal documents into the knowledge base).
  test("a scan, with no text in it: kept, not searched, says why, and not read again while it is the same", async () => {
    const dir = tempDir("knowledge-office");
    const root = join(dir, "knowledge");
    mkdirSync(join(root, "legal"), { recursive: true });
    writeFileSync(join(root, "legal", "deed.pdf"), "%PDF-1.4 stand-in");
    const db = await openAndMigrate(join(dir, "data", "test.db"));
    const store = new KnowledgeStore(db);
    const scan = standIn(dir, "scan");
    const office = { script: scan.script, cacheDir: join(dir, "cache") };
    expect(await syncKnowledge({ root, store, now: () => 1, office })).toMatchObject({ indexed: 0, notSearched: 1 });
    expect(store.document("legal", "deed.pdf")).toMatchObject({
      status: "unreadable",
      sections: 0,
      reason: "It has no text to search, as a scanned page has none, so it is kept here but not searched.",
    });
    expect(store.document("legal", "deed.pdf")!.needs).toBeUndefined();
    const calls = scan.calls();
    expect(calls).toBe(1);
    expect((await syncKnowledge({ root, store, now: () => 2, office })).unchanged).toBe(1);
    expect(scan.calls()).toBe(calls);
  });

  test("a program missing: not searched, says which, and read at the next sync once it is there", async () => {
    const dir = tempDir("knowledge-office");
    const root = join(dir, "knowledge");
    mkdirSync(join(root, "finance"), { recursive: true });
    writeFileSync(join(root, "finance", "policy.pdf"), "%PDF-1.4 stand-in");
    const db = await openAndMigrate(join(dir, "data", "test.db"));
    const store = new KnowledgeStore(db);
    mkdirSync(join(dir, "a"), { recursive: true });
    const missing = standIn(join(dir, "a"), "missing");
    await syncKnowledge({ root, store, now: () => 1, office: { script: missing.script, cacheDir: join(dir, "cache") } });
    expect(store.document("finance", "policy.pdf")).toMatchObject({
      status: "unreadable",
      needs: "poppler-utils",
      reason: "Reading this kind of file needs a program this box does not have yet, so it is kept here but not searched for now.",
    });
    expect(missing.calls()).toBeGreaterThan(0);
    // The program installed: the same file, unchanged, is read at the next sync.
    mkdirSync(join(dir, "b"), { recursive: true });
    const now = standIn(join(dir, "b"), "ok");
    const report = await syncKnowledge({ root, store, now: () => 2, office: { script: now.script, cacheDir: join(dir, "cache") } });
    expect(report.indexed).toBe(1);
    expect(store.document("finance", "policy.pdf")).toMatchObject({ status: "indexed", sections: 1 });
    expect(store.document("finance", "policy.pdf")!.needs).toBeUndefined();
    expect(store.rank(ftsQuery("receipts")!, ["finance"], 5)).toEqual(["knowledge:finance/policy.pdf#0"]);
  });

  test.skipIf(!whichBinary("python3"))("a real Word file through the real doc.py: its headings cut the sections", async () => {
    const dir = tempDir("knowledge-office");
    const docx = join(dir, "handbook.docx");
    // A minimal Word file, built with the standard library: two headings and a paragraph under each.
    execFileSync("python3", [
      "-c",
      `import zipfile, sys
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
z.writestr("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
p = lambda style, text: f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>' if style else f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'
body = p("Heading1", "Leave") + p("", "Twelve days a year.") + p("Heading1", "Travel") + p("", "Hotels up to Rp 1.5 million.")
z.writestr("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>')
z.close()`,
      docx,
    ]);
    const read = await readOffice(docx, "text", "handbook", { script: DOC_PY, cacheDir: join(dir, "cache") });
    expect(read.kind).toBe("read");
    const sections = read.kind === "read" ? read.sections : [];
    expect(sections.map((section) => [section.trail, section.text])).toEqual([
      ["handbook › Leave", "Twelve days a year."],
      ["handbook › Travel", "Hotels up to Rp 1.5 million."],
    ]);
  });
});
