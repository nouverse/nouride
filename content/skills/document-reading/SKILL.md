---
name: document-reading
description: Look inside any document (PDF, Word, Excel/CSV, PowerPoint, ODF, EPUB, scanned) with one helper script that names its real type, lists sheets/headings/slides/pages and their traps, pulls any part out to a file, and answers SQL over a big sheet without loading it. Use when asked what a document says, to summarise or quote one, to find figures in a spreadsheet, before editing one, or when `read` says a file is a binary document.
requires: python3, pdftotext
needs_tools: exec, read, grep
author: Nouride
---

# Reading a document

`read` handles UTF-8 text. A PDF, a `.docx` or a workbook is a container, so the job is always: **find out what it
is, convert the part you need to a file, then work on that file with `read` and `grep`.** A script ships beside this
file to do the first two for every format, so you never write a parser.

## This machine

Light. `doc.py` peaked under 30 MB reading a PDF and a 20,000-row sheet (measured on a Linux box), so it runs on a
512 MB board. A long document is read a part at a time (`--pages`, `--rows`, `query`), which also keeps the memory small.

## Where the script is

The SKILLS list gave you this file's path, ending in `document-reading/SKILL.md`. The script is
`scripts/doc.py` in that same directory. Below, `DOC` stands for its full path; write the full path in each
command, e.g. `python3 /opt/nouride/skills/document-reading/scripts/doc.py inspect report.xlsx`.

It needs only `python3`. It uses pypdf, poppler (`pdftotext`) or LibreOffice when a format needs them and tells you
what to install when they are missing. It never prints a traceback. Exit codes: `0` done, `1` bad arguments,
`2` the file cannot be read as it is (the message says why), `3` a program is missing (the message says which).

## Which command

| You want to | Run |
|---|---|
| know what a file is and what is in it | `python3 DOC inspect FILE` |
| read the text of a PDF / Word / slides / EPUB | `python3 DOC extract FILE`, then `read`/`grep` the file it names |
| a sheet as CSV or a Markdown table | `python3 DOC extract FILE --sheet "Name" [--range A1:H200 \| --rows 1-500] [--format md]` |
| a count, total, filter or join over a sheet or CSV | `python3 DOC query FILE "SELECT ... FROM t ..."` |
| the formulas, not their values | `extract ... --formulas` |
| Word tracked changes marked, not accepted | `extract ... --changes` |
| some pages of a PDF | `extract FILE --pages 3-5` |
| to change a workbook | `inspect` it first, then the `document-authoring` skill's `xlsx_edit.py` |

**Always `inspect` first.** It decides the type from the bytes, not the name, and says what to watch for. For a
workbook it gives each sheet's real used range (not Excel's padded one), the header row, merged cells, formulas
without saved values, hidden sheets, tables, named ranges, data validation, charts. For a Word file: the heading
outline, tables, tracked changes, comments, headers and footers. For slides: titles, hidden slides, notes. For a PDF:
pages, encryption, form fields, and whether there is a text layer at all. For a CSV: encoding, BOM, delimiter, ragged
rows. Save it when you will need it again: `python3 DOC inspect FILE > "$TMPDIR/FILE.inspect.md"`.

## Rule zero: convert to a file, never into your reply

`extract` always writes a file (`$TMPDIR/doc-extract/...` unless `--out`) and prints only its path and size. Then
`read` it with `offset`/`limit`, or `grep -n` it. Three reasons, and the third is the one that bites:

- `read` and `grep` page, cap and spill. A 200-page report piped through `exec` arrives as one tool result, and a
  result too large for the context is cut to a head and a tail; the middle is gone and nothing says so.
- The file survives the turn. Another section costs a `read`, not another conversion.
- **On a long document you almost never want it linearly.** Convert, `grep` for what you were asked about, read
  around the hits. That is the difference between answering from three pages and from a truncated forty.

Do not `cat` an extracted file into `exec`, and do not print rows into the conversation beyond a short sample.

## Large data

A sheet of tens of thousands of rows is a database question, not a reading one.

- **`inspect` once**, save it, reuse it. Do not probe with scripts that print `max_row` or guessed ranges:
  `max_row` counts formatted empty rows (it said 1000 where 142 were real); `inspect`'s used range does not.
- **`query` for counts, sums, filters, joins.** It streams the sheet once into a SQLite file under
  `$TMPDIR/doc-query`, reused until the document changes, and prints at most 50 rows with the total. The sheet is
  table `t` (`--sheet` picks which); other sheets are tables named after themselves, loaded when the query names
  them. `python3 DOC query FILE` alone lists the columns: names are the header row lower-cased (`Jumlah Bayar` →
  `jumlah_bayar`), `_row` is the sheet row number. Numbers are numbers (a decimal-comma file is detected), codes
  with leading zeros stay text. More than 50 rows wanted: `--out result.csv`.
- **openpyxl only to edit** (through `xlsx_edit.py`). If you must read with it, `load_workbook(f, read_only=True)`
  and `iter_rows(values_only=True)`; write big outputs with `Workbook(write_only=True)`.
- **pandas only if it is installed and the data fits easily.** The box may have ~2 GB of memory, and a workbook
  in pandas takes many times its file size.
- Work that takes minutes goes to a helper in the background, not the foreground turn.

## The file is on another machine

If the document is on a machine reached over ssh (often a Windows laptop with no Python), do not write scripts
there. **Copy it here once, work on the copy, copy back once:**

```sh
scp 'laptop:C:/Users/Ani/Documents/Laporan.xlsx' "$TMPDIR/Laporan.xlsx"   # forward slashes work on Windows OpenSSH
python3 DOC inspect "$TMPDIR/Laporan.xlsx"
```

To put an edited copy back, see the `document-authoring` skill: it checks the file is not open first, and compares
size and SHA-256 on the far side before anything is called done. A copy here works the same way the other
direction: `wc -c` and `sha256sum` (macOS `shasum -a 256`) on the local copy against the far side's
(`(Get-Item P).Length` and `Get-FileHash -Algorithm SHA256 P` on Windows) say the bytes you read are the bytes
there. Without
copying, PowerShell can at least list a workbook's parts (`Add-Type -A System.IO.Compression.FileSystem;
[IO.Compression.ZipFile]::OpenRead('C:\path\Book.xlsx').Entries.FullName`), enough to see its sheets, not to
read them.

## Edge cases, and what the script does about them

| Case | What happens |
|---|---|
| `.xls` that is really HTML, CSV or Excel 2003 XML (bank and ERP exports) | named for what it is; `extract`/`query` read its tables directly |
| real legacy `.xls` / `.doc` / `.ppt` / `.xlsb` | converted with LibreOffice first (asks for it if missing) |
| password-protected Office file or PDF, encrypted zip | refused with exit 2 and what to ask for; there is no way round a password |
| 0-byte, truncated or corrupt file | refused with exit 2: get a fresh copy (a transfer cut short is the usual cause) |
| scanned PDF (no text layer) | said plainly; OCR with `ocrmypdf`, or `pdftoppm -png -r 150 -f N -l N in.pdf "$TMPDIR/page"` and look at the pages; never report it blank |
| garbled PDF text (fonts with no Unicode map) | flagged; OCR gives better text |
| CSV with BOM, `;` delimiter, decimal commas, cp1252 or mixed encodings | detected and reported; `extract` writes clean UTF-8, `query` reads `1.234,56` as 1234.56 |
| merged cells | listed; the value sits in the top-left cell, the rest are empty |
| formulas | values by default, `--formulas` for the formulas; formulas with no saved value (written by a library, never opened in Excel) are flagged: recalculate with `libreoffice --headless --convert-to xlsx --outdir "$TMPDIR/recalc" FILE` |
| macros (`.xlsm`, `.docm`) | reported; nothing here runs them |
| hidden sheets, hidden rows and columns | reported; they still feed formulas and totals |
| Excel's used range padded by formatted empty cells | `inspect` gives the real one beside the declared one |
| file open in Excel or LibreOffice on this machine | the lock file beside it is reported: do not overwrite it |
| very large sheet or PDF | streamed, never loaded whole; page with `--rows` / `--pages`, or `query` it |

## What to do with what you found

Quote, do not paraphrase, when the question is about what the document *says*: a figure, a clause, a deadline.
Give the page, sheet and cell with it (`_row` in a query result is the sheet row), because the person will want
to check it, and a line number in a converted file means nothing to them.

Attachments that arrived in the chat are already on disk under your attachment directory; the FILES block says
where. Work on them where they are.

## Without the script

If `python3` is missing and cannot be installed, the old ladder still works: `pdftotext -layout in.pdf out.txt`,
`pandoc in.docx -t markdown -o out.md`, `libreoffice --headless --convert-to csv --outdir "$TMPDIR" in.xlsx`, each
to a file, then `read`/`grep` it. Install the missing program rather than writing a parser from memory:
`nouride pkg install poppler-utils` on a Nouride host, `brew install poppler`, `apt install poppler-utils`,
`apk add poppler-utils`; follow the install steps in your TOOLS section for who approves it.
