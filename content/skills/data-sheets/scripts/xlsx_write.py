#!/usr/bin/env python3
"""
xlsx_write.py - a NEW Excel workbook from one or more tables, set up the way a person expects to open it: numbers as
numbers with thousands separators, dates as dates, codes with their leading zeros, a bold frozen header with filters,
columns wide enough to read. Optionally an Excel chart beside the data, or a PNG (from chart.py) on a sheet of its own.
Reopens what it wrote and checks every sheet's row count and column totals against its source.

    python3 xlsx_write.py OUT.xlsx "Sheet name=table.csv" ["Other=other.csv" ...]
                          [--chart "Sheet name:bar|line|barh:Category column:Value column[,Value column 2]"]
                          [--image "Sheet name=chart.png"] [--date-format iso|dmy|mdy] [--decimal comma|dot]
                          [--dates-in dayfirst|monthfirst] [--force]

Each table is read as profile.py reads it (CSV/TSV/JSON/XLSX; best is a CSV from clean.py). A sheet name is at most
31 characters, without : \\ / ? * [ ]. To CHANGE an existing workbook use the document-authoring skill's xlsx_edit.py,
not this - this only writes new files and refuses to overwrite one without --force.

Number formats are Excel's own (#,##0 and #,##0.00): Excel shows them with the separators of the computer that opens
the file, so an Indonesian Windows shows 1.234,56 and an English one 1,234.56 - the stored number is the same.
--date-format: how dates are shown - iso yyyy-mm-dd (default, read the same everywhere), dmy dd/mm/yyyy, mdy mm/dd/yyyy.
Money: Excel's currency formats are tied to the opening computer's locale, so amounts are written as plain numbers -
put the currency in the header ("Total (IDR)", "Amount (EUR)").

Exit: 0 written and checked; 1 bad arguments; 2 a table cannot be read; 3 openpyxl (or Pillow for --image) missing;
5 the check after writing found a difference (the file is kept, the difference printed).
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sheetlib import Stop, columns, refuse_ambiguous, find_column, fmt_num, is_null, read_table, run_main  # noqa: E402

BAD_SHEET = re.compile(r"[:\\/?*\[\]]")


def parse_pair(s: str, what: str) -> tuple[str, str]:
    if "=" not in s:
        raise Stop(1, f"{what} {s!r}: write it as \"Sheet name=path\"")
    name, path = s.split("=", 1)
    name = name.strip()
    if not name or len(name) > 31 or BAD_SHEET.search(name):
        raise Stop(1, f"sheet name {name!r}: 1-31 characters, none of : \\ / ? * [ ]")
    return name, path.strip()


def main(argv) -> int:
    ap = argparse.ArgumentParser(prog="xlsx_write.py", description=__doc__.split("\n\n")[0].strip(),
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
    ap.add_argument("out")
    ap.add_argument("tables", nargs="+", help='"Sheet name=path.csv", one per sheet, in order')
    ap.add_argument("--chart", action="append", default=[], help='"Sheet:bar:Category column:Value column[,more]"')
    ap.add_argument("--image", action="append", default=[], help='"Sheet name=chart.png" - a new sheet holding the picture')
    ap.add_argument("--date-format", choices=["iso", "dmy", "mdy"], default="iso")
    ap.add_argument("--decimal", choices=["auto", "comma", "dot"], default="auto",
                    help="how the source writes numbers, when it is ambiguous: comma 1.234,56 / dot 1,234.56")
    ap.add_argument("--dates-in", choices=["auto", "dayfirst", "monthfirst"], default="auto",
                    help="how the source writes dates, when every one could be either")
    ap.add_argument("--force", action="store_true", help="overwrite OUT if it exists")
    a = ap.parse_args(argv)

    if not a.out.lower().endswith(".xlsx"):
        raise Stop(1, "OUT must end in .xlsx")
    pairs = [parse_pair(s, "table") for s in a.tables]
    images = [parse_pair(s, "--image") for s in a.image]
    names = [n for n, _ in pairs] + [n for n, _ in images]
    if len({n.lower() for n in names}) != len(names):
        raise Stop(1, "two sheets with the same name (Excel ignores case)")
    for _, p in pairs + images:
        if os.path.abspath(p) == os.path.abspath(a.out):
            raise Stop(1, f"{p} is both a source and the output")
    if os.path.exists(a.out) and not a.force:
        raise Stop(1, f"{a.out} exists. This writes new workbooks only: choose another name, or --force to replace it. "
                      "To change a workbook, use the document-authoring skill's xlsx_edit.py")
    try:
        import openpyxl
        from openpyxl.chart import BarChart, LineChart, Reference
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise Stop(3, "this needs openpyxl in the Python that runs it: `pip install openpyxl` "
                      "(on a Nouride host plain `pip install` goes into your Python env)") from None

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    expected: dict[str, tuple[int, dict[int, float]]] = {}
    layouts: dict[str, tuple] = {}
    date_fmt = {"iso": "yyyy-mm-dd", "dmy": "dd/mm/yyyy", "mdy": "mm/dd/yyyy"}[a.date_format]

    for name, path in pairs:
        t = read_table(path)
        cols = columns(t, a.decimal, a.dates_in)
        refuse_ambiguous(cols, list(range(len(cols))), a.decimal, a.dates_in)
        ws = wb.create_sheet(name)
        ws.append(t.headers)
        sums: dict[int, float] = {}
        widths = [len(str(h)) for h in t.headers]
        for r in t.rows:
            out = []
            for j, (v, c) in enumerate(zip(r, cols)):
                if is_null(v):
                    out.append(None)
                    continue
                if c.kind in ("integer", "decimal"):
                    x = c.number(v)
                    if x is not None:
                        out.append(int(x) if c.kind == "integer" and float(x).is_integer() else x)
                        sums[j] = sums.get(j, 0.0) + x
                        widths[j] = max(widths[j], len(fmt_num(x)))
                        continue
                if c.kind == "date":
                    d = c.date(v)
                    if d is not None:
                        out.append(d if (d.hour, d.minute, d.second) != (0, 0, 0) else d.date())
                        widths[j] = max(widths[j], 10)
                        continue
                s = str(v).strip() if isinstance(v, str) else v
                out.append(s)
                widths[j] = max(widths[j], min(50, len(str(s))))
            ws.append(out)
        # Formats per column, header styling, freeze, filter, widths.
        head_fill = PatternFill("solid", fgColor="DCE6F2")
        for j, c in enumerate(cols):
            letter = get_column_letter(j + 1)
            cell = ws.cell(row=1, column=j + 1)
            cell.font = Font(bold=True)
            cell.fill = head_fill
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            fmt = {"integer": "#,##0", "decimal": "#,##0.00", "date": date_fmt, "code": "@"}.get(c.kind)
            if fmt:
                for row in ws.iter_rows(min_row=2, min_col=j + 1, max_col=j + 1):
                    for cl in row:
                        if c.kind == "date" and isinstance(cl.value, dt.datetime):
                            cl.number_format = date_fmt + " hh:mm"
                        elif cl.value is not None:
                            cl.number_format = fmt
            ws.column_dimensions[letter].width = min(52, max(8, widths[j] + 2))
        ws.freeze_panes = "A2"
        if t.rows:
            ws.auto_filter.ref = f"A1:{get_column_letter(len(t.headers))}{len(t.rows) + 1}"
        expected[name] = (len(t.rows), sums)
        layouts[name] = (t, cols)
        print(f"sheet \"{name}\": {len(t.rows)} rows x {len(t.headers)} columns from {path} - "
              + ", ".join(f"{h} ({c.kind})" for h, c in zip(t.headers, cols)))

    for spec in a.chart:
        parts = spec.split(":")
        if len(parts) != 4:
            raise Stop(1, f"--chart {spec!r}: write it as \"Sheet:bar:Category column:Value column[,more]\"")
        sname, kind, xcol, ycols = parts
        if sname not in layouts:
            raise Stop(1, f"--chart: no sheet {sname!r} among {', '.join(layouts)}")
        if kind not in ("bar", "barh", "line"):
            raise Stop(1, f"--chart kind {kind!r}: bar, barh or line")
        t, _ = layouts[sname]
        xi = find_column(t, xcol)
        yis = [find_column(t, y.strip()) for y in ycols.split(",")]
        n = len(t.rows)
        ws = wb[sname]
        ch = LineChart() if kind == "line" else BarChart()
        if kind == "barh":
            ch.type = "bar"
        elif kind == "bar":
            ch.type = "col"
        ch.title = t.headers[yis[0]] if len(yis) == 1 else sname
        ch.y_axis.title = t.headers[yis[0]] if len(yis) == 1 else ""
        ch.x_axis.title = t.headers[xi]
        ch.height, ch.width = 9, 18
        for yi in yis:
            ch.add_data(Reference(ws, min_col=yi + 1, min_row=1, max_row=n + 1), titles_from_data=True)
        ch.set_categories(Reference(ws, min_col=xi + 1, min_row=2, max_row=n + 1))
        if len(yis) == 1:
            ch.legend = None
        anchor = f"{get_column_letter(len(t.headers) + 2)}2"
        ws.add_chart(ch, anchor)
        print(f"chart on \"{sname}\" at {anchor}: {kind} of {', '.join(t.headers[y] for y in yis)} by {t.headers[xi]} "
              f"({n} rows - sort the table first if the bars should be in order)")

    for name, png in images:
        try:
            from openpyxl.drawing.image import Image
            img = Image(png)
        except ImportError:
            raise Stop(3, "a picture needs Pillow: `pip install pillow`") from None
        except (OSError, ValueError) as e:
            raise Stop(2, f"--image {png}: {e}") from None
        ws = wb.create_sheet(name)
        scale = min(1.0, 960 / max(1, img.width))
        img.width, img.height = int(img.width * scale), int(img.height * scale)
        ws.add_image(img, "B2")
        print(f"sheet \"{name}\": the picture {png} ({img.width}x{img.height} px)")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    wb.save(a.out)

    # Read it back as a stranger would, and compare.
    back = openpyxl.load_workbook(a.out, read_only=True, data_only=True)
    problems = []
    for name, (rows, sums) in expected.items():
        ws = back[name]
        got_rows = 0
        got: dict[int, float] = {}
        for i, r in enumerate(ws.iter_rows(values_only=True)):
            if i == 0:
                continue
            got_rows += 1
            for j in sums:
                v = r[j] if j < len(r) else None
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    got[j] = got.get(j, 0.0) + v
        if got_rows != rows:
            problems.append(f"\"{name}\": {got_rows} rows in the workbook, {rows} in the source")
        t, _ = layouts[name]
        for j, s in sums.items():
            g = got.get(j, 0.0)
            ok = abs(g - s) <= 1e-6 * max(1.0, abs(s))
            line = f"check \"{name}\" / {t.headers[j]}: source {fmt_num(s)}, workbook {fmt_num(g)}" + ("" if ok else "  DIFFERENT")
            print(line)
            if not ok:
                problems.append(line)
    back.close()
    print(f"wrote {a.out} ({os.path.getsize(a.out) // 1024 + 1} KB)")
    if problems:
        for p in problems:
            print(f"PROBLEM {p}")
        return 5
    print("checked: every sheet has the source's rows, and every number column the source's total")
    return 0


if __name__ == "__main__":
    run_main(main)
