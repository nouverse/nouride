#!/usr/bin/env python3
"""An example dashboard - number tiles and four charts on one picture - for what chart.py does not draw.

chart.py draws one chart per picture, plainly, on purpose. A dashboard, a layout of your own or a look the person
asked for is a script you write - start from this one instead of from nothing. As it is, it reads one clean CSV
(SKILL.md step 2: plain numbers, ISO dates) with a date, a category and a value column, and draws:

  four tiles   the total, the number of rows, the average per row, the last month against the one before
  four charts  the total by category, the total by month, the share of the largest categories, the running total

  python3 dashboard_example.py work/clean.csv --date Date --category City --value Total \\
      --locale id-ID --currency IDR --out work/dashboard.png

To change it, copy it next to your work (cp DS/dashboard_example.py work/dashboard.py), run the copy with --ds DS (the
data-sheets scripts folder, where numfmt.py is), and edit the parts marked QUERIES, PANELS and LOOK - the words on
it (titles, tile names) are English, so write them in the reader's language in your copy. Keep what the
rest does: every number comes from a query over the file, never typed in; money and numbers are written by numfmt.py
in the reader's locale; every number drawn is printed, and the totals are checked against each other; bars start at
zero; one colour per series.

Needs matplotlib (pip install matplotlib). Exit: 0 written; 1 wrong arguments; 2 the file cannot be read or is not
clean; 3 matplotlib is missing (the numbers are printed first); 5 the totals do not reconcile.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
import sys

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")

# ---- QUERIES: one per panel. The table is t(month TEXT 'YYYY-MM' or NULL, cat TEXT, v REAL, src INTEGER = file row).
QUERIES = {
    "total": "SELECT COALESCE(SUM(v), 0), COUNT(*) FROM t",
    "by_category": "SELECT cat, SUM(v) FROM t GROUP BY cat ORDER BY SUM(v) DESC, cat",
    "by_month": "SELECT month, SUM(v) FROM t WHERE month IS NOT NULL GROUP BY month ORDER BY month",
    "running": "SELECT month, SUM(SUM(v)) OVER (ORDER BY month) FROM t WHERE month IS NOT NULL GROUP BY month ORDER BY month",
    "undated": "SELECT COUNT(*), COALESCE(SUM(v), 0) FROM t WHERE month IS NULL",
}

# ---- LOOK: two themes and a colour-blind-safe set for the parts of a whole (Okabe-Ito).
THEMES = {
    "light": {"bg": "#FFFFFF", "panel": "#F6F8FA", "fg": "#1F2328", "muted": "#59636E", "grid": "#D1D9E0",
              "accent": "#0969DA", "other": "#AFB8C1"},
    "dark": {"bg": "#0D1117", "panel": "#161B22", "fg": "#E6EDF3", "muted": "#9198A1", "grid": "#30363D",
             "accent": "#4493F8", "other": "#59636E"},
}
PARTS = ["#0072B2", "#E69F00", "#009E73", "#CC79A7", "#56B4E9"]
SIZE_IN, DPI = (8.0, 7.0), 200          # 1600 x 1400 px: sharp on a phone, small to send


def stop(code: int, message: str) -> None:
    print(f"dashboard: {message}", file=sys.stderr)
    sys.exit(code)


def helpers(ds: str | None):
    """numfmt.py (the reader's way of writing numbers) and chart.py's word for "Others", from the scripts folder."""
    for folder in (ds, os.path.dirname(os.path.abspath(__file__))):
        if folder and os.path.exists(os.path.join(folder, "numfmt.py")):
            sys.path.insert(0, folder)
            from numfmt import Formatter  # noqa: E402
            from chart import OTHERS  # noqa: E402 - chart.py loads matplotlib only when it draws
            return Formatter, OTHERS
    stop(1, "numfmt.py is not beside this script: pass --ds <the data-sheets scripts folder> (where you copied it from)")


def load(path: str, date_col: str, cat_col: str, val_col: str) -> tuple[sqlite3.Connection, list[str]]:
    """The clean CSV into SQLite. A value that is not a plain number stops it: that file was not cleaned."""
    try:
        with open(path, newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            header = reader.fieldnames or []
            rows = list(reader)
    except OSError as err:
        stop(2, f"cannot read {path}: {err.strerror}")
    missing = [c for c in (date_col, cat_col, val_col) if c not in header]
    if missing:
        stop(1, f"no column {', '.join(repr(c) for c in missing)} in {path}; it has: {', '.join(header)}")
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE t (month TEXT, cat TEXT, v REAL, src INTEGER)")
    notes, blank, not_numbers, not_dates = [], [], [], []
    for n, row in enumerate(rows, start=2):  # row 1 is the header, as in a spreadsheet
        raw = (row.get(val_col) or "").strip()
        if not raw:
            blank.append(n)
            continue
        try:
            value = float(raw)
        except ValueError:
            not_numbers.append(f"row {n} {raw!r}")
            continue
        when = (row.get(date_col) or "").strip()
        if when and not ISO_DATE.match(when):
            not_dates.append(f"row {n} {when!r}")
            continue
        db.execute("INSERT INTO t VALUES (?, ?, ?, ?)", (when[:7] or None, (row.get(cat_col) or "").strip() or "(blank)", value, n))
    if not_numbers or not_dates:
        bad = ([f"{len(not_numbers)} value(s) in {val_col!r} are not plain numbers: {', '.join(not_numbers[:3])}"] if not_numbers else []) + \
              ([f"{len(not_dates)} date(s) in {date_col!r} are not ISO dates: {', '.join(not_dates[:3])}"] if not_dates else [])
        stop(2, "; ".join(bad) + " - run clean.py on the file first (SKILL.md step 2) and chart its output")
    if blank:
        notes.append(f"{len(blank)} row(s) have no {val_col} and are left out (rows {', '.join(map(str, blank[:5]))}{' ...' if len(blank) > 5 else ''})")
    return db, notes


def merge_top(pairs: list[tuple[str, float]], k: int, others: str) -> list[tuple[str, float]]:
    """The k largest, the rest added up as one: sums may be merged, averages may not (references/charts.md)."""
    if len(pairs) <= k + 1:
        return pairs
    return pairs[:k] + [(others, sum(v for _, v in pairs[k:]))]


def month_name(fmt, ym: str) -> str:
    return f"{fmt.month(int(ym[5:7]))} {ym[:4]}"


def span(fmt, first: str, last: str) -> str:
    """The period the data covers, as a title says it: "Mar 2026", "Jan–Jun 2026", "Nov 2025 – Feb 2026"."""
    if first == last:
        return month_name(fmt, first)
    if first[:4] == last[:4]:
        return f"{fmt.month(int(first[5:7]))}–{fmt.month(int(last[5:7]))} {last[:4]}"
    return f"{month_name(fmt, first)} – {month_name(fmt, last)}"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="a clean CSV: clean.py's output")
    ap.add_argument("--date", required=True, help="the date column (ISO dates; blank dates are left out of the month charts)")
    ap.add_argument("--category", required=True, help="the column to group by: city, product, agent ...")
    ap.add_argument("--value", required=True, help="the number to add up: total, amount, hours ...")
    ap.add_argument("--title", help="what, where, when - by default the value, the category and the period the data covers")
    ap.add_argument("--locale", default="en-US", help="the reader's BCP-47 tag: en-US, id-ID, de-DE, en-IN ...")
    ap.add_argument("--currency", help="ISO 4217 code of the money: IDR, USD, EUR ... (leave out for counts)")
    ap.add_argument("--theme", choices=list(THEMES), default="light", help="light for documents, dark for a chat or a dark slide")
    ap.add_argument("--top", type=int, default=8, help="categories drawn before the rest become one bar (default 8)")
    ap.add_argument("--out", required=True, help="the PNG to write")
    ap.add_argument("--ds", help="the data-sheets scripts folder, when this file was copied out of it")
    a = ap.parse_args()

    Formatter, OTHERS = helpers(a.ds)
    try:
        fmt = Formatter(a.locale, a.currency)
    except ValueError as err:
        stop(1, str(err))
    money, short = fmt.money, fmt.money_short
    others = OTHERS.get(fmt.tag.split("-")[0], "Others")
    db, notes = load(a.file, a.date, a.category, a.value)
    q = {name: db.execute(sql).fetchall() for name, sql in QUERIES.items()}
    total, rows = q["total"][0]
    if rows == 0:
        stop(2, f"{a.file} has no rows with a {a.value}")
    by_cat, by_month, running = q["by_category"], q["by_month"], q["running"]
    undated_n, undated_v = q["undated"][0]
    first, last = (by_month[0][0], by_month[-1][0]) if by_month else (None, None)
    period = span(fmt, first, last) if first else ""
    title = a.title or f"{a.value} by {a.category}" + (f", {period}" if period else "")

    # ---- PANELS: what each one shows, as numbers first. Every number drawn is printed here.
    # A tile is read at a glance: big amounts in their short form (Rp209 jt, $209M); the exact ones are printed below.
    def glance(x: float) -> str:
        return short(x) if abs(x) >= 100_000 else money(x)

    tiles = [("Total", glance(total)), ("Rows", fmt.number(rows, 0)), ("Average per row", glance(total / rows))]
    if len(by_month) >= 2:
        (pm, pv), (lm, lv) = by_month[-2], by_month[-1]
        change = "-" if pv == 0 else fmt.percent((lv - pv) / abs(pv) * 100, 1)
        tiles.append((f"{month_name(fmt, lm)} vs {month_name(fmt, pm)}", change))
    else:
        tiles.append(("Change on the month before", "- (one month of data)"))
    bars = merge_top(by_cat, a.top, others)
    share = merge_top(by_cat, 5, others)

    print(f"numbers: {fmt.describe()}")
    for note in notes + fmt.notes:
        print(f"note: {note}")
    print("tiles: " + " | ".join(f"{k} {v}" for k, v in tiles) + f" (exact total {money(total)}, average {money(total / rows)})")
    print(f"by {a.category} ({len(by_cat)}{f', the {a.top} largest and {others}' if len(bars) < len(by_cat) else ''}): "
          + "; ".join(f"{k} {money(v)}" for k, v in bars))
    print("by month: " + ("; ".join(f"{month_name(fmt, m)} {money(v)}" for m, v in by_month) or "no dates"))
    if undated_n:
        print(f"note: {undated_n} row(s) have no date ({money(undated_v)}): in the total and by {a.category}, not in the month charts")
    positive = all(v > 0 for _, v in share)
    if positive:
        print("share: " + "; ".join(f"{k} {fmt.percent(v / total * 100, 1)}" for k, v in share))
    else:
        print("share: not drawn - a share needs every part above zero")
    print("running total: " + ("; ".join(f"{month_name(fmt, m)} {money(v)}" for m, v in running) or "no dates"))

    # The same total three ways. They differ only when a query is wrong - fix it, never the picture.
    sums = {"total": total, f"by {a.category}": sum(v for _, v in by_cat), "by month + undated": sum(v for _, v in by_month) + undated_v}
    if running:
        sums["running total + undated"] = running[-1][1] + undated_v
    if max(sums.values()) - min(sums.values()) > 1e-6 * max(1.0, abs(total)):
        stop(5, "PROBLEM: the totals do not reconcile - " + "; ".join(f"{k} {money(v)}" for k, v in sums.items()))
    print(f"check: {', '.join(sums)} all {money(total)} - ok")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.ticker import FuncFormatter, MaxNLocator
    except ImportError:
        stop(3, "matplotlib is missing in this Python: `pip install matplotlib`, then run this again")

    th = THEMES[a.theme]
    plt.rcParams.update({"font.size": 9, "axes.titlesize": 11, "axes.titleweight": "bold", "axes.titlelocation": "left",
                         "axes.edgecolor": th["grid"], "axes.labelcolor": th["muted"], "xtick.color": th["muted"],
                         "ytick.color": th["muted"], "text.color": th["fg"], "axes.spines.top": False,
                         "axes.spines.right": False, "figure.facecolor": th["bg"], "axes.facecolor": th["bg"]})
    # Constrained layout makes room for the longest label instead of cutting it off at the edge.
    fig = plt.figure(figsize=SIZE_IN, dpi=DPI, layout="constrained")
    fig.get_layout_engine().set(h_pad=0.08, w_pad=0.08, hspace=0.06, wspace=0.06)
    grid = fig.add_gridspec(3, 2, height_ratios=[0.8, 3, 3])
    fig.suptitle(title, x=0.02, ha="left", fontsize=14, fontweight="bold")
    axis_money = FuncFormatter(lambda x, _: short(x))

    # Tiles: four boxes across the top.
    tile_row = grid[0, :].subgridspec(1, 4)
    for i, (label, value) in enumerate(tiles):
        ax = fig.add_subplot(tile_row[0, i])
        ax.set_facecolor(th["panel"])
        ax.set_xticks([]), ax.set_yticks([])
        for side in ax.spines.values():
            side.set_visible(False)
        ax.text(0.06, 0.66, value, fontsize=13 if len(value) <= 12 else max(8.0, 13 * 12 / len(value)),
                fontweight="bold", va="center", transform=ax.transAxes)
        ax.text(0.06, 0.24, label, fontsize=7.5, color=th["muted"], va="center", transform=ax.transAxes)

    # By category: horizontal bars, largest on top, from zero, the merged rest in grey.
    ax = fig.add_subplot(grid[1, 0])
    labels, values = [k for k, _ in bars][::-1], [v for _, v in bars][::-1]
    ax.barh(labels, values, color=[th["other"] if k == others else th["accent"] for k in labels])
    ax.set_xlim(left=min(0, min(values)))
    ax.xaxis.set_major_formatter(axis_money)
    ax.xaxis.set_major_locator(MaxNLocator(4))
    ax.set_title(f"{a.value} by {a.category}")
    ax.grid(axis="x", color=th["grid"], linewidth=0.6)
    ax.set_axisbelow(True)
    for y, v in enumerate(values):
        ax.annotate(short(v), (v, y), xytext=(3, 0), textcoords="offset points", va="center", fontsize=7.5)

    # By month: bars in time order, from zero.
    ax = fig.add_subplot(grid[1, 1])
    if by_month:
        names = [f"{fmt.month(int(m[5:7]))}\n{m[:4]}" if i == 0 or m[5:7] == "01" else fmt.month(int(m[5:7])) for i, (m, _) in enumerate(by_month)]
        ax.bar(names, [v for _, v in by_month], color=th["accent"])
        ax.yaxis.set_major_formatter(axis_money)
        ax.yaxis.set_major_locator(MaxNLocator(4))
        ax.grid(axis="y", color=th["grid"], linewidth=0.6)
        ax.set_axisbelow(True)
    else:
        ax.text(0.5, 0.5, "no dates", ha="center", va="center", color=th["muted"], transform=ax.transAxes)
    ax.set_title(f"{a.value} by month")

    # Share: a ring of at most six parts, the rest in grey.
    ax = fig.add_subplot(grid[2, 0])
    if positive:
        ax.pie([v for _, v in share], labels=[f"{k}\n{fmt.percent(v / total * 100, 1)}" for k, v in share],
               colors=[th["other"] if k == others else PARTS[i % len(PARTS)] for i, (k, _) in enumerate(share)],
               startangle=90, counterclock=False, wedgeprops={"width": 0.38, "edgecolor": th["bg"]}, textprops={"fontsize": 7.5})
        ax.text(0, 0, short(total), ha="center", va="center", fontsize=10, fontweight="bold")
    else:
        ax.axis("off")
        ax.text(0.5, 0.5, "no share chart:\na part is zero or below", ha="center", va="center", color=th["muted"], transform=ax.transAxes)
    ax.set_title(f"Share of {a.value}")

    # Running total: a line from zero, its last point named.
    ax = fig.add_subplot(grid[2, 1])
    if running:
        xs = list(range(len(running)))
        ax.plot(xs, [v for _, v in running], color=th["accent"], marker="o", markersize=3, linewidth=1.8)
        ax.set_xticks(xs, [fmt.month(int(m[5:7])) for m, _ in running])
        # Headroom over the last point, so its label stays inside the chart and clear of the title above it.
        ax.set_ylim(bottom=min(0, min(v for _, v in running)), top=max(v for _, v in running) * 1.15)
        ax.yaxis.set_major_formatter(axis_money)
        ax.yaxis.set_major_locator(MaxNLocator(4))
        ax.grid(axis="y", color=th["grid"], linewidth=0.6)
        ax.annotate(short(running[-1][1]), (xs[-1], running[-1][1]), xytext=(-4, 6), textcoords="offset points", ha="right", fontsize=7.5)
    ax.set_title("Running total")

    out_dir = os.path.dirname(os.path.abspath(a.out))
    os.makedirs(out_dir, exist_ok=True)
    fig.savefig(a.out, dpi=DPI, facecolor=th["bg"])
    print(f"wrote {a.out} ({int(SIZE_IN[0] * DPI)}x{int(SIZE_IN[1] * DPI)} px)")
    print("next: `read` the PNG and do the look-check (references/charts.md) before sending it")


if __name__ == "__main__":
    main()
