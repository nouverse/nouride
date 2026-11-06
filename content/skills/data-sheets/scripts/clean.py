#!/usr/bin/env python3
"""
clean.py - a clean copy of a table, ready to compute on: plain numbers, ISO dates, no stray spaces. The original is
never written. Prints what changed and a reconciliation, so a total can be traced from the source to the copy.

    python3 clean.py FILE --out CLEAN.csv [--sheet NAME|N] [--header N] [--decimal auto|comma|dot]
                         [--dates auto|dayfirst|monthfirst] [--drop-duplicates] [--keep-totals]
                         [--unify "Col A,Col B"] [--text "Col C"] [--row-numbers] [--snake]

What it does, column by column (the kind is decided as profile.py decides it - run that first):
  numbers   "Rp 1.234.567,50", "1,234.5", "(500)", "12%" -> 1234567.5, 1234.5, -500, 12   (percent stays 12, not 0.12)
  dates     "12/03/2026", "12 Maret 2026", "2026-03-12 08:00" -> 2026-03-12, 2026-03-12 08:00:00
  codes     leading zeros kept (NIK, postal codes, phone numbers stay text)
  text      spaces trimmed and collapsed; with --unify, one value written several ways ("jakarta ", "JAKARTA")
            becomes its most common spelling
  empty     "-", "N/A", "#N/A", "null", "nan" ... -> empty
  rows      Total/Jumlah rows inside the data are dropped (--keep-totals keeps them); whole-row duplicates are
            reported, and dropped only with --drop-duplicates
A value that does not fit its column (text in a number column) is emptied and listed with its row - never guessed.
--text keeps a column exactly as text (an ID that happens to look like a number). --row-numbers adds a first column
`source_row` with the row number in the original, so any value can be looked up there.

Next to CLEAN.csv it writes CLEAN.changes.csv: every row dropped and every value emptied or rewritten (other than
plain number and date formatting), with the row, the column, before and after.

Exit: 0 written; 1 bad arguments; 2 the file cannot be read; 3 a library is missing.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import Stop, columns, refuse_ambiguous, find_column, fmt_num, is_null, is_total_row, read_table, run_main  # noqa: E402


def plain(x: float) -> str:
    if float(x).is_integer() and abs(x) < 1e15:
        return str(int(x))
    return repr(round(x, 10)).rstrip("0").rstrip(".") if "e" not in repr(x) else f"{x:.10f}".rstrip("0").rstrip(".")


def snake(h: str) -> str:
    return re.sub(r"[^0-9a-z]+", "_", h.lower()).strip("_") or "column"


def main(argv) -> int:
    ap = argparse.ArgumentParser(prog="clean.py", description=__doc__.split("\n\n")[0].strip(),
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    ap.add_argument("file")
    ap.add_argument("--out", required=True, help="the clean CSV to write (never the original)")
    ap.add_argument("--sheet")
    ap.add_argument("--header", type=int)
    ap.add_argument("--decimal", choices=["auto", "comma", "dot"], default="auto")
    ap.add_argument("--dates", choices=["auto", "dayfirst", "monthfirst"], default="auto")
    ap.add_argument("--drop-duplicates", action="store_true", help="drop rows identical to an earlier row")
    ap.add_argument("--keep-totals", action="store_true", help="keep rows that look like Total/Jumlah")
    ap.add_argument("--unify", help="text columns where one value written several ways becomes its commonest spelling")
    ap.add_argument("--text", help="columns kept exactly as text, whatever they look like")
    ap.add_argument("--row-numbers", action="store_true", help="add source_row, the row number in the original")
    ap.add_argument("--snake", action="store_true", help="headers as snake_case (jumlah_bayar)")
    a = ap.parse_args(argv)

    if os.path.abspath(a.out) == os.path.abspath(a.file):
        raise Stop(1, "--out is the original file. Write the clean copy to a new name; the original stays as it is")
    t = read_table(a.file, a.sheet, a.header)
    cols = columns(t, a.decimal, a.dates)
    as_text = {find_column(t, c.strip()) for c in a.text.split(",")} if a.text else set()
    unify = {find_column(t, c.strip()) for c in a.unify.split(",")} if a.unify else set()
    refuse_ambiguous(cols, [j for j in range(len(cols)) if j not in as_text], a.decimal, a.dates)

    # The commonest spelling of each value, for --unify.
    canon: dict[int, dict[str, str]] = {}
    for j in unify:
        groups: dict[str, Counter] = {}
        for v in cols[j].filled:
            s = " ".join(str(v).split())
            groups.setdefault(s.lower(), Counter())[s] += 1
        canon[j] = {k: g.most_common(1)[0][0] for k, g in groups.items()}

    changes: list[list] = []
    out_rows: list[list] = []
    seen: set = set()
    dropped_tot, dropped_dup, dup_rows = [], [], []
    emptied: Counter = Counter()
    bad: dict[str, list] = {}
    src_sums = [0.0] * len(cols)
    out_sums = [0.0] * len(cols)
    numeric = [c.kind in ("integer", "decimal") and j not in as_text for j, c in enumerate(cols)]
    dated = [c.kind == "date" and j not in as_text for j, c in enumerate(cols)]

    for r, n in zip(t.rows, t.rownums):
        if is_total_row(r) and not a.keep_totals:
            dropped_tot.append(n)
            changes.append([n, "(row)", " | ".join(str(c) for c in r if str(c).strip())[:120], "dropped: a Total row"])
            continue
        key = tuple(" ".join(str(c).split()) for c in r)
        if key in seen:
            dup_rows.append(n)
            if a.drop_duplicates:
                dropped_dup.append(n)
                changes.append([n, "(row)", " | ".join(key)[:120], "dropped: duplicate of an earlier row"])
                for j, c in enumerate(cols):
                    if numeric[j] and c.number(r[j]) is not None:
                        src_sums[j] += c.number(r[j])
                continue
        seen.add(key)
        new = []
        for j, (v, c) in enumerate(zip(r, cols)):
            raw = v if not isinstance(v, str) else v
            if j in as_text:
                new.append(" ".join(str(v).split()) if v != "" else "")
                continue
            if is_null(v):
                if str(v).strip():
                    emptied[c.name] += 1
                    changes.append([n, c.name, v, "emptied: a placeholder for no value"])
                new.append("")
                continue
            if numeric[j]:
                x = c.number(v)
                if x is None:
                    bad.setdefault(c.name, []).append((n, v))
                    changes.append([n, c.name, v, "emptied: not a number"])
                    new.append("")
                else:
                    src_sums[j] += x
                    out_sums[j] += x
                    new.append(plain(x))
                continue
            if dated[j]:
                d = c.date(v)
                if d is None:
                    bad.setdefault(c.name, []).append((n, v))
                    changes.append([n, c.name, v, "emptied: not a date"])
                    new.append("")
                else:
                    new.append(d.date().isoformat() if (d.hour, d.minute, d.second) == (0, 0, 0) else d.isoformat(sep=" "))
                continue
            s = " ".join(str(raw).split()) if isinstance(raw, str) else plain(raw) if isinstance(raw, float) else str(raw)
            if j in canon:
                u = canon[j].get(s.lower(), s)
                if u != s:
                    changes.append([n, c.name, v, f"unified: {u}"])
                s = u
            elif isinstance(raw, str) and s != raw:
                changes.append([n, c.name, raw, f"spaces: {s}"])
            new.append(s)
        out_rows.append(([n] if a.row_numbers else []) + new)

    headers = [snake(h) for h in t.headers] if a.snake else list(t.headers)
    if a.row_numbers:
        headers = ["source_row"] + headers
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(headers)
        w.writerows(out_rows)
    log = re.sub(r"(\.csv)?$", ".changes.csv", a.out, count=1)
    with open(log, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["source_row", "column", "before", "after"])
        w.writerows(changes)

    print(f"wrote {a.out}: {len(out_rows)} rows x {len(headers)} columns (from {len(t.rows)} data rows in {a.file}; "
          + "; ".join(t.notes) + ")")
    print(f"changes listed in {log} ({len(changes)} line(s))")
    if dropped_tot:
        print(f"dropped {len(dropped_tot)} Total row(s): rows {', '.join(map(str, dropped_tot[:10]))}")
    if dup_rows:
        if a.drop_duplicates:
            print(f"dropped {len(dropped_dup)} duplicate row(s): rows {', '.join(map(str, dropped_dup[:10]))}")
        else:
            print(f"kept {len(dup_rows)} row(s) identical to an earlier one (rows {', '.join(map(str, dup_rows[:10]))}) - "
                  "--drop-duplicates if they are double entries")
    for name, items in bad.items():
        print(f"EMPTIED {len(items)} value(s) in \"{name}\" that are not {('dates' if any(c.name == name and c.kind == 'date' for c in cols) else 'numbers')}: "
              + ", ".join(f'row {n} "{str(v)[:25]}"' for n, v in items[:8]) + " - check them in the original")
    for name, k in emptied.items():
        print(f"emptied {k} placeholder(s) like \"-\" or \"N/A\" in \"{name}\"")
    print("columns: " + ", ".join(
        f"{h} ({'text, kept' if j in as_text else c.kind})" for j, (h, c) in enumerate(zip(t.headers, cols))))
    for j, c in enumerate(cols):
        if numeric[j]:
            line = f"reconcile \"{c.name}\": source rows {fmt_num(src_sums[j])} -> clean {fmt_num(out_sums[j])}"
            diff = src_sums[j] - out_sums[j]
            if abs(diff) > 1e-9:
                line += f" (the difference {fmt_num(diff)} is the dropped duplicate rows)"
            print(line + (f"; Total rows dropped: {len(dropped_tot)}" if dropped_tot else ""))
    for c in cols:
        for note in c.notes:
            print(f"note \"{c.name}\": {note}")
    return 0


if __name__ == "__main__":
    run_main(main)
