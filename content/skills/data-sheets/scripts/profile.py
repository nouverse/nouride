#!/usr/bin/env python3
"""
profile.py - what is in a table, column by column, and what in it is suspicious - before any number is computed.

    python3 profile.py FILE [--sheet NAME|N] [--header N] [--decimal auto|comma|dot] [--dates auto|dayfirst|monthfirst]
                            [--columns "Col A,Col B"] [--json] [--limit ROWS]

FILE is a CSV/TSV, a JSON list of records (or JSON lines), or an .xlsx/.xlsm sheet (openpyxl when installed,
otherwise through the document-reading skill's doc.py).

For the table: rows, columns, the header row it used, duplicate rows, rows that look like totals (a "Total" or
"Jumlah" row inside the data is counted twice by any sum), columns that could be a key.
For each column: its kind (integer, decimal, date, code, boolean, text, mixed), how numbers are written (1.234,56 or
1,234.56) and dates (dd/mm or mm/dd), empty cells and the placeholders used for empty ("-", "N/A"), distinct values,
min / max / sum / mean / median for numbers, the earliest and latest date, the most common values, outliers (outside
3 x IQR) with their rows, values that do not fit the column's kind, and spaces or capitals that split one value in two
("Jakarta" and "jakarta ").

Row numbers are the source's own: the sheet row in Excel, the line in a CSV - the person can look them up.

Exit: 0 done; 1 bad arguments; 2 the file cannot be read; 3 a library is missing.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import (Stop, columns, find_column, fmt_num, is_null, is_total_row, read_table,  # noqa: E402
                      run_main)

SHOW = 6


def profile(path, a) -> dict:
    t = read_table(path, a.sheet, a.header, a.limit)
    cols = columns(t, a.decimal, a.dates)
    wanted = range(len(cols)) if not a.columns else [find_column(t, c.strip()) for c in a.columns.split(",")]
    out = {"file": path, "rows": len(t.rows), "columns": len(t.headers), "read": t.notes, "table": [], "cols": []}

    # Duplicate rows - the whole row the same.
    seen: dict[tuple, int] = {}
    dups = []
    for r, n in zip(t.rows, t.rownums):
        key = tuple(str(c).strip() for c in r)
        if key in seen:
            dups.append((n, seen[key]))
        else:
            seen[key] = n
    if dups:
        out["table"].append(f"{len(dups)} duplicate row(s) - the same in every column: "
                            + ", ".join(f"row {n} = row {m}" for n, m in dups[:SHOW]) + (" ..." if len(dups) > SHOW else ""))
    totals = [n for r, n in zip(t.rows, t.rownums) if is_total_row(r)]
    if totals:
        out["table"].append(f"{len(totals)} row(s) look like totals or subtotals (rows {', '.join(map(str, totals[:SHOW]))}) - "
                            "leave them out of any sum, or the total is counted twice")
    headers = Counter(h.lower() for h in t.headers)
    for h, c in headers.items():
        if c > 1:
            out["table"].append(f"header \"{h}\" appears {c} times - say which one you mean by its column number")
    for c in cols:
        if c.ambiguous:
            out["table"].append(f"\"{c.name}\": numbers like 1.250 read two ways (thousands or decimals) - see its note")
        if c.dates_ambiguous and c.kind == "date":
            out["table"].append(f"\"{c.name}\": dates like 03/04 read two ways (day or month first) - see its note")
    blank = [h for h in t.headers if h.startswith("column_")]
    if blank:
        out["table"].append(f"{len(blank)} column(s) with no header, named {', '.join(blank[:SHOW])}")
    idlike = re.compile(r"(^|[\s_])(id|no|nomor|kode|code|key|nik|nip|sku)([\s_.]|$)", re.I)
    keys = [c.name for c in cols if (c.kind in ("code", "text") or (c.kind == "integer" and idlike.search(c.name))) and len(c.filled) == len(t.rows) > 1
            and len(set(str(v).strip() for v in c.filled)) == len(t.rows)]
    if keys:
        out["table"].append("could be a key (every row filled and different): " + ", ".join(f'"{k}"' for k in keys[:SHOW]))

    for j in wanted:
        out["cols"].append(profile_column(j, cols[j], t.rownums, set(totals)))
    return out


def profile_column(j: int, c, rownums: list[int], totals: set) -> dict:
    vals = c.values
    d: dict = {"n": j + 1, "name": c.name, "kind": c.kind, "notes": list(c.notes)}
    empties = Counter(str(v).strip() for v in vals if is_null(v))
    d["filled"] = len(c.filled)
    d["empty"] = sum(empties.values())
    if d["empty"]:
        shown = [f'"{k}" x{v}' if k else f"blank x{v}" for k, v in empties.most_common(4)]
        d["empty_as"] = ", ".join(shown)
    d["distinct"] = len(set(str(v).strip() for v in c.filled))

    if c.kind in ("integer", "decimal", "mixed"):
        if c.kind != "mixed" and getattr(c, "separators", False):
            d["written"] = "1.234,56 (comma decimal)" if c.decimal == "comma" else "1,234.56 (dot decimal)"
        pairs = [(c.number(v), n, v) for v, n in zip(vals, rownums)]
        nums = [(x, n) for x, n, _ in pairs if x is not None and n not in totals]
        bad = [(n, v) for x, n, v in pairs if x is None and not is_null(v) and n not in totals]
        stated = [(x, n) for x, n, _ in pairs if x is not None and n in totals]
        if stated and nums:
            rows_sum = sum(x for x, _ in nums)
            for x, n in stated:
                same = abs(x - rows_sum) <= max(0.005 * abs(rows_sum), 0.01)
                d.setdefault("total_rows", []).append(
                    f"row {n} says {fmt_num(x)}; the other rows add up to {fmt_num(rows_sum)} - "
                    + ("they match" if same else f"they DIFFER by {fmt_num(x - rows_sum)}"))
        if nums:
            xs = sorted(x for x, _ in nums)
            d["min"], d["max"], d["sum"] = xs[0], xs[-1], sum(xs)
            d["mean"] = sum(xs) / len(xs)
            d["median"] = statistics.median(xs)
            if xs[0] < 0:
                d["negatives"] = sum(1 for x in xs if x < 0)
            if len(xs) >= 8:
                q1, _, q3 = statistics.quantiles(xs, n=4)
                iqr = q3 - q1
                lo, hi = q1 - 3 * iqr, q3 + 3 * iqr
                outs = [(x, n) for x, n in nums if x < lo or x > hi] if iqr > 0 else []
                if outs:
                    outs.sort(key=lambda p: -abs(p[0] - d["median"]))
                    d["outliers"] = f"{len(outs)} outside 3xIQR [{fmt_num(lo)} .. {fmt_num(hi)}]: " + ", ".join(
                        f"row {n} ({fmt_num(x)})" for x, n in outs[:SHOW])
            units = Counter()
            for v in c.filled:
                if isinstance(v, str):
                    from sheetlib import strip_number
                    _, info = strip_number(v)
                    for k in ("currency", "suffix"):
                        if k in info:
                            units[f"{k} {info[k]}"] += 1
                    if info.get("percent"):
                        units["percent"] += 1
            if units:
                d["units"] = ", ".join(f"{k} x{v}" for k, v in units.most_common(5))
                if len([k for k in units if k.startswith("suffix")]) or len([k for k in units if k.startswith("currency")]) > 1:
                    d["notes"].append("units or currencies differ inside the column - convert before adding them up")
        if bad:
            d["not_numbers"] = f"{len(bad)}: " + ", ".join(f'row {n} "{str(v)[:30]}"' for n, v in bad[:SHOW])
    elif c.kind == "date":
        ds = [(c.date(v), n, v) for v, n in zip(vals, rownums)]
        good = sorted(x for x, _, _ in ds if x is not None)
        bad = [(n, v) for x, n, v in ds if x is None and not is_null(v)]
        if good:
            d["earliest"], d["latest"] = good[0].isoformat(sep=" "), good[-1].isoformat(sep=" ")
            if all(x.hour == 0 and x.minute == 0 for x in good):
                d["earliest"], d["latest"] = good[0].date().isoformat(), good[-1].date().isoformat()
        if any(isinstance(v, str) for v in c.filled):
            d["written"] = "day first (dd/mm/yyyy)" if c.dayfirst else "month first (mm/dd/yyyy)"
        if bad:
            d["not_dates"] = f"{len(bad)}: " + ", ".join(f'row {n} "{str(v)[:30]}"' for n, v in bad[:SHOW])
    elif c.kind == "code":
        d["notes"].append("leading zeros or a + sign: keep as text (a number would drop the zeros)")
        lens = Counter(len(str(v).strip()) for v in c.filled)
        if len(lens) > 1:
            d["lengths"] = ", ".join(f"{k} chars x{v}" for k, v in sorted(lens.items()))

    if c.kind in ("text", "code", "boolean", "mixed") or d["distinct"] <= 12:
        counts = Counter(str(v).strip() for v in c.filled)
        d["top"] = ", ".join(f'"{k[:30]}" x{v}' for k, v in counts.most_common(SHOW))
        # One value written several ways.
        groups: dict[str, set] = {}
        for v in c.filled:
            s = str(v)
            groups.setdefault(" ".join(s.split()).lower(), set()).add(s)
        split = [sorted(g) for g in groups.values() if len(g) > 1]
        if split:
            d["variants"] = f"{len(split)} value(s) written several ways: " + "; ".join(
                " / ".join(f'"{x}"' for x in g[:3]) for g in split[:4])
    if c.kind in ("text", "code", "integer") and len(c.filled) > 10 and len(c.filled) - 5 <= d["distinct"] < len(c.filled):
        counts = Counter(str(v).strip() for v in c.filled)
        again = [k for k, v in counts.items() if v > 1]
        d["repeats"] = (f"almost every value is different, but {len(again)} repeat(s): "
                        + ", ".join(f'"{k}"' for k in again[:SHOW]) + " - an ID column with duplicates is usually a double entry")
    spaced = sum(1 for v in c.filled if isinstance(v, str) and v != v.strip())
    if spaced:
        d["spaces"] = f"{spaced} value(s) with spaces at the start or end"
    return d


def show(p: dict) -> None:
    print(f"# {p['file']}")
    print(f"{p['rows']} data rows x {p['columns']} columns; " + "; ".join(p["read"]))
    print("(figures in this report are written 1,234.5 whatever the file uses; row numbers are the file's own)")
    for line in p["table"]:
        print(f"! {line}")
    for d in p["cols"]:
        print()
        head = f"## {d['n']}. \"{d['name']}\" - {d['kind']}"
        if d.get("written"):
            head += f", written {d['written']}"
        print(head)
        for line in d.get("total_rows", []):
            print(f"  total row: {line}")
        print(f"  filled {d['filled']}, empty {d['empty']}" + (f" ({d['empty_as']})" if d.get("empty_as") else "")
              + f", distinct {d['distinct']}")
        if "min" in d and any(n.startswith("AMBIGUOUS:") for n in d["notes"]):
            print("  (unconfirmed: the figures below follow one reading of the ambiguous numbers - see the note)")
        if "min" in d:
            print(("  (total rows left out) " if d.get("total_rows") else "  ") + f"min {fmt_num(d['min'])}  max {fmt_num(d['max'])}  sum {fmt_num(d['sum'])}  "
                  f"mean {fmt_num(d['mean'])}  median {fmt_num(d['median'])}" + (f"  negatives {d['negatives']}" if d.get("negatives") else ""))
        if "earliest" in d:
            print(f"  from {d['earliest']} to {d['latest']}")
        for key, label in (("units", "units"), ("outliers", "outliers"), ("not_numbers", "NOT numbers"),
                           ("not_dates", "NOT dates"), ("lengths", "lengths"), ("top", "most common"),
                           ("variants", "SPLIT"), ("repeats", "REPEATS"), ("spaces", "spaces")):
            if d.get(key):
                print(f"  {label}: {d[key]}")
        for n in d["notes"]:
            print(f"  note: {n}")


def main(argv) -> int:
    ap = argparse.ArgumentParser(prog="profile.py", description=__doc__.split("\n\n")[0].strip(),
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    ap.add_argument("file")
    ap.add_argument("--sheet", help="sheet name or number (default: the first)")
    ap.add_argument("--header", type=int, help="the row number of the header (default: found)")
    ap.add_argument("--decimal", choices=["auto", "comma", "dot"], default="auto",
                    help="comma: 1.234,56 (Indonesian); dot: 1,234.56; auto decides per column")
    ap.add_argument("--dates", choices=["auto", "dayfirst", "monthfirst"], default="auto")
    ap.add_argument("--columns", help="only these columns, by header or number, comma-separated")
    ap.add_argument("--limit", type=int, help="read only the first N rows (a quick look at a huge file)")
    ap.add_argument("--json", action="store_true", help="the same, as JSON")
    a = ap.parse_args(argv)
    p = profile(a.file, a)
    if a.json:
        print(json.dumps(p, ensure_ascii=False, indent=1, default=str))
    else:
        show(p)
    return 0


if __name__ == "__main__":
    run_main(main)
