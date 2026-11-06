"""
sheetlib.py - reading a table and understanding its cells, shared by profile.py, clean.py, chart.py and xlsx_write.py.
Not run on its own.

A table is read from CSV/TSV (encoding and delimiter detected), JSON (a list of objects, JSON lines, or an object
holding one such list) or XLSX/XLSM (openpyxl when installed, otherwise the document-reading skill's doc.py beside this
skill converts the sheet to CSV first). Cells come back as they are written - numbers and dates are understood by
`Column`, which decides each column's convention (1.234,56 or 1,234.56; dd/mm or mm/dd) from all its values together,
not cell by cell.
"""

from __future__ import annotations

import codecs
import csv
import datetime as dt
import io
import json
import os
import re
import subprocess
import sys
import tempfile

csv.field_size_limit(min(sys.maxsize, 1 << 30))

NULLS = {"", "-", "--", "—", "–", "n/a", "na", "#n/a", "null", "none", "nan", "nil", "?", "#value!", "#ref!", "#div/0!",
         "#name?", "#num!", "n.v.", "k.a.", "s.o.", "n.d.", "nd", "tidak ada", "kosong"}
MONTHS = {
    "jan": 1, "januari": 1, "january": 1, "feb": 2, "februari": 2, "february": 2, "peb": 2, "pebruari": 2,
    "mar": 3, "maret": 3, "march": 3, "apr": 4, "april": 4, "mei": 5, "may": 5, "jun": 6, "juni": 6, "june": 6,
    "jul": 7, "juli": 7, "july": 7, "agu": 8, "agt": 8, "ags": 8, "agustus": 8, "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9, "okt": 10, "oktober": 10, "oct": 10, "october": 10,
    "nov": 11, "nop": 11, "november": 11, "nopember": 11, "des": 12, "desember": 12, "dec": 12, "december": 12,
    # German, French, Spanish, Dutch, Portuguese - the names that differ from the ones above.
    "januar": 1, "februar": 2, "märz": 3, "mär": 3, "mai": 5, "okt": 10, "oktober": 10, "dez": 12, "dezember": 12,
    "janvier": 1, "janv": 1, "février": 2, "févr": 2, "fév": 2, "mars": 3, "avril": 4, "avr": 4, "juin": 6,
    "juillet": 7, "juil": 7, "août": 8, "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12, "déc": 12,
    "enero": 1, "ene": 1, "febrero": 2, "marzo": 3, "abril": 4, "abr": 4, "mayo": 5, "junio": 6, "julio": 7,
    "agosto": 8, "ago": 8, "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12, "dic": 12,
    "maart": 3, "mrt": 3, "augustus": 8,
    "janeiro": 1, "fevereiro": 2, "fev": 2, "março": 3, "maio": 5, "junho": 6, "julho": 7, "setembro": 9,
    "outubro": 10, "dezembro": 12,
}
# Words that open a Total row, in the languages tables usually come in.
TOTAL_WORDS = re.compile(r"^\s*(grand\s+)?(total|sub\s*-?\s*total|subtotal|sum|summe|gesamt|insgesamt|somme|suma|totale|"
                         r"totaal|totalt|jumlah|rekap|keseluruhan|合計|总计|合计)\b", re.I)


class Stop(Exception):
    """A message for the person running the script, and the exit code: 1 usage, 2 cannot read, 3 missing library."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def run_main(main) -> None:
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as e:
        print(f"{os.path.basename(sys.argv[0])}: {e}", file=sys.stderr)
        sys.exit(e.code)
    except KeyboardInterrupt:
        sys.exit(130)
    except BrokenPipeError:
        sys.exit(0)
    except Exception as e:  # noqa: BLE001 - one line, never a traceback, unless asked
        if os.environ.get("SHEET_DEBUG"):
            raise
        print(f"{os.path.basename(sys.argv[0])}: unexpected error: {type(e).__name__}: {e} (SHEET_DEBUG=1 shows where)",
              file=sys.stderr)
        sys.exit(2)


# ---------------------------------------------------------------- reading

class Table:
    def __init__(self, headers: list[str], rows: list[list], rownums: list[int], source: str, notes: list[str]):
        self.headers = headers
        self.rows = rows          # list of cell lists, padded to len(headers)
        self.rownums = rownums    # the row number in the source a person would look up (sheet row, CSV line)
        self.source = source
        self.notes = notes


def read_table(path: str, sheet: str | None = None, header: int | None = None, limit: int | None = None) -> Table:
    if not os.path.exists(path):
        raise Stop(2, f"no file at {path}")
    if os.path.getsize(path) == 0:
        raise Stop(2, f"{path} is empty (0 bytes) - get a fresh copy")
    with open(path, "rb") as f:
        head = f.read(8)
    ext = os.path.splitext(path)[1].lower()
    if head.startswith(b"PK"):
        return read_xlsx(path, sheet, header, limit)
    if head.startswith(b"\xd0\xcf\x11\xe0"):
        raise Stop(2, f"{path} is a legacy .xls (or an encrypted Office file). Convert it first: "
                      "libreoffice --headless --convert-to xlsx --outdir \"$TMPDIR\" FILE - the document-reading skill's "
                      "doc.py inspect says which it is")
    if ext in (".json", ".jsonl", ".ndjson"):
        return read_json(path, limit)
    return read_csv(path, header, limit)


def decode(raw: bytes) -> tuple[str, str]:
    if raw.startswith(codecs.BOM_UTF8):
        return raw[3:].decode("utf-8"), "utf-8 with BOM"
    if raw.startswith(codecs.BOM_UTF16_LE) or raw.startswith(codecs.BOM_UTF16_BE):
        return raw.decode("utf-16"), "utf-16"
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace"), "cp1252 (not UTF-8; read as Windows Latin-1)"


def sniff_delimiter(sample: str) -> str:
    lines = [ln for ln in sample.splitlines()[:50] if ln.strip()]
    best, score = ",", -1
    for d in (",", ";", "\t", "|"):
        counts = [len(next(csv.reader([ln], delimiter=d))) for ln in lines]
        if not counts or max(counts) < 2:
            continue
        # The delimiter that splits most lines into the same number of fields, more than one.
        common = max(set(counts), key=counts.count)
        s = counts.count(common) * 10 + common
        if common > 1 and s > score:
            best, score = d, s
    return best


def read_csv(path: str, header: int | None, limit: int | None) -> Table:
    with open(path, "rb") as f:
        raw = f.read()
    text, enc = decode(raw)
    if "\x00" in text[:4096]:
        raise Stop(2, f"{path} looks binary, not a CSV - the document-reading skill's doc.py inspect names what it is")
    delim = sniff_delimiter(text[:65536])
    notes = [f"encoding {enc}", "delimiter " + {",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe"}[delim]]
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delim)
    all_rows = []
    for i, r in enumerate(reader, start=1):
        all_rows.append((i, r))
        if limit and len(all_rows) > limit + 50:
            notes.append(f"stopped after {limit} rows (--limit)")
            break
    return build(all_rows, header, path, notes)


def read_json(path: str, limit: int | None) -> Table:
    with open(path, "rb") as f:
        text, _ = decode(f.read())
    records = None
    try:
        data = json.loads(text)
        if isinstance(data, list):
            records = data
        elif isinstance(data, dict):
            lists = [(k, v) for k, v in data.items() if isinstance(v, list) and v and isinstance(v[0], dict)]
            if lists:
                records = lists[0][1]
    except ValueError:
        try:
            records = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
        except ValueError as e:
            raise Stop(2, f"{path} is neither JSON nor JSON lines: {e}") from None
    if not records or not all(isinstance(r, dict) for r in records[:100]):
        raise Stop(2, f"{path}: expected a list of objects (records), or an object holding one")
    headers: list[str] = []
    for r in records:
        for k in r:
            if k not in headers:
                headers.append(k)
    rows = []
    for r in records[: limit or None]:
        rows.append([flat(r.get(h)) for h in headers])
    return Table(headers, rows, list(range(1, len(rows) + 1)), path, ["JSON records; row = record number"])


def flat(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return v


def read_xlsx(path: str, sheet: str | None, header: int | None, limit: int | None) -> Table:
    try:
        import openpyxl  # noqa: F401
    except ImportError:
        return read_xlsx_via_doc(path, sheet, header, limit)
    import warnings
    import openpyxl
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        except Exception as e:  # noqa: BLE001
            raise Stop(2, f"cannot open {path} as a workbook ({type(e).__name__}: {e}) - doc.py inspect says why") from None
    names = wb.sheetnames
    if sheet is None:
        ws = wb[names[0]]
        notes = [f"sheet \"{names[0]}\" (the first of {len(names)}: {', '.join(names)})" if len(names) > 1 else f"sheet \"{names[0]}\""]
    else:
        pick = names[int(sheet) - 1] if sheet.isdigit() and 0 < int(sheet) <= len(names) else sheet
        if pick not in names:
            raise Stop(1, f"no sheet {sheet!r}; sheets are: {', '.join(names)}")
        ws = wb[pick]
        notes = [f"sheet \"{pick}\""]
    all_rows = []
    for i, r in enumerate(ws.iter_rows(values_only=True), start=1):
        all_rows.append((i, ["" if c is None else c for c in r]))
        if limit and len(all_rows) > limit + 50:
            notes.append(f"stopped after {limit} rows (--limit)")
            break
    wb.close()
    notes.append("values as last saved by Excel (formulas never calculated show empty - doc.py inspect flags them)")
    return build(all_rows, header, path, notes)


def read_xlsx_via_doc(path: str, sheet: str | None, header: int | None, limit: int | None) -> Table:
    here = os.path.dirname(os.path.abspath(__file__))
    doc = os.path.normpath(os.path.join(here, "..", "..", "document-reading", "scripts", "doc.py"))
    if not os.path.exists(doc):
        raise Stop(3, "reading .xlsx needs openpyxl (`pip install openpyxl`) or the document-reading skill's doc.py; "
                      "or convert the sheet to CSV first")
    out = os.path.join(tempfile.mkdtemp(prefix="sheet-"), "sheet.csv")
    cmd = [sys.executable, doc, "extract", path, "--format", "csv", "--out", out] + (["--sheet", sheet] if sheet else [])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise Stop(2, f"doc.py could not extract the sheet: {(r.stderr or r.stdout).strip()[:300]}")
    t = read_csv(out, header, limit)
    t.source = path
    t.notes = ["read through document-reading's doc.py (openpyxl not installed); row numbers are the CSV's lines"] + t.notes
    return t


def build(all_rows: list[tuple[int, list]], header: int | None, path: str, notes: list[str]) -> Table:
    nonempty = [(i, r) for i, r in all_rows if any(str(c).strip() for c in r)]
    if not nonempty:
        raise Stop(2, f"{path} has no data rows")
    if header is None:
        # The header is the first row that is at least half as wide as the widest of the next rows: a title line
        # ("Laporan Penjualan 2026") above the real header is skipped and said.
        width = max(sum(1 for c in r if str(c).strip()) for _, r in nonempty[:30])
        hdr_i, hdr = next((i, r) for i, r in nonempty if sum(1 for c in r if str(c).strip()) >= max(2, width // 2) or width < 2)
        if hdr_i != nonempty[0][0]:
            notes.append(f"header taken from row {hdr_i} (rows above it look like a title; --header N to choose)")
    else:
        match = [(i, r) for i, r in all_rows if i == header]
        if not match:
            raise Stop(1, f"--header {header}: the file has no row {header}")
        hdr_i, hdr = match[0]
    # Trailing empty columns (Excel's padding) are dropped.
    width = len(hdr)
    while width and not str(hdr[width - 1]).strip() and not any(len(r) >= width and str(r[width - 1]).strip() for i, r in all_rows if i > hdr_i):
        width -= 1
    headers = []
    for j in range(width):
        h = re.sub(r"\s+", " ", str(hdr[j]).strip()) if j < len(hdr) else ""
        headers.append(h or f"column_{j + 1}")
    rows, nums = [], []
    for i, r in all_rows:
        if i <= hdr_i:
            continue
        cells = list(r[:width]) + [""] * max(0, width - len(r))
        if not any(str(c).strip() for c in cells):
            continue
        if len(r) > width and any(str(c).strip() for c in r[width:]):
            notes.append(f"row {i} has more cells than the header - the extra ones are ignored")
        rows.append(cells)
        nums.append(i)
    return Table(headers, rows, nums, path, notes)


# ---------------------------------------------------------------- understanding cells

CUR = r"(?:rp\.?|idr|usd|us\$|\$|eur|€|sgd|s\$|myr|rm|£|¥)"
NUM_CORE = re.compile(r"^[+-]?\d[\d.,'  ]*$")


def is_null(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip().lower() in NULLS)


def strip_number(s: str) -> tuple[str, dict]:
    """The bare digits of a cell that is meant as a number, and what was around them (currency, %, negative)."""
    info = {}
    t = s.strip().replace("−", "-")
    if t.startswith("(") and t.endswith(")"):
        info["neg"] = True
        t = t[1:-1].strip()
    m = re.match(rf"^({CUR})\s*", t, re.I)
    if m:
        info["currency"] = m.group(1).lower().rstrip(".")
        t = t[m.end():]
    m = re.search(rf"\s*({CUR})$", t, re.I)
    if m:
        info["currency"] = m.group(1).lower()
        t = t[: m.start()]
    if t.endswith("%"):
        info["percent"] = True
        t = t[:-1].strip()
    if t.endswith("-") and t[:-1].strip() and t[0] != "-":
        info["neg"] = True
        t = t[:-1]
    if t.startswith("-"):
        info["neg"] = not info.get("neg")
        t = t[1:].strip()
    elif t.startswith("+"):
        t = t[1:].strip()
    m = re.search(r"\s*(jt|juta|rb|ribu|k|mn|mio\.?|million|mrd\.?|miliar|milyar|billion|bn|triliun|lakh|lac|crore|cr)$", t, re.I)
    if m and re.search(r"\d$", t[: m.start()]):
        info["suffix"] = m.group(1).lower().rstrip(".")
        t = t[: m.start()]
    return t.replace(" ", " "), info


def number_style(t: str) -> str:
    """How one bare number is written: 'comma' (1.234,56), 'dot' (1,234.56), 'int', 'ambiguous' (1.234 or 1,234), 'no'."""
    t = t.replace(" ", "").replace("'", "")
    if not t or not re.match(r"^\d[\d.,]*$", t):
        return "no"
    if re.match(r"^\d+$", t):
        return "int"
    if re.match(r"^\d{1,3}(\.\d{3})+,\d+$", t) or re.match(r"^\d{1,3}(\.\d{3}){2,}$", t):
        return "comma"
    if re.match(r"^\d{1,3}(,\d{3})+\.\d+$", t) or re.match(r"^\d{1,3}(,\d{3}){2,}$", t):
        return "dot"
    if re.match(r"^\d+,\d+$", t):
        return "ambiguous" if re.match(r"^\d{1,3},\d{3}$", t) else "comma"
    if re.match(r"^\d+\.\d+$", t):
        return "ambiguous" if re.match(r"^\d{1,3}\.\d{3}$", t) else "dot"
    return "no"


# Word suffixes whose size does not depend on the language. A bare "M", "B" or "T" is left as not-a-number on purpose:
# M is a million in English and Spanish but a billion (miliar) in Indonesian, and T is a thousand or a trillion.
MULT = {"jt": 1e6, "juta": 1e6, "rb": 1e3, "ribu": 1e3, "k": 1e3, "mn": 1e6, "mio": 1e6, "million": 1e6, "mrd": 1e9,
        "miliar": 1e9, "milyar": 1e9, "billion": 1e9, "bn": 1e9, "triliun": 1e12, "lakh": 1e5, "lac": 1e5,
        "crore": 1e7, "cr": 1e7}


def to_number(v, decimal: str):
    """A cell as a float, or None. `decimal` is 'comma' or 'dot': the column's convention."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if not isinstance(v, str):
        return None
    t, info = strip_number(v)
    t = t.replace(" ", "").replace("'", "")
    if not re.match(r"^\d[\d.,]*$", t):
        return None
    style = number_style(t)
    if style == "no":
        return None
    if decimal == "comma":
        if style == "dot":
            return None
        t = t.replace(".", "").replace(",", ".")
    else:
        if style == "comma":
            return None
        t = t.replace(",", "")
    try:
        x = float(t)
    except ValueError:
        return None
    if "suffix" in info:
        # "M" is "million" in English and "miliar" (10^9) in Indonesian: the comma convention decides.
        x *= MULT[info["suffix"]]
    if info.get("neg"):
        x = -x
    return x


DATE_PATTERNS = [
    (re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?"), "ymd"),
    (re.compile(r"^(\d{4})/(\d{1,2})/(\d{1,2})$"), "ymd"),
    (re.compile(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$"), "ab-y"),
    (re.compile(r"^(\d{1,2})\.?[\s-]+([^\W\d_]+)\.?[\s-]+(\d{4})$"), "d-mon-y"),
    (re.compile(r"^([^\W\d_]+)\.?\s+(\d{1,2}),?\s+(\d{4})$"), "mon-d-y"),
    (re.compile(r"^([^\W\d_]+)\.?[\s-]+(\d{4})$"), "mon-y"),
]


def date_parts(v) -> tuple[str, tuple] | None:
    """('ab-y', (a, b, y, time)) etc. - the raw parts, before deciding which of a/b is the day."""
    if isinstance(v, dt.datetime):
        return "dt", (v,)
    if isinstance(v, dt.date):
        return "dt", (dt.datetime(v.year, v.month, v.day),)
    if not isinstance(v, str):
        return None
    s = v.strip()
    for rx, kind in DATE_PATTERNS:
        m = rx.match(s)
        if m:
            return kind, m.groups()
    return None


def to_date(v, dayfirst: bool):
    p = date_parts(v)
    if not p:
        return None
    kind, g = p
    try:
        if kind == "dt":
            return g[0]
        if kind == "ymd":
            y, mo, d = int(g[0]), int(g[1]), int(g[2])
            t = [int(x) for x in g[3:6] if x] if len(g) > 3 else []
        elif kind == "ab-y":
            a, b, y = int(g[0]), int(g[1]), int(g[2])
            if y < 100:
                y += 2000 if y < 70 else 1900
            d, mo = (a, b) if dayfirst else (b, a)
            t = [int(x) for x in g[3:6] if x]
        elif kind == "d-mon-y":
            d, mo, y = int(g[0]), MONTHS.get(g[1].lower()), int(g[2])
            t = []
        elif kind == "mon-d-y":
            mo, d, y = MONTHS.get(g[0].lower()), int(g[1]), int(g[2])
            t = []
        else:  # mon-y
            mo, d, y = MONTHS.get(g[0].lower()), 1, int(g[1])
            t = []
        if not mo:
            return None
        return dt.datetime(y, mo, d, *(t + [0, 0, 0])[:3])
    except (ValueError, TypeError):
        return None


BOOLS = {"ya": True, "y": True, "yes": True, "true": True, "benar": True, "tidak": False, "t": False,
         "no": False, "n": False, "false": False, "salah": False}


class Column:
    """What a column holds, decided from all its values: its kind, its number convention, its date order."""

    def __init__(self, name: str, values: list, hint_decimal: str = "auto", hint_dates: str = "auto"):
        self.name = name
        self.values = values
        self.notes: list[str] = []
        filled = [v for v in values if not is_null(v)]
        self.filled = filled
        self.ambiguous = False
        self.dates_ambiguous = False
        self.separators = False
        self.decimal = self._decimal(filled, hint_decimal)
        self.dayfirst = self._dayfirst(filled, hint_dates)
        self.kind = self._kind(filled)

    def _decimal(self, filled, hint):
        if hint in ("comma", "dot"):
            return hint
        votes = {"comma": 0, "dot": 0, "ambiguous": 0}
        for v in filled[:20000]:
            if isinstance(v, str):
                st = number_style(strip_number(v)[0])
                if st in votes:
                    votes[st] += 1
        self.separators = votes["comma"] + votes["dot"] > 0
        if votes["comma"] and votes["dot"]:
            self.notes.append(f"numbers written both ways: {votes['comma']} like 1.234,56 and {votes['dot']} like 1,234.56 - "
                              "check the source; the majority is used")
        if votes["comma"] > votes["dot"]:
            return "comma"
        if votes["dot"] > votes["comma"]:
            return "dot"
        if votes["ambiguous"]:
            # 1.250 is one thousand two hundred and fifty in Jakarta and Berlin, one and a quarter in London. Nothing in
            # this column says which, so it is not decided here: the caller asks, or checks against a known total.
            self.ambiguous = True
            hint_text = (" Another column in this file is written 1.234,56, which points to thousands." if hint == "auto-id"
                         else " Another column in this file is written 1,234.56, which points to decimals." if hint == "auto-en" else "")
            self.notes.append("AMBIGUOUS: values like 1.250 or 1,250 only - thousands or decimals?" + hint_text +
                              " Ask the person or check a known total, then pass --decimal comma (1.250 = 1250) or --decimal dot (1.250 = 1.25)")
            return "comma" if hint == "auto-id" else "dot"
        return "dot"

    def _dayfirst(self, filled, hint):
        if hint in ("dayfirst", "monthfirst"):
            return hint == "dayfirst"
        a_over, b_over, n = 0, 0, 0
        for v in filled[:20000]:
            p = date_parts(v)
            if p and p[0] == "ab-y":
                n += 1
                a, b = int(p[1][0]), int(p[1][1])
                a_over += a > 12
                b_over += b > 12
        if not n:
            return True
        if a_over and b_over:
            self.notes.append(f"dates written both dd/mm and mm/dd ({a_over} with day first, {b_over} with month first) - fix at the source")
        if b_over > a_over:
            return False
        if not a_over and not b_over:
            self.dates_ambiguous = True
            self.notes.append("AMBIGUOUS dates: every one has day and month both 12 or under, so 03/04 could be 3 April or "
                              "March 4. Ask where the data comes from, then pass --dates dayfirst or --dates monthfirst")
        return True

    def _kind(self, filled):
        if not filled:
            return "empty"
        n = len(filled)
        sample = filled[:20000]
        k = len(sample)
        codes = sum(1 for v in sample if isinstance(v, str) and re.match(r"^(0\d+|\+\d{6,})$", v.strip()))
        if codes and codes >= 0.5 * k:
            return "code"   # leading zeros or + : NIK, postal code, phone - text, never a number
        nums = sum(1 for v in sample if to_number(v, self.decimal) is not None)
        dates = sum(1 for v in sample if to_date(v, self.dayfirst) is not None)
        bools = sum(1 for v in sample if isinstance(v, bool) or (isinstance(v, str) and v.strip().lower() in BOOLS))
        if dates >= 0.8 * k and dates >= nums:
            return "date"
        if nums >= 0.8 * k:
            ints = all(float(x).is_integer() for x in (to_number(v, self.decimal) for v in sample) if x is not None)
            return "integer" if ints else "decimal"
        if bools >= 0.9 * k:
            return "boolean"
        if nums >= 0.3 * k:
            return "mixed"
        _ = n
        return "text"

    def number(self, v):
        return None if is_null(v) else to_number(v, self.decimal)

    def date(self, v):
        return None if is_null(v) else to_date(v, self.dayfirst)


def fmt_num(x: float, style: str = "en") -> str:
    """1234567.891 -> '1,234,567.89' (en) or '1.234.567,89' (id). Integers lose their decimals."""
    if x is None:
        return ""
    if float(x).is_integer() and abs(x) < 1e15:
        s = f"{int(x):,}"
    else:
        s = f"{x:,.2f}" if abs(x) >= 1 else f"{x:.4g}"
    if style == "id":
        s = s.replace(",", "\u0000").replace(".", ",").replace("\u0000", ".")
    return s


TOTAL_CELL = re.compile(r"^\s*(grand\s+)?(total|sub\s*-?\s*total|subtotal|summe|gesamt|insgesamt|somme|suma|totale|totaal|"
                        r"totalt|jumlah|rekap|keseluruhan|合計|总计|合计)\b.{0,30}$", re.I)


def is_total_row(cells: list) -> bool:
    """A Total/Jumlah row inside the data: the word in one of the first cells, or alone in a mostly empty row."""
    if any(isinstance(c, str) and TOTAL_WORDS.match(c) for c in cells[:3]):
        return True
    filled = [c for c in cells if str(c).strip()]
    return len(filled) <= max(2, len(cells) // 2) and any(isinstance(c, str) and TOTAL_CELL.match(c) for c in filled)


def columns(table: Table, decimal: str = "auto", dates: str = "auto") -> list[Column]:
    """Every column understood. Numbers like 1.234 that could be either convention follow the rest of the file: one
    column written 1.234,56 makes the whole file Indonesian-style."""
    cols = [Column(h, [r[j] for r in table.rows], decimal, dates) for j, h in enumerate(table.headers)]
    if decimal == "auto":
        clear = [c.decimal for c in cols if c.kind in ("integer", "decimal", "mixed") and not c.ambiguous and c.separators]
        hint = "auto-id" if clear and all(d == "comma" for d in clear) else "auto-en" if clear and all(d == "dot" for d in clear) else "auto"
        if hint != "auto":
            cols = [Column(c.name, c.values, hint, dates) if c.ambiguous else c for c in cols]
    return cols


def refuse_ambiguous(cols: list, used: list[int], decimal: str, dates: str) -> None:
    """Stop before computing on a column whose numbers or dates could be read two ways."""
    for j in used:
        c = cols[j]
        if c.ambiguous and decimal == "auto" and c.kind in ("integer", "decimal", "mixed"):
            raise Stop(1, f'column "{c.name}": {c.notes[-1] if c.notes else "ambiguous numbers"}')
        if c.dates_ambiguous and dates == "auto" and c.kind == "date":
            raise Stop(1, f'column "{c.name}": every date reads two ways (03/04). Pass --dates dayfirst or --dates monthfirst '
                          "after checking where the data comes from")


def find_column(table: Table, name: str) -> int:
    """A column by its header (exact, then case- and space-insensitive) or by its 1-based number or letter."""
    if name in table.headers:
        return table.headers.index(name)
    key = re.sub(r"[\s_]+", " ", name).strip().lower()
    for j, h in enumerate(table.headers):
        if re.sub(r"[\s_]+", " ", h).strip().lower() == key:
            return j
    if name.isdigit() and 0 < int(name) <= len(table.headers):
        return int(name) - 1
    raise Stop(1, f"no column {name!r}. Columns: " + ", ".join(f'"{h}"' for h in table.headers))
