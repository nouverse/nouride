---
name: document-authoring
description: Produce a typeset PDF with LaTeX (paper, report, thesis, letter or CV, one or two columns, a journal's own class) with a helper that compiles it and names each problem by its line, and change an existing Excel workbook safely (add a sheet, set cells, append rows) with a helper that refuses what openpyxl would silently drop and never overwrites the original. Use when asked for a PDF, a paper, a thesis chapter, a typeset document, or to edit an .xlsx/.xlsm, here or on another machine.
requires: tectonic, pandoc, python3
needs_tools: exec, read, write, send_file
author: Nouride
---

# Making and changing documents

Two jobs live here, and they need different things:

| Asked to | Go to | Needs |
|---|---|---|
| change an existing workbook (add a sheet, fill cells, append rows) | **Editing a workbook** below | `python3` + openpyxl (not tectonic) |
| produce a typeset PDF (paper, report, thesis, letter, CV) | **Typesetting a PDF**, §1–§6 | `tectonic` |

If this skill is marked UNAVAILABLE for want of `tectonic`, that is about the PDF part only; editing a workbook
does not use it.

Look before you change anything: the `document-reading` skill's `doc.py inspect` gives a workbook's real sheets,
used ranges and header rows in one call. Never write a script just to list sheets or find where data ends.

## Editing a workbook

The SKILLS list gave you this file's path, ending in `document-authoring/SKILL.md`; the helper is
`scripts/xlsx_edit.py` in that directory. Below, `EDIT` stands for its full path. Write the full path each time.

**openpyxl rewrites the whole file and drops what it does not understand, without a word**: shapes and text boxes,
slicers, Power Query, form controls, threaded comments, dropdowns that Excel stores in `extLst` (the usual kind
that points at another sheet), and it rebuilds charts from what it can parse. It also keeps no calculated values:
after a save every formula is empty to anything but Excel until it is recalculated. The helper exists so none of
that happens unseen.

1. **Check:** `python3 EDIT check FILE` (standard library only). Lists what the workbook holds and what openpyxl
   would do to each; exit `4` means `apply` will refuse it.
2. **Plan:** write the change as JSON (with `write`, to `$TMPDIR/plan.json`):

   ```json
   {"ops": [
     {"add_sheet": "KK 1.2b", "after": "KK 1.2", "copy_of": "KK 1.2"},
     {"set": {"'KK 1.2b'!B4": "Nilai", "Rekap!D10": "=SUM('KK 1.2b'!C4:C20)", "Rekap!E2": {"date": "2026-10-20"}}},
     {"rows": "KK 1.2b!A5", "values": [["a", 1], ["b", 2]]},
     {"append": "Rekap", "values": [["x", 3]]}
   ]}
   ```

   A string starting with `=` is a formula (`{"text": "=..."}` for literal text). `append` goes after the last row
   with a value (not Excel's padded last row), styled like that row. `copy_of` copies cells, styles, merges,
   validation, conditional formats and freeze panes, not charts, images or tables (it says so if any were left).
   A cell inside a merged range is refused with the top-left cell to use instead.
3. **Apply:** `python3 EDIT apply FILE "$TMPDIR/plan.json" [--out COPY]` writes a copy (default
   `$TMPDIR/<name>.edited.xlsx`), **never the original**; keeps macros in an `.xlsm` (and the extension); reopens
   the copy, checks every cell reads back as written, and compares its parts with the original's. Anything missing
   deletes the copy (exit `5`). Show the person the change list it prints.
4. Refused (exit `4`)? Say what would be lost. Then: they make the change in Excel or LibreOffice, or they agree
   to lose it and you rerun with `--accept-loss`. Do not reach for openpyxl directly to get round it. That is the
   same loss without the list.
5. Need the computed values (to check a total)? `libreoffice --headless --convert-to xlsx --outdir "$TMPDIR/recalc"
   COPY` recalculates into a second copy you can `doc.py query` or `extract`. Excel recalculates by itself on open.

Not offered, on purpose: inserting rows or columns in the middle (openpyxl does not move formulas, merges or
validation with them) and renaming sheets (formulas that name the old sheet break). Do those in Excel or
LibreOffice, or tell the person.

A `.xls`, `.ods` or Excel-2003-XML file: convert to `.xlsx` with LibreOffice first and say the result will be an
`.xlsx`. A Word file: python-docx keeps the parts it does not understand, but text is split into runs, so a
find-and-replace on paragraph text loses formatting or misses matches. Change runs, and check the result with
`doc.py inspect`.

### The workbook is on another machine

The usual case: a Windows laptop over ssh, with no Python. Do not install Python there or write scripts on it.
Copy once, work here, copy back once:

```sh
scp 'laptop:C:/Users/Ani/Documents/Laporan.xlsx' "$TMPDIR/Laporan.xlsx"
python3 EDIT check "$TMPDIR/Laporan.xlsx"
python3 EDIT apply "$TMPDIR/Laporan.xlsx" "$TMPDIR/plan.json"           # -> $TMPDIR/Laporan.edited.xlsx
```

Before copying back, **make sure nobody has it open**. Excel holds an exclusive lock, and overwriting under it
fails or, worse, is overwritten again by their next save. Never close or kill their Excel; ask them to.

```sh
ssh laptop "powershell -NoProfile -Command \"try { [IO.File]::Open('C:\Users\Ani\Documents\Laporan.xlsx','Open','ReadWrite','None').Close(); 'free' } catch { 'LOCKED' }\""
```

`free`: copy to a new name beside it, keep the original as a backup, then swap, so a failed copy leaves the
original intact:

```sh
scp "$TMPDIR/Laporan.edited.xlsx" 'laptop:C:/Users/Ani/Documents/Laporan.new.xlsx'
```

**Then check it arrived, before the swap and before you say "done".** A copy that exited 0 is not a copy that
landed: a quote or a space in the path can send it somewhere else, or nowhere, without an error. Compare size and
SHA-256 on the far side with the local copy (`apply` printed the local pair as `copy: <bytes> bytes, sha256 <hex>`):

```sh
# Windows (PowerShell over ssh) — Get-FileHash prints the hash in upper case; compare ignoring case
ssh laptop "powershell -NoProfile -Command \"(Get-Item 'C:\Users\Ani\Documents\Laporan.new.xlsx').Length; (Get-FileHash -Algorithm SHA256 'C:\Users\Ani\Documents\Laporan.new.xlsx').Hash\""
# Linux / macOS
ssh host "wc -c < '/home/ani/Laporan.new.xlsx'; sha256sum '/home/ani/Laporan.new.xlsx' 2>/dev/null || shasum -a 256 '/home/ani/Laporan.new.xlsx'"
# the local copy, if you no longer have apply's line
wc -c < "$TMPDIR/Laporan.edited.xlsx"; sha256sum "$TMPDIR/Laporan.edited.xlsx" 2>/dev/null || shasum -a 256 "$TMPDIR/Laporan.edited.xlsx"
```

Both match: swap, keeping the original as a backup, and run the same check once more on the final name:

```sh
ssh laptop "powershell -NoProfile -Command \"Copy-Item 'C:\Users\Ani\Documents\Laporan.xlsx' 'C:\Users\Ani\Documents\Laporan.backup.xlsx'; Move-Item -Force 'C:\Users\Ani\Documents\Laporan.new.xlsx' 'C:\Users\Ani\Documents\Laporan.xlsx'\""
```

Either differs, or the file is not there: do not swap and do not report it done. Say what the check showed, fix
the path or copy again, and check again.

`LOCKED`: tell the person to save and close it, and wait. Say where the backup is when you are done.

### Edge cases

| Case | What to do |
|---|---|
| password-protected workbook | `doc.py inspect` says so; ask for an unprotected copy (nothing here opens it) |
| sheet protection | openpyxl can still write the cells; say the sheet was protected, so they know |
| macros (`.xlsm`) | kept; the copy stays `.xlsm`. A signature on the macros does not survive |
| charts, shapes, slicers, Power Query, `extLst` dropdowns | refused by default (see step 4) |
| formulas | kept as formulas; no values until recalculated (step 5) |
| a very large workbook | `apply` loads it whole: on a small box check `inspect`'s size first, and run it as a background job |
| the file is open on this machine | `check` reports the lock file; edit a copy and do not copy back until it is closed |

## Typesetting a PDF

The output target is a document that survives being printed: consistent margins, real hyphenation,
floats that land where a reader expects them. HTML-to-PDF cannot do the two-column case (no browser
engine floats a table across both columns), so this is LaTeX, and the templates beside this file are
the starting points.

## 1. Check the toolchain first

```sh
command -v tectonic || echo "MISSING"
```

**If it is missing, stop and say so.** Do not silently fall back to a worse format. The person asked
for a typeset document and a Markdown file is not one. Tell them:

> This needs `tectonic` (a single-binary LaTeX engine, ~30 MB).
> macOS: `brew install tectonic` · Arch: `pacman -S tectonic` · any other Linux, Alpine included:
> `curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh`, which drops the
> binary in the current directory (run it from the bin directory your instructions name)

Not `cargo install`: that compiles it from source, and needs a Rust and C++ toolchain and a long wait
for a program that ships as one file.

`tectonic` rather than a TeX Live install on purpose: TeX Live full is 2–4 GB, and Nouride is meant to
run on boxes where that is most of the disk. Tectonic downloads only the packages a document actually
uses and caches them, so **the first compile needs network** and later ones do not.

**Memory.** A one-page report compiled at about 170–210 MB, its first build fetching 24 MB of packages (measured on a
Linux box); a long document with many packages takes more. Check before the first build:

```sh
uname -m; free -m 2>/dev/null | awk '/^Mem:/{print "avail_mb", $7}' || echo "total_mb $(( $(sysctl -n hw.memsize) / 1048576 ))"
```

Under 400 MB available, it is not for here: say so, and offer another of the person's machines. The `network-reach`
skill reaches it, and the same commands run there. That limit is a starting guess from the measurement. A workbook
edit (above) is light, unless the workbook is tens of MB.

## 2. Start from a template (a floor, not a menu)

| File | A reasonable start for |
|---|---|
| `templates/two-column.tex` | papers, journal submissions, anything with an abstract |
| `templates/report.tex` | reports, proposals, chapters, letters (single column) |

Copy into the workspace, do not edit in place: they ship with the daemon and an upgrade replaces
them.

**Two files is not the range of what you can produce.** A CV, an invoice, a poster, a book with
`\chapter`s, a bilingual document. None of those is one of these two, and forcing one into the
nearest template produces something worse than writing the preamble yourself. LaTeX has a class for
each; use it. These two exist because they are the common cases, not the allowed ones.

### Changing the shape is one word, not another template

Almost everything a person asks to change lives on the `\documentclass` line. **Read this before
reaching for the other file.** Swapping templates to get one column throws away the abstract, the
section structure and the table setup that came with it.

```latex
\documentclass[10pt,a4paper,twocolumn]{article}
```

| If asked for | Change |
|---|---|
| one column instead of two | delete `twocolumn` |
| two columns on a report | add `twocolumn` |
| bigger or smaller text | `10pt` → `11pt` / `12pt`. For 9pt or 8pt the class must become `extarticle` (see below) |
| US Letter | `a4paper` → `letterpaper` |
| English instead of Indonesian | drop `\usepackage[bahasa]{babel}` |
| chapters, a thesis, a book | `{article}` → `{report}` or `{book}`, then `\chapter{...}` |
| different margins | the `geometry` line, e.g. `margin=2.5cm` |

**`article` accepts only 10pt, 11pt and 12pt, and lies about the rest.** Asking for `9pt` is not an
error and tectonic prints no warning. The option is silently dropped and you get a 10pt document
that you will hand over believing it is 9pt. Verified: the two PDFs came out one byte apart. Only the
TeX log says it (`Unused global option(s): [9pt]`), and `texbuild.py` reports it as `class options
ignored`. `\documentclass[9pt,...]{extarticle}` is the version that works.

**Run `texbuild.py` (§3) again after changing this line.** Type size and paper size move the measure, and
a table sized for the old one is now the wrong width. Verified on this very template: `10pt` →
`12pt` turns a clean compile into `Overfull \hbox (1.96pt too wide)` on the tabular. That is under 2pt, far
too small to see in a thumbnail, perfectly visible in print, and the log is the only thing that
mentions it.

**A real journal format is a different class, not a lookalike.** `two-column.tex` resembles an IEEE
paper; it is not one, and a submission would be rejected on it. For the real thing:

```latex
\documentclass[conference]{IEEEtran}   % or [journal]
```

Tectonic downloads `IEEEtran` on first use, so nothing has to be installed. The same holds for
`acmart`, `llncs` (Springer) and `elsarticle`. When someone names a venue, use its class.

### What to assume, and when to ask

Asking about formatting the person has no opinion on wastes a round; assuming on something they
care about wastes the document.

- **They said it → do it.** "satu kolom", "A4", "pakai bahasa Inggris" is the end of the question.
- **Report, proposal, letter, memo, summary → single column.** Do not ask. Nobody wants a
  two-column memo.
- **Paper, makalah, jurnal, skripsi, thesis → two columns**, and say so in one clause when you hand
  it over ("dua kolom, format artikel. Bilang kalau mau satu kolom"). One sentence, not a question
  that blocks.
- **Named venue or institution → ask for the template or the guidelines**, once. A university has a
  required margin and font size, and guessing them produces a document that has to be redone.
- **Anything else → build it and say what you assumed.** A wrong assumption stated plainly costs one
  correction. An unstated one is found after it has been sent.

## 3. Compile with the helper, and read what it says

`scripts/texbuild.py`, beside `xlsx_edit.py`, compiles and checks in one command. Below, `TEXBUILD` stands for its
full path. Write the full path each time:

```sh
python3 TEXBUILD paper.tex          # -> build/paper.pdf, its findings, and build/pages/page-N.png to look at
```

It makes the output folder (tectonic does **not**, and fails with `error: output directory "build" does not exist`
before it reads a line), keeps the TeX log, and reads it together with what tectonic printed. Both are needed:
**tectonic's own output leaves out a `\ref` or `\cite` that did not resolve** (the PDF prints `??`), **a float too
large for the page, and a class option the class ignored**. Verified: a document with all three compiled, exited `0`,
and printed none of them. Only the log has them.

**The exit code of a compile is not the review.** A document with content hanging out of the column compiles, writes a
PDF and exits `0`. texbuild's own exit says it: `0` nothing found, `4` a PDF with findings, `5` no PDF.

On an error it prints the line, where LaTeX stopped on it, and the usual cause:

```text
error: paper.tex:4: Missing $ inserted
  4 | Price is 5_000 and \textbf{bold}.
  stopped right after: "Price is 5_"
fix: a character that works only in math is in plain text: write \_ for _, \^{} for ^, or put the formula in $...$
```

LaTeX stops at the first error: fix it and run again. There may be another behind it. With a PDF it lists every
finding, each with its file and line. Fix each and run again until it says `findings: none`:

| Finding | What is actually wrong | Fix |
|---|---|---|
| `overfull: … wider than the column` | something wider than the column, nearly always a table or a long unbroken string | shrink the table (§4), or wrap the string in `\seqsplit` / allow `\-` hyphens |
| `overfull: … taller than the page body` | content taller than the page | move a float, or split the paragraph |
| `float too large` | a `table`/`figure` that fits nowhere | promote it to `table*` (§4), or shrink it |
| `undefined reference` / `undefined citation` | `??` in the PDF: a `\label` missing or spelt differently, a key not in the bibliography | fix the name (tectonic already reruns until references settle, so compiling again does not fix it) |
| `class options ignored` | `9pt` on `article`, which takes only 10, 11 and 12pt (§2) | `extarticle` |
| `missing characters` | an emoji, CJK or a symbol the font has no glyph for: the PDF leaves it out | `\usepackage{fontspec}` and `\setmainfont` a font that has them, or write them another way |
| an error, `Too many unprocessed floats` | floats queued up and never placed | `\clearpage` before the next section |

**`Underfull \hbox` is not a finding and must not be chased.** Justified text in a narrow `p{}` column produces them
by the dozen. A three-column table of prose will emit ten and be perfectly typeset. Only `Overfull` means something
is actually sticking out.

An overfull box of 2pt is invisible in a thumbnail and obvious in print, so **a look at the first page does not
replace `findings: none`**. It is also the check that proves a table's column widths: if they added up to more than
the measure, this is what would say so.

No `python3` here? Compile by hand with `mkdir -p build && tectonic -X compile paper.tex --outdir build --keep-logs`,
and search **both** what it printed and `build/paper.log` for `Overfull`, `undefined`, `Float too large`,
`Missing character` and `Unused global option`.

### Then look at it, before it is sent

`findings: none` is half of done. It cannot see what the document *says*: a title still the template's, a
table that landed pages from where it is discussed, Indonesian headings over an English body, a page that
came out empty. **Nothing is sent before it is looked at.** texbuild rendered the pages and printed their
paths (`pages: …`). `read` each picture: every page of a short document; of a long one it renders the
first three and the last, and `--pages 4-7` renders the pages a finding named. Rendering needs `pdftoppm`
(poppler, as `pdftotext` is for the `document-reading` skill); texbuild says when it is missing. If your
model cannot see images, say so when you send it.

Once what you saw is fixed and compiled again, **render and read those pages again**: an edit moves
what is around it, and a line added to page 1 can push its last paragraph onto a page 2. The PDF you
send is the one you looked at last. With `findings: none` too, send it with `send_file`, with a line on
what it is and what you assumed (§2).

## 4. Tables: the part that goes wrong

This is where two-column documents actually break.

**A table wider than one column goes in `table*`, not `table`.** The starred float spans both
columns. This is the native mechanism; there is no CSS equivalent, which is the reason this skill is
LaTeX at all.

```latex
\begin{table*}[t]
  \centering
  \caption{Literature matrix}
  \label{tab:lit}
  \begin{tabular}{@{}p{0.5cm}p{2.5cm}p{3cm}@{}}
    \toprule
    No & Author & Title \\
    \midrule
    1 & ... & ... \\
    \bottomrule
  \end{tabular}
\end{table*}
```

Three rules that are not obvious and each cost a debugging round:

1. **`table*` only places at the top of a page.** `[h]` and `[b]` are ignored for starred floats.
   Ask for `[t]`, and expect it to appear on the *next* page if the current one is already committed.
   That is correct behaviour, not a bug to fight.
   In a document only a page or two long (the shipped template, or an early draft), the deferred
   float can end up **alone on an otherwise empty page**, vertically centred. That looks broken and
   is not: there was no body text left to put under it. It resolves itself as the document grows,
   and the wrong reaction is to fight it with `[h!]` or to demote it to an unstarred `table`, which
   silently costs you the full-width span.
2. **`longtable` does not work in two-column mode.** It is not a float and it needs a full-width
   galley. A long table in a two-column paper has exactly three honest options: split it into several
   `table*` floats by hand, move it to an appendix wrapped in `\onecolumn … \twocolumn`, or use
   `supertabular`.
3. **Use `p{width}` columns for prose cells**, never bare `l`/`c`. A `l` column will not wrap, so a
   sentence in a cell becomes one very long line and the first `Overfull \hbox` of the day.

Fixed column widths beat `tabularx` when the total must be exact. Add them up against
`\textwidth` (single column) or `\linewidth`×2 + `\columnsep` (spanning).

## 5. Language

For Indonesian, the templates already load `babel` with `bahasa`. It changes hyphenation and the
auto-generated words (`Tabel`, `Gambar`, `Daftar Pustaka`). Without it a document reads as English
typesetting with Indonesian words in it, and the hyphenation is visibly wrong.

## 6. What this skill is not for

- **A new DOCX / PPTX**: `pandoc -o out.docx` works for plain prose and produces something unremarkable.
  For anything that needs to look designed, say so rather than shipping a mediocre file.
- **Filling in an existing PDF form**: different problem, different tools.
