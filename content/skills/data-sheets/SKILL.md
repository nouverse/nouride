---
name: data-sheets
description: "Read before computing anything from a CSV, Excel or JSON file, and before drawing any chart (bar, line, pie, scatter) or dashboard from a file or from numbers in the chat. Its scripts profile columns (blanks, duplicates, Total rows, 1.234,56 vs 1,234.56, dd/mm vs mm/dd), clean a copy, sum, pivot and join with SQL, chart in the reader's locale and currency, and write a new XLSX, with totals that reconcile with the source. For data analysis, a recap, a chart or graph, top-N and growth."
requires: python3
needs_tools: exec, read, write, send_file
author: Nouride
---

# Working with tables of data

A wrong number in a finding is worse than no finding: the person repeats it in a meeting. Most wrong numbers do not
come from the arithmetic. They come from the table: a **Total row summed with the rows above it**, `1.250` read as one
and a quarter when the file meant one thousand two hundred and fifty (or the other way round), `03/04` read as 4 March
when it meant 3 April, "Jakarta" and "jakarta " counted as two cities, a duplicate row, a blank read as zero. So the order is always: **look, clean, compute, check, then
say.** Scripts beside this file do the looking, cleaning, charting and writing; you decide and explain.

## This machine

Light. The helpers peaked under 70 MB of memory on a 20,000-row file (measured on a Linux box), so they run on a
512 MB board. Memory grows with the file: one of hundreds of MB is queried with the `document-reading` skill's
`doc.py query`, which keeps it in SQLite, rather than loaded whole.

## The scripts

The SKILLS list gave you this file's path, ending in `data-sheets/SKILL.md`. The scripts are in `scripts/` in that same
directory; below, `DS` stands for that `scripts` directory's full path. Write the full path in every command, e.g.
`python3 /srv/nouride/skills/data-sheets/scripts/profile.py sales.csv`. Reading and SQL come from the
`document-reading` skill's `doc.py` (written `DOC` below: `<document-reading>/scripts/doc.py`).

| Script | Does | Needs |
|---|---|---|
| `scripts/profile.py` | what is in each column and what is suspicious | python3 (openpyxl for .xlsx, or it uses `doc.py`) |
| `scripts/clean.py` | a clean CSV copy: plain numbers, ISO dates, trimmed text, Total rows out, a change log and a reconciliation | same |
| `scripts/chart.py` | a PNG chart from a table or from inline numbers (JSON), numbers and money in the reader's locale and currency, with the plotted numbers printed | matplotlib (Babel optional) |
| `scripts/xlsx_write.py` | a new formatted workbook from tables, optionally with an Excel chart or the PNG, checked after writing | openpyxl |
| `DOC query` | SQL over a sheet or CSV: sums, counts, group by, joins, window functions | python3 |

Missing a library: `pip install matplotlib openpyxl`. On a Nouride host plain `pip install` goes into your own
Python env, no flags; follow your TOOLS section for who approves an install. `pip install babel` is optional: without
it chart.py formats 36 common locales and 31 currencies from a table beside it; with it, every locale and currency. Every script has `--help`, prints no
traceback, and exits `0` done, `1` wrong arguments (the message says which), `2` the file cannot be read, `3` a library
is missing. They never write the file they read.

## 1. Look: inspect and profile

```sh
python3 DOC inspect data.xlsx                 # sheets, real used range, header row, merged cells, hidden sheets, formulas
python3 DS/profile.py data.xlsx --sheet "Sales"     # CSV, TSV, JSON and .xlsx alike
```

`inspect` (document-reading) says what the *file* is. `profile` says what the *data* is: one block per column.

```text
! 2 row(s) look like totals or subtotals (rows 127, 128) - leave them out of any sum, or the total is counted twice
## 7. "Total" - integer, written 1.234,56 (comma decimal)
  total row: row 128 says 102,172,000; the other rows add up to 103,244,500 - they DIFFER by -1,072,500
  outliers: 1 outside 3xIQR [...]: row 125 (16,250,000)
## 3. "City" - text
  SPLIT: 4 value(s) written several ways: "Jakarta" / "jakarta "; ...
```

Read every line that starts with `!` and every `SPLIT`, `REPEATS`, `NOT numbers`, `NOT dates`, `outliers`, `total row`
and `note`. Each is a decision for you (§2), and some are a question for the person. Above, the file's own Total says
102,172,000 but the rows add up to more: the difference is exactly one duplicated invoice (`REPEATS` on the invoice
column names it). That is a finding, not noise.

| profile says | It means | Do |
|---|---|---|
| `look like totals` | Total/Subtotal rows (and their equivalents in other languages) inside the data | `clean.py` drops them; use the file's own total only to check yours |
| `total row ... DIFFER` | the rows do not add up to the file's own total | find out why before reporting either number: duplicates, a filter, a hidden row (`inspect` lists hidden rows) |
| `duplicate row` / `REPEATS` | the same row twice; an ID used twice | ask whether it is a double entry; `--drop-duplicates` only when it is |
| `written 1.234,56` / `written 1,234.56` | the column's decimal separator, decided from its own values | nothing: the scripts and `DOC query` read it correctly; never parse numbers yourself with `float()` |
| `AMBIGUOUS: values like 1.250` | every value could be thousands or a decimal | **decide, do not guess** (below); clean.py, chart.py and xlsx_write.py refuse the column until you pass `--decimal comma` (1.250 = 1250) or `--decimal dot` (1.250 = 1.25) |
| `AMBIGUOUS dates` | no date has a day over 12, so 03/04 reads both ways | find out where the data comes from (below); then `--dates dayfirst` or `--dates monthfirst` |
| `units or currencies differ` | Rp and USD, or `1,5 jt` and `1.500.000` in one column | convert to one unit before any sum; say the rate you used and its date |
| `SPLIT` | one value written several ways | `clean.py --unify "<column>"` |
| `NOT numbers` / `NOT dates` | cells that do not fit | look at those rows; `clean.py` empties them and lists them. Never guess a value |
| `outliers` | far outside the rest | check the row: a typo (an extra zero), a real big order, a unit mixup. Report it either way; never delete it silently |
| `code` | leading zeros (NIK, kode pos, phone) | stays text; never sum or average it |
| `empty` with `"-"`, `N/A` | placeholders for no value | empty, not zero: an average with blanks as zeros is wrong |

**Resolve an ambiguous column in this order**, and say in the answer which one settled it:

1. **A total you know.** The file's own Total row, a figure the person gave, or another column: `quantity × unit
   price = line total` holds under one reading only. Compute it both ways (`--decimal comma`, then `--decimal dot`)
   and keep the one that matches.
2. **The rest of the file.** profile's note says when another column is written unambiguously (`1.234.567,89`
   or `1,234,567.89`); a file is almost always consistent. Strong evidence, but still say you relied on it.
3. **Ask the person**, in one line, in their language: "In the Price column, is 1.250 one thousand two hundred and
   fifty, or one and a quarter?" Wait for the answer before computing.

The same for dates: a column where some day is over 12 settles it; otherwise the source system (a European or
Indonesian export is day first, a US one month first) or the person.

A huge file: `--limit 50000` for a first look, then the whole thing as a background job if it takes more than a minute.

## 2. Clean: a copy, never the original

```sh
python3 DS/clean.py data.xlsx --sheet "Sales" --out work/clean.csv --unify "City" --row-numbers
```

It writes `work/clean.csv` and `work/clean.changes.csv` (every row dropped and every value emptied or rewritten, with
its source row), and prints a reconciliation:

```text
dropped 2 Total row(s): rows 127, 128
reconcile "Total": source rows 103,244,500 -> clean 102,172,000 (the difference 1,072,500 is the dropped duplicate rows)
EMPTIED 1 value(s) in "Qty" that are not numbers: row 77 "five" - check them in the original
```

- **Read the reconciliation.** Source and clean totals differ only by what you chose to drop. Anything else is a bug;
  stop and find it.
- `--drop-duplicates` only after you decided they are double entries; `--text "No HP"` keeps a column exactly as
  text; `--keep-totals` when the Total rows are wanted; `--snake` for SQL-friendly headers.
- `--row-numbers` adds `source_row`, so any figure can be traced to the row the person sees in Excel.
- The person's file is never changed. To change *their* workbook (add a sheet, fix cells), use the
  `document-authoring` skill's `xlsx_edit.py`, which refuses edits that would lose parts of the workbook.

## 3. Compute: SQL over the clean file

`DOC query` loads a CSV or sheet into SQLite once (cached) and prints at most 50 rows. Column names are the headers in
lower case with underscores (`Unit Price` → `unit_price`); `DOC query FILE` alone lists them. The table is `t`.

```sh
python3 DOC query work/clean.csv "SELECT city, SUM(total) AS total, COUNT(*) AS n FROM t GROUP BY city ORDER BY total DESC"
```

`references/analysis.md` beside this file has the recipes: pivots, top-N with a share of total, month-on-month and
year-on-year change, running totals, joins between files, de-duplication, medians. Read it before writing anything
more than a GROUP BY.

- **Never compute by reading rows into your reply** and adding them up yourself. Every number you report comes from a
  query or a script's output.
- More than 50 rows wanted: `--out result.csv`.
- **Two files to join**: put both into one workbook, then join the sheets by name:
  ```sh
  python3 DS/xlsx_write.py work/both.xlsx "orders=work/orders.csv" "customers=work/customers.csv"
  python3 DOC query work/both.xlsx "SELECT c.segment, SUM(t.total) FROM t JOIN customers c ON c.id = t.customer_id GROUP BY 1"
  ```
  Before trusting a join, count: rows in `t`, rows after the join, and rows with no match (`LEFT JOIN ... WHERE c.id
  IS NULL`). A join that multiplies rows (a key that is not unique in the other table) inflates every sum.

## 4. Check the numbers before you say them

Do these every time; write the results down, they go with the answer.

1. **The total reconciles.** The sum of your groups equals the total of the clean file, and that equals the source's
   total minus what you dropped (§2). `SELECT SUM(total_bayar) FROM t` against the group sums.
2. **The count reconciles.** Rows in groups = rows in the file (a NULL group catches blanks:
   `GROUP BY COALESCE(city, '(blank)')`).
3. **Spot-check one number by hand** from the original: one group, filtered with `WHERE`, against the rows the person
   would see in Excel (`source_row`).
4. **The units are said.** Rp or USD, thousands or units, per month or in total, which period.
5. **Percentages add up** to 100 (± rounding), and say what they are a percentage *of*.

## 5. Chart

**Locale and currency first.** Every number on a chart is written for one reader: `--locale` is their BCP-47 tag
(en-US, en-GB, en-IN, id-ID, de-DE, de-CH, fr-FR, ja-JP, pt-BR …) and `--currency` the ISO 4217 code of the money
(USD, EUR, GBP, IDR, INR, JPY, CHF …). Separators, grouping, the currency's symbol, its side, its decimals and the
short forms all follow from those two (CLDR data):

| --locale --currency | a value label | an axis tick |
|---|---|---|
| `en-US USD` | $1,234,567.50 | $1.25M |
| `id-ID IDR` | Rp1.234.568 | Rp1,25 jt |
| `de-DE EUR` | 1.234.567,50 € | 1,25 Mio. € |
| `fr-FR EUR` | 1 234 567,50 € | 1,25 M € |
| `de-CH CHF` | CHF 1’234’567.50 | CHF 1.25 Mio. |
| `en-IN INR` | ₹12,34,567.50 | ₹12.5L |
| `ja-JP JPY` | ￥1,234,568 | ￥125万 |

- **The locale is the reader's**, not the data's: the person's language and country, from the conversation or what
  you know of them. The currency is the data's: the column header, the symbol in the cells, the source.
- **Not clear? Ask** in one line rather than assume ("Should the numbers be written 1.234,56 or 1,234.56, and in which currency?"). A chart
  for a reader who writes `1.234,50` but gets `1,234.50` misreads it by a factor of a thousand.
- Never convert between currencies to make a chart unless asked; then say the rate, its source and its date.
- `--unit` is for what is not money: `%`, `kg`, `people`, `users`. A currency typed as `--unit Rp` is read as IDR (and
  says so); `--unit $` is refused, because the dollar sign belongs to several currencies.

```sh
python3 DS/chart.py bar work/clean.csv --x City --y Total --title "Sales by city, Jan–Jun 2026" \
  --ylabel "Sales" --locale id-ID --currency IDR --out work/by-city.png
python3 DS/chart.py line work/sales.csv --x Date --y Revenue --group Region --period month \
  --title "Monthly revenue by region, 2026" --locale en-GB --currency GBP --out work/trend.png
```

It sums rows that share an x (`--agg mean|count|max|min` to change), leaves Total rows out, sorts bars largest first
(unless the categories have their own order: months, dates, quarters), merges past `--top 15` into "Others" (in the locale's language), turns
many or long-labelled bars horizontal, writes values on the bars, and **prints the numbers it plotted and their
total**. Compare that total with §4's before you look at the picture. `--data-out plotted.csv` keeps them.

**Inline numbers, without a file**: a JSON config (the same format as the older `chart-maker` skill's, so its configs
still work):

```json
{"type": "barh", "title": "Monthly costs, October 2026", "xlabel": "Category", "ylabel": "Cost", "locale": "en-GB", "currency": "GBP",
 "data": [{"label": "Electricity", "value": 185.4, "info": "up 12%"}, {"label": "Internet", "value": 42}],
 "output": "work/costs.png"}
```

```sh
python3 DS/chart.py work/costs.json
```

`type` is `bar`, `barh`, `line`, `pie` or `scatter`; `info` is written beside the value. Several series: replace
`data` with `"series": [{"name": "2025", "data": [...]}, {"name": "2026", "data": [...]}]` for grouped bars or several
lines. Optional keys: `locale`, `currency`, `unit`, `sort` (`auto`, `value`, `label`, `none`), `top`, `size`,
`highlight`. Put the chart in your reply with `send_file` after `read`ing it, not with any text directive in the
message.

`references/charts.md` has the full table of which chart to use; the short version:

| To show | Use |
|---|---|
| compare categories (cities, products) | `bar`, or `barh` with many or long labels (chart.py switches by itself) |
| change over time | `line` with `--period month` (or `week`, `quarter`, `year`); `bar` for a few periods |
| several series over time or per category | `--group COL` or `--y "A,B"` (at most 6 series) |
| relation of two numbers | `scatter` (prints the correlation; it is not a cause) |
| parts of a whole, **2–6 parts** | `pie` (chart.py refuses more than 6 slices: use `barh`) |
| one category against the rest | `bar --highlight "Bandung"` |

Then **look at it**: `read` the PNG. Check, and write down, each of these:

- the title says what, where and when; the value axis has its unit or currency
- the numbers are written the reader's way (separators, currency symbol); the first line chart.py prints says which
- the bars or points match the printed numbers (largest bar = largest number; the total matches §4)
- no label is cut off or overlapping another; the text is readable at phone width (the default size is made for that)
- nothing surprising you cannot explain: a spike is a finding to say, or a data error to fix

Fix by changing the options, not by editing the picture. Send with `send_file`, with one line on what it shows. If your
model cannot see images, say so and send the printed numbers with it.

### A dashboard, or a chart chart.py does not draw

chart.py draws one plain chart per picture, on purpose. A dashboard (number tiles and several charts on one
picture), a combination it does not offer, or a look the person asked for is **your own matplotlib script**. Do not
start it from nothing: `scripts/dashboard_example.py` beside chart.py is a working one, made to be copied.

```sh
python3 DS/dashboard_example.py work/clean.csv --date Date --category City --value Total \
  --locale id-ID --currency IDR --out work/dashboard.png          # --theme dark for a chat or a dark slide
```

As it is, it reads a clean CSV (§2) and draws four tiles (the total, the rows, the average, the last month against the
one before) and four charts (by category, by month, the share of the five largest, the running total), and prints every
number it drew with a check that the totals agree. For your own: copy it (`cp DS/dashboard_example.py
work/dashboard.py`), run the copy with `--ds DS` so it finds `numfmt.py`, and change its three marked parts: `QUERIES`
(one SQL query per panel), `PANELS` (what goes where, and the words on it, in the reader's language), `LOOK` (light or
dark, the colours). What your script keeps from it, every time:

- every number from a query over the file or a script's output, never typed into the script;
- money and numbers through `numfmt.py`'s `Formatter`, in the reader's locale and the data's currency (above);
- every plotted number printed, and the totals checked against each other and against §4;
- the rules in `references/charts.md`: bars from zero, one colour per series, no dual axes, no pie past six parts;
- then `read` the PNG and do the same look-check. A label cut off at the edge and a number spilling out of its tile are
  what a layout of your own gets wrong first; the example's first draft had both.

## 6. Write the results

| The person wants | Do |
|---|---|
| an answer | the chat message (§7) |
| the cleaned data or a result table, to open in Excel | `DS/xlsx_write.py` (below) |
| a CSV for another program | the `clean.py` output or `DOC query ... --out result.csv` |
| their own workbook changed | the `document-authoring` skill's `xlsx_edit.py` |
| a report document | the finding as Markdown or PDF (`document-authoring`), with the charts |

```sh
python3 DS/xlsx_write.py work/result.xlsx "Clean data=work/clean.csv" "By city=work/by-city.csv" \
  --chart "By city:barh:City:Total" --image "Chart=work/by-city.png" --date-format dmy
```

One sheet per table, in order: numbers stored as numbers (`#,##0`, `#,##0.00`; Excel shows them with the separators
of the computer that opens it, so the same file reads right in Jakarta and in London), dates as dates
(`--date-format iso|dmy|mdy`), codes as text, bold frozen header with filters, column widths. Money is a plain number:
put the currency in the header ("Total (IDR)").
`--chart` adds an editable Excel chart beside a sheet's data (sort the table first); `--image` puts a chart.py PNG on
a sheet of its own. It then reopens the file and prints each sheet's rows and number-column totals against the source:
`checked:` at the end, or `PROBLEM` and exit 5. Never send a workbook whose check did not pass. To see it as the person
will, where LibreOffice is installed: `libreoffice --headless --convert-to pdf --outdir work/look work/result.xlsx`,
then `pdftoppm -png -r 60 -f 1 -l 2 work/look/result.pdf work/look/p` and `read` the pages.

## 7. Say what you found

Short, in the person's language, the answer first, numbers written their way. An example from a test file (written
here in English; send it in the person's language):

```text
Bandung is the largest: IDR 30.4 million, 30% of the IDR 102.2 million total (Jan–Jun 2026, 122 sales).
- March is the highest month (IDR 29.3 million) because of one IDR 16.25 million order in Bandung (row 125); without it
  March is an ordinary month.
- One invoice was entered twice (INV-0008, rows 11 and 126); I counted it once. The file's own total (102,172,000) matches.
- One row has no quantity (row 124) and is left out.
- Unit Price 45.000 is read as forty-five thousand: Qty × Unit Price = Total on every row.
File: result.xlsx (clean data, totals by city, the chart).
```

- **The number, its unit and its period**, and what it is a share of.
- **What you changed or left out**, with rows: duplicates, Total rows, cells that were not numbers. The person must be
  able to repeat your total.
- **How an ambiguous column was read, and what settled it**, for example "Unit Price 45.000 is read as forty-five thousand:
  Qty × Unit Price = Total on every row". In a live test the agent chose right and said nothing; the person cannot check
  a choice they were not told about.
- **The exact period the data covers**: the earliest and latest date profile printed ("Jan–Jun 2026"), in the
  finding and in the chart title; not the year alone when the data covers half of it.
- **Outliers and anomalies** named, with the row, and what they do to the result.
- **Rounded for reading** (IDR 30.4 million; $30.4M; 30,4 Mio. €), exact in the file. Write numbers in the reader's locale, the same
  one the charts use: `1.234.567,89` for an Indonesian or German reader, `1,234,567.89` for a US or UK one,
  `12,34,567.89` in India, `1 234 567,89` in France.
- **No cause you did not establish.** "March rose" is what the data says; "because of the promotion" only if the data or the person
  says so. A correlation is not a cause.
- Never invent a figure the data does not hold. An estimate (a projection, a trend line) is marked as one, with how
  it was made.

Long work (many files, many sheets, a monthly report built from scratch) is a mission: draft it with `mission`,
the files, the questions and the output in its brief, and how it will be judged done (for example: `xlsx_write.py`
printed `checked:`, and the finding's total matches `DOC query`'s).

## Quick reference

```sh
python3 DOC inspect FILE
python3 DS/profile.py FILE [--sheet S] [--columns "A,B"] [--json]           # then --decimal / --dates where AMBIGUOUS
python3 DS/clean.py FILE --out work/clean.csv [--unify "Col"] [--drop-duplicates] [--text "Col"] [--row-numbers] [--snake]
python3 DOC query work/clean.csv "SELECT ... FROM t ..." [--out result.csv]
python3 DS/chart.py bar|barh|line|scatter|pie FILE --x COL --y COL[,COL] [--group COL] [--period month] [--agg sum]
        [--title T] [--ylabel T] [--locale id-ID] [--currency IDR] [--unit %] [--top 15] [--highlight X] [--out PNG] [--data-out CSV]
python3 DS/chart.py CONFIG.json
python3 DS/dashboard_example.py work/clean.csv --date COL --category COL --value COL [--locale] [--currency] [--theme dark] --out PNG
python3 DS/xlsx_write.py OUT.xlsx "Sheet=file.csv" ... [--chart "Sheet:bar:X:Y"] [--image "Chart=chart.png"] [--date-format dmy]
```
