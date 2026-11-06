/**
 * The helper scripts that ship beside the document skills (0.7.24), run as an agent runs them: `python3 <script>`.
 *
 * They exist because of a live turn: asked to add a sheet to a workbook on a laptop with no Python, an agent wrote ad-hoc
 * openpyxl scripts from scratch over and over just to list sheets, find where the data ended and read headers - and read
 * `max_row` as 1000 where 142 rows were real. So what is asserted is the decisions the scripts make for it: the type
 * from the bytes rather than the name, the real used range rather than Excel's padded one, a refusal (exit 2, one line,
 * never a traceback) for a file that cannot be read, a query that prints a capped answer from a cache, and an editor that
 * refuses a workbook openpyxl would quietly damage and never writes the original.
 *
 * The fixtures are written by `fixtures.py` with the standard library, so everything here runs on any python3. The few
 * cases that need openpyxl itself are skipped, by name, where it is not installed; all of it is skipped where python3
 * is not on PATH.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichBinary } from "@nouride/runtime";

const ROOT = join(import.meta.dir, "../../../../..");
const DOC = join(ROOT, "content/skills/document-reading/scripts/doc.py");
const EDIT = join(ROOT, "content/skills/document-authoring/scripts/xlsx_edit.py");
const FIXTURES = join(import.meta.dir, "fixtures.py");

function probe(code: string): boolean {
  if (!whichBinary("python3")) return false;
  return spawnSync("python3", ["-c", code]).status === 0;
}

/** 3.8 is the oldest the scripts are written for (walrus-free, `from __future__ import annotations`). */
const PYTHON = probe("import sys; sys.exit(sys.version_info < (3, 8))");
const OPENPYXL = PYTHON && probe("import openpyxl");

const DIR = mkdtempSync(join(tmpdir(), "nouride-doc-scripts-"));
const FX = join(DIR, "fx");
const TMP = join(DIR, "tmp");

function run(script: string, ...args: string[]): { code: number; out: string; err: string } {
  const proc = spawnSync("python3", [script, ...args], { env: { ...process.env, TMPDIR: TMP }, cwd: DIR, encoding: "utf8" });
  return { code: proc.status ?? -1, out: proc.stdout, err: proc.stderr };
}

const doc = (...args: string[]) => run(DOC, ...args);
const edit = (...args: string[]) => run(EDIT, ...args);
const fx = (name: string) => join(FX, name);

/** `inspect --json`: a few fixed keys, the rest named in the script's own words. */
interface Report {
  type: string;
  warnings: string[];
  sheets: Record<string, string | number>[];
  [key: string]: unknown;
}

function inspect(name: string): Report {
  const result = doc("inspect", fx(name), "--json");
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Report;
}

beforeAll(() => {
  if (!PYTHON) return;
  const made = spawnSync("python3", [FIXTURES, FX], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`fixtures.py failed: ${made.stderr}`);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

test.skipIf(PYTHON)("python3 (3.8+) is not on PATH, so the document scripts cannot be run here", () => {
  expect(PYTHON).toBe(false);
});

describe.skipIf(!PYTHON)("doc.py inspect: the type comes from the bytes", () => {
  test("a .xls that is an HTML page is named as one, and its table is read", () => {
    const report = inspect("fake.xls");
    expect(report.type).toBe("html");
    expect(report.warnings.join("\n")).toContain("named .xls but the content is an HTML page");
    expect(report.sheets[0]?.headers).toBe("A=Tanggal | B=Keterangan | C=Debit");
  });

  test("Excel 2003 XML saved as .xls is named as that", () => {
    expect(inspect("sml.xls").type).toBe("spreadsheetml");
  });

  test("a CSV with a BOM and semicolons: encoding, delimiter and header found", () => {
    const report = inspect("bom-semicolon.csv");
    expect(report.type).toBe("csv");
    expect(report.encoding).toContain("utf-8-sig");
    expect(report.delimiter).toBe("semicolon");
    expect(report.sheets[0]?.["header row (guess)"]).toBe(1);
  });

  test("a CSV that is UTF-8 with one cp1252 line says it is mixed, and extract keeps both", () => {
    const report = inspect("mixed.csv");
    expect(report.warnings.join("\n")).toContain("mixed encodings");
    const out = join(TMP, "mixed.csv");
    expect(doc("extract", fx("mixed.csv"), "--out", out).code).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("Médan");
    expect(text).toContain("Bogotá");
  });

  for (const [name, says] of [
    ["empty.xlsx", "empty (0 bytes)"],
    ["truncated.xlsx", "damaged or truncated"],
    ["garbage.docx", "damaged or truncated"],
    ["locked.xlsx", "password-protected Office file"],
    ["secret.zip", "password-encrypted entries"],
  ] as const) {
    test(`${name} is refused with exit 2 and one line saying why`, () => {
      const result = doc("inspect", fx(name));
      expect(result.code).toBe(2);
      expect(result.err).toContain(says);
      expect(result.err).not.toContain("Traceback");
      expect(result.out).toBe("");
    });
  }
});

describe.skipIf(!PYTHON)("doc.py on a workbook", () => {
  test("the used range is the data's, not Excel's padded one, and the traps are listed", () => {
    const report = inspect("book.xlsx");
    const [sheet, hidden] = report.sheets;
    expect(sheet?.name).toBe("KK 1.2");
    expect(sheet?.["used range"]).toBe("A1:E7");
    expect(sheet?.["declared range"]).toContain("A1:Z40");
    // The title in row 1 is skipped; the frozen pane under row 3 agrees.
    expect(sheet?.["header row (guess)"]).toBe(3);
    expect(sheet?.merged).toContain("A1:D1");
    expect(sheet?.["formulas without a cached value"]).toBe(1);
    expect(hidden?.state).toBe("hidden");
    expect(report.warnings.join("\n")).toContain("1 formula cell(s) have no saved value");
  });

  test("extract writes the sheet to a file - dates as dates, formulas on request, rows by span", () => {
    const out = join(TMP, "book.csv");
    const result = doc("extract", fx("book.xlsx"), "--sheet", "kk 1.2", "--out", out);
    expect(result.code).toBe(0);
    expect(result.out).toContain(out);
    expect(readFileSync(out, "utf8")).toContain("1,Apel,2026-10-20,1500,");

    const formulas = join(TMP, "formulas.csv");
    doc("extract", fx("book.xlsx"), "--sheet", "1", "--formulas", "--out", formulas);
    expect(readFileSync(formulas, "utf8")).toContain("=SUM(D4:D5)");

    const span = join(TMP, "span.csv");
    doc("extract", fx("book.xlsx"), "--sheet", "KK 1.2", "--rows", "4-5", "--out", span);
    expect(readFileSync(span, "utf8").trim().split("\n")).toEqual(["1,Apel,2026-10-20,1500,", "2,Jeruk,2026-10-21,2500.5,"]);
  });

  test("extract never writes over its input", () => {
    const result = doc("extract", fx("bom-semicolon.csv"), "--out", fx("bom-semicolon.csv"));
    expect(result.code).toBe(2);
    expect(result.err).toContain("never writes over its input");
  });

  test.skipIf(!OPENPYXL)("a workbook openpyxl wrote, padded with formatted rows to 1000: the used range ends at the data", () => {
    const path = join(DIR, "padded.xlsx");
    const made = spawnSync("python3", ["-c", [
      "import sys, openpyxl",
      "from openpyxl.styles import PatternFill",
      "wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Data'",
      "ws.append(['Kode', 'Nilai'])",
      "[ws.append([f'K{i}', i]) for i in range(1, 143)]",
      "[setattr(ws.cell(row=r, column=1), 'fill', PatternFill('solid', fgColor='FFFF00')) for r in range(144, 1001)]",
      "wb.save(sys.argv[1])",
    ].join("\n"), path]);
    expect(made.status).toBe(0);
    const report = JSON.parse(doc("inspect", path, "--json").out);
    expect(report.sheets[0]["used range"]).toBe("A1:B143");
    expect(report.sheets[0]["rows with data"]).toBe(143);
    expect(doc("query", path, "SELECT COUNT(*) AS n, SUM(nilai) AS s FROM t").out).toContain("| 142 | 10153 |");
  });
});

describe.skipIf(!PYTHON)("doc.py on Word and PowerPoint", () => {
  test("headings come through localised style ids, and tracked changes are flagged", () => {
    const report = inspect("report.docx");
    expect(report.outline).toEqual(["H1 Pendahuluan", "  H2 Metode"]);
    expect(report.warnings.join("\n")).toContain("tracked changes not yet accepted: 1 insertion(s), 1 deletion(s)");
    expect(report.comments).toBe("1 by Budi");
  });

  test("extract shows the text as if accepted; --changes marks both sides", () => {
    const accepted = join(TMP, "accepted.md");
    doc("extract", fx("report.docx"), "--out", accepted);
    const text = readFileSync(accepted, "utf8");
    expect(text).toContain("Kalimat baru");
    expect(text).not.toContain("lama");
    expect(text).toContain("| Kolom A | Kolom B |");

    const marked = join(TMP, "marked.md");
    doc("extract", fx("report.docx"), "--changes", "--out", marked);
    expect(readFileSync(marked, "utf8")).toContain("Kalimat {+baru+}[-lama-]");
  });

  test("slides: titles, the hidden one, and speaker notes", () => {
    const report = inspect("deck.pptx");
    expect(report.slides).toBe(2);
    const slides = report["slide list"] as string[];
    expect(slides[0]).toContain("Rencana 2027");
    expect(slides[0]).toContain("notes: Sebut anggaran dulu");
    expect(slides[1]).toContain("HIDDEN");
  });
});

describe.skipIf(!PYTHON)("doc.py query", () => {
  test("a header's own words in double quotes are its column, and a quoted name that is neither is refused", () => {
    // Live (2026-10-20): GROUP BY "Unit Penagih" — the column is unit_penagih — was read by SQLite as the text
    // 'Unit Penagih', and every row came back as one group with no error.
    const path = join(DIR, "quoted-header.csv");
    writeFileSync(path, "Unit Penagih;Nilai\nHTU;100\nUTI;250\nHTU;50\n");
    const grouped = doc("query", path, 'SELECT "Unit Penagih", SUM(nilai) AS s FROM t GROUP BY 1 ORDER BY s DESC');
    expect(grouped.code).toBe(0);
    expect(grouped.out).toContain("| UTI | 250 |");
    expect(grouped.out).toContain("| HTU | 150 |");

    const wrong = doc("query", path, 'SELECT "Penagih", COUNT(*) FROM t GROUP BY 1');
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('"Penagih" is not a column or a table here');
    expect(wrong.out).toContain("unit_penagih <- 'Unit Penagih'");
    // An alias and quoted text are left as they are.
    expect(doc("query", path, `SELECT COUNT(*) AS "jumlah" FROM t WHERE unit_penagih = 'HTU'`).out).toContain("| 2 |");
  });

  test("a cache directory it cannot write is said to be that, not a damaged document", () => {
    const path = join(DIR, "quoted-header.csv");
    // A file where the directory should be: unwritable for root as well, which a chmod would not be.
    const notADir = join(DIR, "tmp-is-a-file");
    writeFileSync(notADir, "");
    const proc = spawnSync("python3", [DOC, "query", path, "SELECT 1"], { env: { ...process.env, TMPDIR: notADir }, cwd: DIR, encoding: "utf8" });
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain("not the document; check $TMPDIR");
    expect(proc.stderr).not.toContain("damaged");
  });

  test("a semicolon CSV with decimal commas sums as numbers", () => {
    const result = doc("query", fx("bom-semicolon.csv"), "SELECT SUM(harga) AS total FROM t");
    expect(result.code).toBe(0);
    expect(result.out).toContain("| 3234.5 |");
    expect(result.out).toContain("decimal-comma");
  });

  test("an xlsx is queried below its header row, with the sheet row kept", () => {
    const result = doc("query", fx("book.xlsx"), "SELECT _row, jumlah FROM t WHERE nama = 'Apel'");
    expect(result.code).toBe(0);
    expect(result.out).toContain("| 4 | 1500 |");
  });

  test("a bank export's 150.000 is a hundred and fifty thousand", () => {
    expect(doc("query", fx("fake.xls"), "SELECT debit FROM t").out).toContain("| 150000 |");
  });

  test("the answer is capped with the total, and --out writes all of it", () => {
    const path = join(DIR, "many.csv");
    writeFileSync(path, `id,nilai\n${Array.from({ length: 120 }, (_, i) => `${i + 1},${i}`).join("\n")}\n`);
    const capped = doc("query", path, "SELECT * FROM t");
    expect(capped.out).toContain("120 row(s), showing the first 50");
    expect(capped.out.split("\n").filter((line) => line.startsWith("| ")).length).toBe(51);

    const out = join(TMP, "all.csv");
    expect(doc("query", path, "SELECT * FROM t", "--out", out).out).toContain("wrote 120 result rows");
    expect(readFileSync(out, "utf8").trim().split("\n").length).toBe(121);
  });

  test("a second question uses the cache, and a changed file is read again", () => {
    const path = join(DIR, "cache.csv");
    writeFileSync(path, "a,b\n1,2\n");
    expect(doc("query", path, "SELECT SUM(b) FROM t").out).toContain("(loaded)");
    expect(doc("query", path, "SELECT SUM(b) FROM t").out).toContain("(cached)");
    writeFileSync(path, "a,b\n1,2\n3,40\n");
    const again = doc("query", path, "SELECT SUM(b) AS s FROM t");
    expect(again.out).toContain("(loaded)");
    expect(again.out).toContain("| 42 |");
  });

  test("table t is the sheet asked for this time, not the one cached last time", () => {
    // Found while writing this: the cache was keyed by file alone, so `--sheet` after a first query answered from
    // the first sheet.
    expect(doc("query", fx("book.xlsx"), "SELECT COUNT(*) AS n FROM t").out).toContain("| 3 |");
    const other = doc("query", fx("book.xlsx"), "SELECT a FROM t", "--sheet", "Rahasia", "--header", "0");
    expect(other.out).toContain("sheet 'Rahasia'");
    expect(other.out).toContain("| a |\n|---|\n| a |");
  });

  test("it only reads: a write is an SQL error, and the columns are listed", () => {
    const result = doc("query", fx("book.xlsx"), "DELETE FROM t");
    expect(result.code).toBe(1);
    expect(result.out).toContain("SQL error");
  });
});

describe.skipIf(!PYTHON)("xlsx_edit.py", () => {
  test("check lists what openpyxl would lose, and exits 4", () => {
    const result = edit("check", fx("risky.xlsx"));
    expect(result.code).toBe(4);
    for (const lost of ["charts: 1 - WOULD BE LOST", "data validation in extLst: 1 - WOULD BE LOST", "shapes / text boxes: 1 - WOULD BE LOST"]) {
      expect(result.out).toContain(lost);
    }
  });

  test("check passes a workbook with nothing on the drop list", () => {
    const result = edit("check", fx("book.xlsx"));
    expect(result.code).toBe(0);
    expect(result.out).toContain("safe for apply");
  });

  test("apply refuses that workbook before anything is loaded or written - openpyxl or not", () => {
    const plan = join(DIR, "plan-risky.json");
    writeFileSync(plan, JSON.stringify({ ops: [{ set: { "KK 1.2!B4": "x" } }] }));
    const out = join(DIR, "risky.out.xlsx");
    const result = edit("apply", fx("risky.xlsx"), plan, "--out", out);
    expect(result.code).toBe(4);
    expect(result.err).toContain("apply refuses this workbook");
    expect(existsSync(out)).toBe(false);
  });

  test("apply never writes the original", () => {
    const plan = join(DIR, "plan-self.json");
    writeFileSync(plan, JSON.stringify({ ops: [{ set: { "KK 1.2!B4": "x" } }] }));
    const result = edit("apply", fx("book.xlsx"), plan, "--out", fx("book.xlsx"));
    expect(result.code).toBe(2);
    expect(result.err).toContain("never writes over it");
  });

  test.skipIf(!OPENPYXL)("apply: a copied sheet in place, cells set and read back, the original untouched", () => {
    const before = createHash("sha256").update(readFileSync(fx("book.xlsx"))).digest("hex");
    const plan = join(DIR, "plan.json");
    writeFileSync(plan, JSON.stringify({ ops: [
      { add_sheet: "KK 1.2b", after: "KK 1.2", copy_of: "KK 1.2" },
      { set: { "'KK 1.2b'!D4": 999, "Rahasia!B2": "=SUM('KK 1.2b'!D4:D5)" } },
      { append: "KK 1.2", values: [["3", "Nanas", { date: "2026-10-22" }, 10]] },
    ] }));
    const out = join(DIR, "book.edited.xlsx");
    const result = edit("apply", fx("book.xlsx"), plan, "--out", out);
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("verified: reopens, every cell reads back as written");
    // The copy's size and hash, so the far side of a copy back is compared in one step.
    const copy = readFileSync(out);
    expect(result.out).toContain(`copy: ${copy.length} bytes, sha256 ${createHash("sha256").update(copy).digest("hex")}`);
    expect(createHash("sha256").update(readFileSync(fx("book.xlsx"))).digest("hex")).toBe(before);

    const report = JSON.parse(doc("inspect", out, "--json").out);
    expect(report.sheets.map((s: { name: string }) => s.name)).toEqual(["KK 1.2", "KK 1.2b", "Rahasia"]);
    expect(doc("query", out, "SELECT jumlah FROM t WHERE nama = 'Nanas'").out).toContain("| 10 |");
    expect(doc("query", out, "SELECT jumlah FROM t WHERE no_ = 1", "--sheet", "KK 1.2b").out).toContain("| 999 |");
  });

  test.skipIf(!OPENPYXL)("apply --accept-loss goes ahead, and names what was lost", () => {
    const plan = join(DIR, "plan-accept.json");
    writeFileSync(plan, JSON.stringify({ ops: [{ set: { "KK 1.2!B4": "x" } }] }));
    const result = edit("apply", fx("risky.xlsx"), plan, "--out", join(DIR, "risky.accepted.xlsx"), "--accept-loss");
    expect(result.code).toBe(0);
    expect(result.out).toContain("lost, as accepted:");
    expect(result.out).toContain("data validation in extLst (1 -> 0)");
  });
});

/**
 * The two SKILL.md files are read by a model, so the rules that keep a person's document safe are asserted on as
 * wording: where the script is, inspect before anything, the original never written, the far machine's lock checked
 * and the person's Excel never killed, big data queried rather than printed.
 */
describe("the document skills say how to use the scripts", () => {
  const reading = readFileSync(join(ROOT, "content/skills/document-reading/SKILL.md"), "utf8");
  const authoring = readFileSync(join(ROOT, "content/skills/document-authoring/SKILL.md"), "utf8");

  test("both need python3, and say where their script is from the path the SKILLS list gave", () => {
    expect(reading).toMatch(/^requires: .*python3/m);
    expect(authoring).toMatch(/^requires: .*python3/m);
    expect(reading).toContain("The script is\n`scripts/doc.py` in that same directory");
    expect(authoring).toContain("the helper is\n`scripts/xlsx_edit.py` in that directory");
  });

  test("reading: inspect first, convert to a file, query a big sheet instead of printing it", () => {
    expect(reading).toContain("**Always `inspect` first.**");
    expect(reading).toContain("## Rule zero: convert to a file, never into your reply");
    expect(reading).toContain("**`query` for counts, sums, filters, joins.**");
    expect(reading).toContain("`max_row` counts formatted empty rows");
    expect(reading).toContain("**Copy it here once, work on the copy, copy back once:**");
  });

  test("authoring: never the original, refused means ask, and the far copy is checked for a lock first", () => {
    expect(authoring).toContain("**never the original**");
    expect(authoring).toContain("Do not reach for openpyxl directly to get round it");
    expect(authoring).toContain("**make sure nobody has it open**");
    expect(authoring).toContain("Never close or kill their Excel; ask them to.");
    // Missing tectonic must not send an agent off to install a typesetter to edit a spreadsheet.
    expect(authoring).toContain("that is about the PDF part only");
    // The ordering that matters: editing is described before the LaTeX procedure, not appended under it.
    expect(authoring.indexOf("## Editing a workbook")).toBeLessThan(authoring.indexOf("## 1. Check the toolchain first"));
  });
});
