#!/usr/bin/env python3
"""
chart.py - a chart that is right by default: one colour per series, bars sorted, numbers formatted, units on the
axis, text readable on a phone. Writes a PNG and prints what it plotted, so the numbers can be checked.

From a table (CSV/TSV/JSON/XLSX, read like profile.py reads it):

    python3 chart.py bar|barh|line|scatter|pie FILE --x COL --y COL[,COL2...] [--group COL]
                     [--agg sum|mean|count|min|max|none] [--period day|week|month|quarter|year] [--sort auto|value|label|none] [--top N]
                     [--title T] [--xlabel T] [--ylabel T] [--locale BCP-47] [--currency ISO-4217] [--unit %|kg|...]
                     [--highlight LABEL] [--label COL] [--size wide|phone|square] [--out PNG] [--data-out CSV]
                     [--sheet S] [--header N] [--decimal auto|comma|dot] [--dates auto|dayfirst|monthfirst]

From inline data, a JSON config (the chart-maker format, extended):

    python3 chart.py CONFIG.json
    {"type": "bar"|"barh"|"line"|"pie"|"scatter", "title": "...", "xlabel": "...", "ylabel": "...",
     "data": [{"label": "Jakarta", "value": 1250000, "info": "optional note shown beside the value"}, ...],
     "output": "/path/chart.png"}
    Several series instead of "data":  "series": [{"name": "2025", "data": [{"label": ..., "value": ...}]}, ...]
    Optional keys, same meaning as the options above: "locale", "currency", "unit", "sort", "top", "size", "highlight".

Numbers are written for --locale (a BCP-47 tag: en-US, en-GB, en-IN, id-ID, de-DE, de-CH, fr-FR, ja-JP, pt-BR ...)
and money for --currency (an ISO 4217 code: USD, EUR, IDR, INR, JPY ...): separators, grouping, the currency's symbol,
its side and its decimals, and the short forms on the axis (1.25M, 1,25 jt, 1,25 Mio., 125万, 12.5L) all follow
CLDR - from Babel when installed, else from numfmt_cldr.json beside this file. --unit is for what is not money: "%",
"kg", "orang". Without --locale the numbers are en-US, and the output says so.

--y with several columns, or --group, makes one series each: grouped bars or several lines (at most 6).
Bars are sorted by value, largest first, unless the categories have an order of their own (dates, numbers, months,
days, quarters) or --sort none. More than 8 bars or long labels turn a bar chart into barh. More than --top
categories (default 15) are merged into "Others" ("Lainnya") when the values are sums or counts.
A pie takes at most 6 slices and no negatives - otherwise it refuses and says to use barh.

Exit: 0 written; 1 bad arguments or data that cannot be charted as asked; 2 the file cannot be read; 3 matplotlib missing.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from numfmt import Formatter, unit_to_currency  # noqa: E402
from sheetlib import MONTHS, Stop, columns, refuse_ambiguous, find_column, fmt_num, is_total_row, read_table, run_main, to_date  # noqa: E402

ONE = "#2563EB"                      # a single series: one colour, because a colour per bar implies a meaning
MUTED = "#A0AEC0"                    # the bars not highlighted
SERIES = ["#2563EB", "#E69F00", "#009E73", "#CC79A7", "#56B4E9", "#D55E00"]   # Okabe-Ito based, colour-blind safe
PIE_MAX = 6
SERIES_MAX = 6
SIZES = {"wide": (7.2, 4.5), "phone": (5.0, 6.0), "square": (6.0, 6.0)}
DPI = 200
DAYS = ["senin", "selasa", "rabu", "kamis", "jumat", "jum'at", "sabtu", "minggu", "mon", "tue", "wed", "thu", "fri",
        "sat", "sun", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
        "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag", "lundi", "mardi", "mercredi",
        "jeudi", "vendredi", "samedi", "dimanche", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
OTHERS = {"id": "Lainnya", "ms": "Lain-lain", "de": "Sonstige", "fr": "Autres", "es": "Otros", "pt": "Outros", "it": "Altri",
          "nl": "Overig", "ja": "その他", "zh": "其他", "ko": "기타"}


# ---------------------------------------------------------------- the data, whatever it came from

class Chart:
    def __init__(self):
        self.kind = "bar"
        self.title = ""
        self.xlabel = ""
        self.ylabel = ""
        self.labels: list = []            # categories (or x values for line/scatter)
        self.series: list[tuple[str, list]] = []   # (name, values aligned to labels; None = missing)
        self.infos: list[str] = []        # one per label, single series only
        self.point_labels: list[str] = []  # scatter
        self.unit = ""
        self.locale = ""
        self.currency = ""
        self.fmt: Formatter | None = None
        self.money_digits = 0
        self.period = ""
        self.ordered = False
        self.sort = "auto"
        self.top = 15
        self.size = "wide"
        self.highlight = None
        self.out = ""
        self.summable = True              # values are sums or counts: "Others" may add them up
        self.notes: list[str] = []
        self.rows_used = 0


def from_config(path: str) -> Chart:
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError) as e:
        raise Stop(2, f"cannot read the config {path}: {e}") from None
    c = Chart()
    c.kind = cfg.get("type", "bar")
    c.title, c.xlabel, c.ylabel = cfg.get("title", ""), cfg.get("xlabel", ""), cfg.get("ylabel", "")
    c.unit = cfg.get("unit", "")
    c.locale = cfg.get("locale", "")
    c.currency = cfg.get("currency", "")
    c.sort = cfg.get("sort", "auto")
    c.top = int(cfg.get("top", 15))
    c.size = cfg.get("size", "wide")
    c.highlight = cfg.get("highlight")
    c.out = cfg.get("output", "")
    if "series" in cfg:
        labels: list = []
        for s in cfg["series"]:
            for item in s.get("data", []):
                if item.get("label") not in labels:
                    labels.append(item.get("label"))
        c.labels = labels
        for s in cfg["series"]:
            m = {item.get("label"): item.get("value") for item in s.get("data", [])}
            c.series.append((str(s.get("name", f"series {len(c.series) + 1}")), [num(m.get(lab)) for lab in labels]))
        c.infos = [""] * len(labels)
    else:
        data = cfg.get("data", [])
        if not data:
            raise Stop(1, f"{path}: no \"data\" (a list of {{\"label\", \"value\"}}) and no \"series\"")
        c.labels = [str(item.get("label", "")) for item in data]
        c.series = [(c.ylabel or "value", [num(item.get("value")) for item in data])]
        c.infos = [str(item.get("info", "") or "") for item in data]
        if c.kind == "scatter":
            c.labels = [num(item.get("x", item.get("label"))) for item in data]
            c.point_labels = [str(item.get("info", "") or "") for item in data]
    c.rows_used = len(c.labels)
    return c


def num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    from sheetlib import to_number
    x = to_number(str(v), "comma" if re.search(r"\d\.\d{3}(,|$)", str(v)) else "dot")
    if x is None:
        raise Stop(1, f"value {v!r} is not a number - write it as a plain number (1234.5) in the config")
    return x


def from_table(a) -> Chart:
    t = read_table(a.file, a.sheet, a.header)
    cols = columns(t, a.decimal, a.dates)
    c = Chart()
    c.kind, c.title, c.unit, c.locale, c.sort, c.top, c.size = a.kind, a.title or "", a.unit or "", a.locale or "", a.sort, a.top, a.size
    c.currency = a.currency or ""
    c.highlight, c.out = a.highlight, a.out or ""
    if not a.x or not a.y:
        raise Stop(1, "--x and --y are needed with a table (--y may name several columns, comma-separated)")
    xi = find_column(t, a.x)
    yis = [find_column(t, y.strip()) for y in a.y.split(",")]
    gi = find_column(t, a.group) if a.group else None
    li = find_column(t, a.label) if a.label else None
    xc = cols[xi]
    refuse_ambiguous(cols, [xi] + yis + ([li] if li is not None else []), a.decimal, a.dates)
    # A header written for SQL (total_bayar) is not an axis label: "Total bayar".
    pretty = lambda h: (h.replace("_", " ").strip().capitalize() if re.fullmatch(r"[a-z0-9_]+", h) else h)
    c.xlabel = a.xlabel if a.xlabel is not None else pretty(t.headers[xi])
    c.ylabel = a.ylabel if a.ylabel is not None else (pretty(t.headers[yis[0]]) if len(yis) == 1 else "")
    if gi is not None and len(yis) > 1:
        raise Stop(1, "--group with several --y columns would make series of series: use one of them")

    skipped: list[str] = []
    totals = 0
    # (x key, series name) -> list of values
    cells: dict[tuple, list] = {}
    xorder: list = []
    snames: list[str] = []
    xs_scatter, ys_scatter, lbl_scatter = [], [], []
    for r, n in zip(t.rows, t.rownums):
        if is_total_row(r):
            totals += 1
            continue
        if c.kind == "scatter":
            x = xc.number(r[xi])
            y = cols[yis[0]].number(r[yis[0]])
            if x is None or y is None:
                skipped.append(f'row {n} ("{r[xi]}", "{r[yis[0]]}")')
                continue
            xs_scatter.append(x)
            ys_scatter.append(y)
            lbl_scatter.append(str(r[li]) if li is not None else "")
            continue
        raw = r[xi]
        if xc.kind == "date":
            key = xc.date(raw)
            if key is not None and a.period:
                key = bucket(key, a.period)
        elif xc.kind in ("integer", "decimal"):
            key = xc.number(raw)
        else:
            key = " ".join(str(raw).split())
        if key is None or key == "":
            skipped.append(f'row {n} (empty {t.headers[xi]})')
            continue
        targets = [(t.headers[yi], yi) for yi in yis] if gi is None else [(" ".join(str(r[gi]).split()) or "(empty)", yis[0])]
        for sname, yi in targets:
            if a.agg == "count":
                v = 1.0
            else:
                v = cols[yi].number(r[yi])
                if v is None:
                    skipped.append(f'row {n} ("{str(r[yi])[:20]}" in {t.headers[yi]})')
                    continue
            if key not in xorder:
                xorder.append(key)
            if sname not in snames:
                snames.append(sname)
            cells.setdefault((key, sname), []).append(v)
    if totals:
        c.notes.append(f"left out {totals} row(s) that look like totals (Total/Jumlah) - they would count twice")
    if skipped:
        c.notes.append(f"skipped {len(skipped)} row(s) with no usable value: " + ", ".join(skipped[:5]) + (" ..." if len(skipped) > 5 else ""))

    folded: dict[str, list] = {}
    for x in xorder:
        if isinstance(x, str):
            folded.setdefault(x.lower(), []).append(x)
    split = [v for v in folded.values() if len(v) > 1]
    if split:
        c.notes.append(f"SPLIT: {len(split)} label(s) differ only in capitals or spaces and are drawn as separate bars: "
                       + "; ".join(" / ".join(f'"{x}"' for x in v) for v in split[:4])
                       + f" - clean first: clean.py FILE --out CLEAN.csv --unify \"{t.headers[xi]}\", then chart CLEAN.csv")
    if c.kind == "scatter":
        c.labels, c.series, c.point_labels = xs_scatter, [(c.ylabel, ys_scatter)], lbl_scatter
        c.rows_used = len(xs_scatter)
        return c
    if len(snames) > SERIES_MAX:
        raise Stop(1, f"{len(snames)} series ({', '.join(snames[:8])}...) - more than {SERIES_MAX} lines or bar groups "
                      "cannot be told apart. Filter to the ones that matter, or chart one series per picture")

    agg = a.agg
    many = any(len(v) > 1 for v in cells.values())
    if agg == "none" and many:
        raise Stop(1, "several rows share one x value; say how to combine them: --agg sum (or mean, count, max, min)")
    if agg == "auto":
        agg = "sum" if many else "none"
        if many:
            c.notes.append(f"several rows per {t.headers[xi]}: values added up (--agg mean/max/min/count to change)")
    fn = {"sum": sum, "none": lambda v: v[0], "count": len, "mean": lambda v: sum(v) / len(v), "min": min, "max": max}[agg]
    c.summable = agg in ("sum", "count", "none")
    if xc.kind in ("date", "integer", "decimal"):
        xorder.sort()
    c.labels = xorder
    c.series = [(s, [fn(cells[(x, s)]) if (x, s) in cells else None for x in xorder]) for s in snames]
    c.infos = [""] * len(xorder)
    c.rows_used = sum(len(v) for v in cells.values())
    if agg != "none":
        c.notes.append(f"aggregated with {agg}: {c.rows_used} value(s) into {len(xorder)} point(s)"
                       + (f" per {a.period}" if a.period else ""))
    if xc.kind == "date" and not a.period and len(xorder) > 40 and c.kind in ("line", "bar"):
        c.notes.append(f"{len(xorder)} dates - a trend reads better per week or month: --period month")
    c.period = a.period or ""
    c.ordered = xc.kind in ("date", "integer", "decimal")
    return c


# ---------------------------------------------------------------- deciding the shape

def bucket(d: dt.datetime, period: str) -> dt.datetime:
    if period == "year":
        return dt.datetime(d.year, 1, 1)
    if period == "quarter":
        return dt.datetime(d.year, 3 * ((d.month - 1) // 3) + 1, 1)
    if period == "month":
        return dt.datetime(d.year, d.month, 1)
    if period == "week":
        d = d - dt.timedelta(days=d.weekday())    # the Monday the week starts on
    return dt.datetime(d.year, d.month, d.day)


def has_order(labels: list) -> bool:
    if not labels:
        return False
    if all(isinstance(x, (int, float, dt.datetime)) for x in labels):
        return True
    low = [str(x).strip().lower() for x in labels]
    if all(re.match(r"^(q[1-4]|kuartal|triwulan|semester|tw)\b", x) or re.match(r"^\d{4}", x) for x in low):
        return True
    if all(x.split()[0].rstrip(".") in MONTHS for x in low if x) or all(x in DAYS for x in low):
        return True
    return all(to_date(str(x), True) is not None for x in labels)


def shape(c: Chart) -> None:
    n = len(c.labels)
    if c.kind not in ("bar", "barh", "line", "scatter", "pie"):
        raise Stop(1, f"unknown chart type {c.kind!r}: bar, barh, line, scatter or pie")
    if n == 0:
        raise Stop(1, "nothing to plot - every row was skipped (see the notes above)")
    if c.kind == "pie":
        vals = c.series[0][1]
        if len(c.series) > 1:
            raise Stop(1, "a pie shows one series; use bar for several")
        if any(v is not None and v < 0 for v in vals):
            raise Stop(1, "a pie cannot show negative values - use bar")
        if n > PIE_MAX:
            raise Stop(1, f"{n} slices: a pie past {PIE_MAX} cannot be read (slices of similar size look the same). "
                          "Use barh - the same data sorted is easier to compare. Or merge the small ones into 'Others' first")
        return
    if c.kind in ("bar", "barh"):
        ordered = c.ordered or has_order(c.labels)
        sort = c.sort
        if sort == "auto":
            sort = "none" if ordered else "value"
        if sort == "value":
            key = [sum(v for v in vals if v is not None) for vals in zip(*[s[1] for s in c.series])] if len(c.series) > 1 else \
                  [v if v is not None else -math.inf for v in c.series[0][1]]
            idx = sorted(range(n), key=lambda i: -key[i])
            reorder(c, idx)
            c.notes.append("sorted by value, largest first" + (" (by the sum of the series)" if len(c.series) > 1 else ""))
        elif sort == "label":
            idx = sorted(range(n), key=lambda i: str(c.labels[i]))
            reorder(c, idx)
        if len(c.labels) > c.top and c.top > 0:
            cut(c)
        longest = max(len(label_text(x)) for x in c.labels)
        if c.kind == "bar" and (len(c.labels) > 6 or longest > 12 or len(c.labels) * len(c.series) > 12) and not ordered:
            c.kind = "barh"
            c.notes.append(f"drawn as horizontal bars ({len(c.labels)} categories, longest label {longest} characters)")


def reorder(c: Chart, idx: list[int]) -> None:
    c.labels = [c.labels[i] for i in idx]
    c.series = [(s, [v[i] for i in idx]) for s, v in c.series]
    c.infos = [c.infos[i] for i in idx] if c.infos else c.infos


def cut(c: Chart) -> None:
    k = c.top
    rest = len(c.labels) - k
    other = OTHERS.get(c.fmt.tag.split("-")[0], "Others")
    if c.summable:
        merged = [sum(v for v in vals[k:] if v is not None) for _, vals in c.series]
        c.labels = c.labels[:k] + [f"{other} ({rest})"]
        c.series = [(s, vals[:k] + [m]) for (s, vals), m in zip(c.series, merged)]
        c.infos = (c.infos[:k] + [""]) if c.infos else c.infos
        c.notes.append(f"the smallest {rest} merged into \"{other} ({rest})\" (--top to change)")
    else:
        c.labels = c.labels[:k]
        c.series = [(s, vals[:k]) for s, vals in c.series]
        c.infos = c.infos[:k] if c.infos else c.infos
        c.notes.append(f"showing the first {k} of {k + rest} - averages cannot be merged into 'Others' (--top to change)")


def label_text(x) -> str:
    if isinstance(x, dt.datetime):
        return x.date().isoformat() if (x.hour, x.minute) == (0, 0) else x.isoformat(sep=" ", timespec="minutes")
    if isinstance(x, float):
        return fmt_num(x)
    return str(x)


# ---------------------------------------------------------------- numbers as people read them

def setup_format(c: Chart) -> None:
    """The Formatter for this chart, from --locale/--currency, or from a currency typed as --unit (Rp, €, USD)."""
    if c.unit and not c.currency:
        code = unit_to_currency(c.unit)
        if code:
            c.notes.append(f"--unit {c.unit} read as the currency {code} (say --currency {code} next time)")
            c.currency, c.unit = code, ""
        elif c.unit.strip() in ("$", "¥", "kr", "R"):
            raise Stop(1, f"--unit {c.unit} is used by several currencies: give --currency (USD, SGD, AUD, CAD, HKD; JPY, CNY; SEK, NOK, DKK; ZAR)")
    if not c.locale:
        c.notes.append("no --locale: numbers written en-US style (1,234.5) - pass the reader's locale, e.g. --locale id-ID or de-DE")
    try:
        c.fmt = Formatter(c.locale or "en-US", c.currency or None)
    except ValueError as e:
        raise Stop(1, str(e)) from None
    c.notes.extend(c.fmt.notes)
    if c.period and c.kind != "line" and all(isinstance(x, dt.datetime) for x in c.labels):
        f = c.fmt
        name = {"year": lambda d: str(d.year), "quarter": lambda d: f"Q{(d.month - 1) // 3 + 1} {d.year}",
                "month": lambda d: f"{f.month(d.month)} {d.year}", "week": lambda d: f"{d.day} {f.month(d.month)} {d.year}",
                "day": lambda d: f"{d.day} {f.month(d.month)} {d.year}"}[c.period]
        c.labels = [name(d) for d in c.labels]
    if c.currency:
        frac = any(v is not None and not float(v).is_integer() for _, vals in c.series for v in vals)
        c.money_digits = c.fmt.digits if frac else 0


def tick(v: float, c: Chart) -> str:
    if c.currency:
        return c.fmt.money_short(v)
    if c.unit == "%":
        return c.fmt.percent(v)
    return c.fmt.short(v) + (f" {c.unit}" if c.unit else "")


def full(x: float, c: Chart) -> str:
    if x is None:
        return ""
    if c.currency:
        return c.fmt.money(x, c.money_digits)
    if c.unit == "%":
        return c.fmt.percent(round(x, 2))
    return c.fmt.number(round(x, 2) if not float(x).is_integer() else x) + (f" {c.unit}" if c.unit else "")


def unit_label(c: Chart) -> str:
    if c.currency:
        return c.fmt.symbol if c.fmt.symbol != c.currency else c.currency
    return c.unit


# ---------------------------------------------------------------- drawing

def draw(c: Chart) -> tuple[str, tuple[int, int]]:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from matplotlib.ticker import FuncFormatter, MaxNLocator
    except ImportError:
        raise Stop(3, "this needs matplotlib in the Python that runs it: `pip install matplotlib` "
                      "(on a Nouride host plain `pip install` goes into your Python env)") from None

    plt.rcParams.update({
        "font.size": 14, "axes.titlesize": 17, "axes.titleweight": "bold", "axes.labelsize": 14,
        "xtick.labelsize": 13, "ytick.labelsize": 13, "legend.fontsize": 13, "axes.spines.top": False,
        "axes.spines.right": False, "axes.titlelocation": "left", "axes.titlepad": 14,
    })
    w, h = SIZES.get(c.size, SIZES["wide"])
    if c.kind == "barh":
        h = max(h, min(12, 1.2 + 0.42 * len(c.labels) * max(1, len(c.series) * 0.7)))
    fig, ax = plt.subplots(figsize=(w, h), dpi=DPI)
    tick_fmt = FuncFormatter(lambda v, _: tick(v, c))
    multi = len(c.series) > 1
    hi = c.highlight

    if c.kind in ("bar", "barh"):
        n, k = len(c.labels), len(c.series)
        width = 0.75 / k
        names = [label_text(x) for x in c.labels]
        pos = list(range(n))
        for si, (sname, vals) in enumerate(c.series):
            offs = [p - 0.375 + width * (si + 0.5) for p in pos]
            vv = [v if v is not None else 0 for v in vals]
            if multi:
                colors = SERIES[si]
            elif hi is not None:
                colors = [ONE if str(nm) == str(hi) else MUTED for nm in names]
            else:
                colors = ONE
            if c.kind == "bar":
                bars = ax.bar(offs, vv, width=width * 0.92, color=colors, label=sname if multi else None)
            else:
                bars = ax.barh(offs, vv, height=width * 0.92, color=colors, label=sname if multi else None)
            if n * k <= 24:
                for b, v, info in zip(bars, vals, c.infos if not multi else [""] * n):
                    if v is None:
                        continue
                    if c.kind == "bar":
                        text = (tick(v, c) if abs(v) >= 10000 else full(v, c)) + (f"\n{info}" if info else "")
                        ax.annotate(text, (b.get_x() + b.get_width() / 2, b.get_height()), xytext=(0, 3),
                                    textcoords="offset points", ha="center", va="bottom" if v >= 0 else "top",
                                    fontsize=11 if k == 1 else 9)
                    else:
                        text = full(v, c) + (f"  ({info})" if info else "")
                        ax.annotate(text, (b.get_width(), b.get_y() + b.get_height() / 2), xytext=(4, 0),
                                    textcoords="offset points", ha="left" if v >= 0 else "right", va="center",
                                    fontsize=11 if k == 1 else 9)
        if c.kind == "bar":
            ax.set_xticks(pos, names)
            if max(len(x) for x in names) * n > 60:
                plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
            ax.yaxis.set_major_formatter(tick_fmt)
            ax.yaxis.set_major_locator(MaxNLocator(6))
            ax.margins(y=0.12)
            ax.grid(axis="y", alpha=0.3)
            ax.axhline(0, color="#333", linewidth=0.8)
        else:
            ax.set_yticks(pos, names)
            ax.invert_yaxis()            # the first (largest) at the top, read top-down
            ax.xaxis.set_major_formatter(tick_fmt)
            ax.xaxis.set_major_locator(MaxNLocator(5))
            ax.margins(x=0.22 if any(c.infos) else 0.15)
            ax.grid(axis="x", alpha=0.3)
            ax.axvline(0, color="#333", linewidth=0.8)
    elif c.kind == "line":
        xs = c.labels
        dated = all(isinstance(x, dt.datetime) for x in xs)
        numeric = all(isinstance(x, (int, float)) for x in xs)
        xplot = xs if (dated or numeric) else list(range(len(xs)))
        for si, (sname, vals) in enumerate(c.series):
            pts = [(x, v) for x, v in zip(xplot, vals) if v is not None]
            ax.plot([p[0] for p in pts], [p[1] for p in pts], color=SERIES[si] if multi else ONE, linewidth=2.5,
                    marker="o" if len(pts) <= 30 else None, markersize=5, label=sname if multi else None)
            if not multi and len(pts) <= 12:
                for (x, v), info in zip(pts, [i for i, v2 in zip(c.infos, vals) if v2 is not None]):
                    ax.annotate(full(v, c) + (f" ({info})" if info else ""), (x, v), xytext=(0, 7),
                                textcoords="offset points", ha="center", fontsize=10)
            elif pts and not multi:
                x, v = pts[-1]
                ax.annotate(full(v, c), (x, v), xytext=(5, 0), textcoords="offset points", fontsize=10,
                            color=SERIES[si] if multi else ONE, va="center")
        if not (dated or numeric):
            ax.set_xticks(xplot, [label_text(x) for x in xs])
            if len(xs) > 8:
                plt.setp(ax.get_xticklabels(), rotation=30, ha="right")
        if dated:
            import matplotlib.dates as mdates
            loc = mdates.AutoDateLocator(maxticks=7)
            ax.xaxis.set_major_locator(loc)
            ticks_seen: list = []

            def local_date(v, _pos):
                # Month names in the reader's language; the year under the first tick and under each January.
                d = mdates.num2date(v)
                first = not ticks_seen or ticks_seen[-1] != d.year
                ticks_seen.append(d.year)
                if d.day != 1:
                    return f"{d.day} {c.fmt.month(d.month)}"
                return f"{c.fmt.month(d.month)}\n{d.year}" if first or d.month == 1 else c.fmt.month(d.month)
            ax.xaxis.set_major_formatter(FuncFormatter(local_date))
        ax.yaxis.set_major_formatter(tick_fmt)
        ax.yaxis.set_major_locator(MaxNLocator(6))
        ax.grid(axis="y", alpha=0.3)
        ax.margins(y=0.15)
        if all(v is None or v >= 0 for _, vals in c.series for v in vals):
            ax.set_ylim(bottom=0)
    elif c.kind == "scatter":
        xs, ys = c.labels, c.series[0][1]
        ax.scatter(xs, ys, color=ONE, alpha=0.75 if len(xs) > 50 else 0.9, s=28 if len(xs) > 200 else 46)
        if c.point_labels and any(c.point_labels) and len(xs) <= 25:
            for x, y, lab in zip(xs, ys, c.point_labels):
                ax.annotate(lab, (x, y), xytext=(4, 4), textcoords="offset points", fontsize=10)
        ax.yaxis.set_major_formatter(tick_fmt)
        ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: c.fmt.short(v)))
        ax.grid(alpha=0.3)
        if len(xs) >= 3:
            mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
            sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
            sy = math.sqrt(sum((y - my) ** 2 for y in ys))
            if sx and sy:
                r = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy)
                c.notes.append(f"correlation r = {r:.2f} over {len(xs)} points (a measure of a straight-line relation, not of cause)")
    elif c.kind == "pie":
        vals = [v or 0 for v in c.series[0][1]]
        total = sum(vals)
        pal = SERIES[: len(vals)]
        wedges, _ = ax.pie(vals, colors=pal, startangle=90, counterclock=False,
                           wedgeprops={"linewidth": 2, "edgecolor": "white"})
        pct = lambda v: c.fmt.percent(round(v / total * 100, 1), 1)
        legend = [f"{label_text(lab)}: {pct(v)}" if c.unit == "%" else f"{label_text(lab)}: {full(v, c)} ({pct(v)})"
                  for lab, v in zip(c.labels, vals)]
        ax.legend(wedges, legend, loc="center left", bbox_to_anchor=(1.0, 0.5), frameon=False)
        ax.axis("equal")

    if c.kind != "pie":
        xl, yl = c.xlabel, c.ylabel
        if c.kind == "barh":
            xl, yl = c.ylabel, c.xlabel     # the values run along x now
        u = unit_label(c)
        unit_note = f" ({u})" if u and u not in ((yl if c.kind != "barh" else xl) or "") else ""
        if c.kind == "barh":
            ax.set_xlabel((xl or "") + unit_note)
            ax.set_ylabel(yl or "")
        else:
            ax.set_xlabel(xl or "")
            ax.set_ylabel((yl or "") + unit_note)
        if not (yl if c.kind != "barh" else xl) and not unit_note:
            c.notes.append("the value axis has no label - give --ylabel (and --currency or --unit) unless the title says what is measured")
    if multi:
        ax.legend(frameon=False, loc="best")
    if c.title:
        ax.set_title(c.title)
    else:
        c.notes.append("no title - give --title saying what is measured, where and when")
    fig.tight_layout()
    out = c.out or os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(),
                                "chart-" + (re.sub(r"[^a-z0-9]+", "-", c.title.lower()).strip("-")[:40] or c.kind) + ".png")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    fig.savefig(out, dpi=DPI)
    px = (int(fig.get_figwidth() * DPI), int(fig.get_figheight() * DPI))
    plt.close(fig)
    return out, px


def report(c: Chart, out: str, px: tuple[int, int], data_out: str | None) -> None:
    size = os.path.getsize(out)
    print(f"wrote {out} ({px[0]}x{px[1]} px, {size // 1024} KB) - {c.kind}, {len(c.labels)} point(s)"
          + (f", {len(c.series)} series" if len(c.series) > 1 else ""))
    if c.kind != "scatter":
        print("plotted:")
        for i, lab in enumerate(c.labels[:20]):
            vals = "  ".join(full(s[1][i], c) if s[1][i] is not None else "-" for s in c.series)
            print(f"  {label_text(lab)}: {vals}" + (f"  ({c.infos[i]})" if c.infos and c.infos[i] else ""))
        if len(c.labels) > 20:
            print(f"  ... {len(c.labels) - 20} more")
        for name, vals in c.series:
            tot = sum(v for v in vals if v is not None)
            print(f"total of the plotted values{' for ' + name if len(c.series) > 1 else ''}: {full(tot, c)}")
    for n in c.notes:
        print(f"note: {n}")
    if data_out:
        with open(data_out, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["label"] + [s for s, _ in c.series])
            for i, lab in enumerate(c.labels):
                w.writerow([label_text(lab)] + ["" if s[1][i] is None else s[1][i] for s in c.series])
        print(f"the plotted numbers are in {data_out}")
    print("next: read the PNG and check it against these numbers before sending it with send_file")


def main(argv) -> int:
    if argv and argv[0].lower().endswith(".json") and len(argv) == 1:
        c = from_config(argv[0])
        data_out = None
    elif argv and argv[0] not in ("-h", "--help") and argv[0] not in ("bar", "barh", "line", "scatter", "pie") \
            and argv[0].lower().endswith(".json"):
        raise Stop(1, "a JSON config is given alone: python3 chart.py CONFIG.json")
    else:
        ap = argparse.ArgumentParser(prog="chart.py", description=__doc__.split("\n\n")[0].strip(),
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 2)[2])
        ap.add_argument("kind", choices=["bar", "barh", "line", "scatter", "pie"])
        ap.add_argument("file")
        ap.add_argument("--x", help="the category or time column (scatter: the x numbers)")
        ap.add_argument("--y", help="the value column; several, comma-separated, make several series")
        ap.add_argument("--group", help="a column whose values become the series (e.g. Region -> one line per region)")
        ap.add_argument("--agg", choices=["auto", "sum", "mean", "count", "min", "max", "none"], default="auto",
                        help="how rows with the same x are combined (auto: sum when there are several)")
        ap.add_argument("--period", choices=["day", "week", "month", "quarter", "year"],
                        help="dates on x: add up (or --agg) per day, week (from Monday), month, quarter or year")
        ap.add_argument("--sort", choices=["auto", "value", "label", "none"], default="auto")
        ap.add_argument("--top", type=int, default=15, help="at most this many bars; the rest merged into Others")
        ap.add_argument("--title")
        ap.add_argument("--xlabel")
        ap.add_argument("--ylabel")
        ap.add_argument("--currency", help="ISO 4217 code of the money plotted: IDR, USD, EUR, GBP, JPY, INR, CHF ...")
        ap.add_argument("--unit", help='what is not money: %%, kg, "orang" ... - on the axis and every value label')
        ap.add_argument("--locale", help="the reader's locale, BCP-47: en-US, en-GB, en-IN, id-ID, de-DE, fr-FR, ja-JP ... (default en-US)")
        ap.add_argument("--highlight", help="one category drawn in colour, the rest grey")
        ap.add_argument("--label", help="scatter: a column to write beside each point (25 points at most)")
        ap.add_argument("--size", choices=list(SIZES), default="wide", help="wide 1440x900, phone 1000x1200, square 1200x1200")
        ap.add_argument("--out", help="the PNG to write (default $TMPDIR/chart-<title>.png)")
        ap.add_argument("--data-out", help="also write the plotted numbers to this CSV")
        ap.add_argument("--sheet")
        ap.add_argument("--header", type=int)
        ap.add_argument("--decimal", choices=["auto", "comma", "dot"], default="auto")
        ap.add_argument("--dates", choices=["auto", "dayfirst", "monthfirst"], default="auto")
        a = ap.parse_args(argv)
        c = from_table(a)
        data_out = a.data_out
    setup_format(c)
    shape(c)
    out, px = draw(c)
    report(c, out, px, data_out)
    return 0


if __name__ == "__main__":
    run_main(main)
