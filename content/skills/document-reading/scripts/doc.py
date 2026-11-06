#!/usr/bin/env python3
"""
doc.py - see what is inside a document, or pull part of it out to a file.

    python3 doc.py inspect FILE [--json] [--sheet NAME|N]
    python3 doc.py extract FILE [--sheet NAME|N] [--range A1:H200 | --rows 1-500] [--table N]
                                [--pages 3-5] [--format csv|tsv|md] [--formulas] [--changes] [--out PATH]
    python3 doc.py query FILE ["SELECT ... FROM t ..."] [--sheet NAME|N] [--header N] [--schema] [--limit 50] [--out CSV]

`query` streams a sheet or CSV once into a SQLite file under $TMPDIR/doc-query (reused while the file is unchanged)
and prints only the answer, capped - counts, sums, filters and joins over a big sheet without loading it into memory.

The type is decided by the bytes, never the extension: a `.xls` that is really HTML or CSV, a
`.docx` with macros, a password-protected Office file and a file cut off in transfer are all named
for what they are. Every format is read with the standard library except PDF (pypdf, or poppler's
pdftotext/pdfinfo) and the legacy binary formats (.xls/.doc/.ppt/.xlsb, which LibreOffice converts).

`extract` always writes a file (in $TMPDIR/doc-extract unless --out says otherwise) and prints
only where it went and how big it is - read that file in pages, or grep it.

Exit codes: 0 done; 1 usage; 2 the file cannot be read as it is (empty, damaged, encrypted);
3 a program or library is missing (the message says which, and how to get it). Never a traceback
(set DOC_DEBUG=1 to see one).
"""

from __future__ import annotations

import argparse
import codecs
import csv
import datetime as dt
import email
import json
import mmap
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import zlib
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

MAX_PART = 1 << 30  # an Office part that unpacks past 1 GiB is a zip bomb, not a document
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
LIBREOFFICE = ("LibreOffice: `nouride pkg install libreoffice` on a Nouride host, `brew install --cask libreoffice`, "
               "`apt install libreoffice-calc libreoffice-writer`, `apk add libreoffice`")
ENCRYPTED_OOXML = (
    "password-protected Office file (an encrypted .xlsx/.docx/.pptx inside an OLE container) - nothing can be read "
    "without the password. Ask for it or for an unprotected copy; with it: `pip install msoffcrypto-tool` then "
    "`msoffcrypto-tool -p PASSWORD in.xlsx \"$TMPDIR/open.xlsx\"`"
)


class Refused(Exception):
    """The file cannot be read as it is - exit 2."""


class Missing(Exception):
    """A program or library this needs is not installed - exit 3."""


# ---------------------------------------------------------------- small helpers


def local(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def attr(el, name):
    value = el.get(name)
    if value is not None:
        return value
    suffix = "}" + name
    for key, val in el.attrib.items():
        if key.endswith(suffix):
            return val
    return None


def rel_id(el):
    """The `r:id` of an element - never its plain `id`, which <sldId> also carries."""
    return next((v for k, v in el.attrib.items() if k.startswith("{") and k.endswith("}id")), None)


def col_letters(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def col_number(letters):
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def parse_ref(ref):
    m = re.match(r"^\$?([A-Za-z]{1,3})\$?(\d+)$", ref.strip())
    if not m:
        raise ValueError(ref)
    return int(m.group(2)), col_number(m.group(1))


def parse_bounds(text):
    """'A1:H200' / 'B3' / 'A:H' -> (r1, c1, r2, c2); None for an open end."""
    text = text.strip().replace("$", "")
    m = re.match(r"^([A-Za-z]{1,3}):([A-Za-z]{1,3})$", text)
    if m:
        return None, col_number(m.group(1)), None, col_number(m.group(2))
    first, _, last = text.partition(":")
    r1, c1 = parse_ref(first)
    r2, c2 = parse_ref(last) if last else (r1, c1)
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


def parse_span(text):
    m = re.match(r"^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$", text or "")
    if not m:
        raise ValueError(text)
    a = int(m.group(1))
    b = m.group(2)
    return a, (int(b) if b else (None if text.strip().endswith("-") else a))


def is_number(v):
    return bool(re.fullmatch(r"[-+]?(\d{1,3}([.,\s]\d{3})*|\d+)([.,]\d+)?([eE][-+]?\d+)?%?|[-+]?[.,]\d+", v.strip()))


def short(v, n=24):
    v = " ".join(str(v).split())
    return v if len(v) <= n else v[: n - 1] + "~"


def tmpdir():
    return os.environ.get("TMPDIR") or tempfile.gettempdir()


def slug(name):
    return re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("_") or "sheet"


def lock_files(path):
    """Owner files Excel, Word and LibreOffice leave beside a document while it is open."""
    folder, base = os.path.split(os.path.abspath(path))
    names = {"~$" + base, "~$" + base[2:], ".~lock." + base + "#"}
    return sorted(n for n in names if os.path.exists(os.path.join(folder, n)))


def soffice():
    for name in ("libreoffice", "soffice"):
        found = shutil.which(name)
        if found:
            return found
    for path in ("/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/lib/libreoffice/program/soffice",
                 r"C:\Program Files\LibreOffice\program\soffice.exe"):
        if os.path.exists(path):
            return path
    return None


def libreoffice_convert(path, target):
    """Convert with a private profile: a LibreOffice the person has open would otherwise swallow the job silently."""
    office = soffice()
    if not office:
        raise Missing(f"this is a legacy binary format and reading it needs {LIBREOFFICE}")
    outdir = tempfile.mkdtemp(prefix="convert-", dir=ensure_dir(os.path.join(tmpdir(), "doc-extract")))
    profile = "file://" + os.path.join(outdir, ".profile").replace("\\", "/")
    try:
        subprocess.run([office, f"-env:UserInstallation={profile}", "--headless", "--convert-to", target, "--outdir", outdir, path],
                       capture_output=True, timeout=300, check=False)
    except subprocess.TimeoutExpired:
        raise Refused("LibreOffice did not finish converting it in 5 minutes") from None
    stem = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(outdir, stem + "." + target.split(":")[0])
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        raise Refused("LibreOffice could not convert it - it may be password-protected or damaged")
    return out


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)
    return path


# ---------------------------------------------------------------- zip containers


class Pkg:
    """A zip container; a damaged part becomes a plain refusal, never a traceback."""

    def __init__(self, path):
        try:
            self.z = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError) as e:
            raise Refused(f"damaged or truncated zip container ({e}) - usually a copy cut off in transfer or a download "
                          "that did not finish; get the file again") from None
        infos = self.z.infolist()
        self.names = {i.filename for i in infos}
        locked = [i.filename for i in infos if i.flag_bits & 0x1]
        if locked:
            raise Refused(f"zip with password-encrypted entries ({len(locked)} of {len(infos)}) - ask for the password "
                          "or an unprotected copy")
        big = next((i for i in infos if i.file_size > MAX_PART), None)
        if big:
            raise Refused(f"part {big.filename} unpacks to {big.file_size >> 20} MB - not something to unpack blindly")
        self.sizes = {i.filename: i.file_size for i in infos}

    def has(self, name):
        return name in self.names

    def read(self, name):
        try:
            return self.z.read(name)
        except (zipfile.BadZipFile, zlib.error, EOFError, KeyError, OSError) as e:
            raise Refused(f"part {name} is damaged ({e}) - the file is corrupt; get a fresh copy") from None

    def xml(self, name):
        try:
            return ET.fromstring(self.read(name))
        except ET.ParseError as e:
            raise Refused(f"part {name} is not well-formed XML ({e}) - the file is corrupt") from None

    def iterparse(self, name, events=("end",)):
        try:
            with self.z.open(name) as fh:
                for item in ET.iterparse(fh, events=events):
                    yield item
        except (zipfile.BadZipFile, zlib.error, EOFError, OSError) as e:
            raise Refused(f"part {name} is damaged ({e}) - the file is corrupt; get a fresh copy") from None
        except ET.ParseError as e:
            raise Refused(f"part {name} is not well-formed XML ({e}) - the file is corrupt") from None

    def rels(self, part):
        """{id: (type, path, external)} for one part's relationships."""
        folder, base = posixpath.split(part)
        rp = posixpath.join(folder, "_rels", base + ".rels")
        out = {}
        if not self.has(rp):
            return out
        for el in self.xml(rp):
            target = el.get("Target", "")
            external = el.get("TargetMode") == "External"
            if external:
                path = target
            elif target.startswith("/"):
                path = target.lstrip("/")
            else:
                path = posixpath.normpath(posixpath.join(folder, target))
            out[el.get("Id")] = (el.get("Type", "").rsplit("/", 1)[-1], path, external)
        return out

    def related(self, part, kind):
        return [p for t, p, ext in self.rels(part).values() if t == kind and not ext and self.has(p)]

    def content_type(self, part):
        if not self.has("[Content_Types].xml"):
            return ""
        for el in self.xml("[Content_Types].xml"):
            if el.get("PartName", "").lstrip("/") == part:
                return el.get("ContentType", "")
        return ""


def zip_kind(pkg):
    if pkg.has("mimetype"):
        mime = pkg.read("mimetype").decode("ascii", "replace").strip()
        for prefix, kind in (("application/vnd.oasis.opendocument.spreadsheet", "ods"),
                             ("application/vnd.oasis.opendocument.text", "odt"),
                             ("application/vnd.oasis.opendocument.presentation", "odp"),
                             ("application/epub+zip", "epub")):
            if mime.startswith(prefix):
                return kind, None
    main = next((p for t, p, ext in pkg.rels("").values() if t == "officeDocument" and not ext), None)
    if not main or not pkg.has(main):
        main = next((p for p in ("xl/workbook.xml", "word/document.xml", "ppt/presentation.xml") if pkg.has(p)), None)
    if main:
        ctype = pkg.content_type(main)
        macro = "macroEnabled" in ctype or any(n.endswith("vbaProject.bin") for n in pkg.names)
        if main.endswith(".bin"):
            return "xlsb", main
        if main.startswith("xl/") or "spreadsheetml" in ctype:
            return ("xlsm" if macro else "xlsx"), main
        if main.startswith("word/") or "wordprocessingml" in ctype:
            return ("docm" if macro else "docx"), main
        if main.startswith("ppt/") or "presentationml" in ctype:
            return ("pptm" if macro else "pptx"), main
    return "zip", None


# ---------------------------------------------------------------- type detection


def ole_kind(path):
    with open(path, "rb") as fh:
        try:
            m = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        except (ValueError, OSError):
            return "ole"
        with m:
            def has(name):
                return m.find(name.encode("utf-16-le")) != -1
            if has("EncryptedPackage"):
                raise Refused(ENCRYPTED_OOXML)
            for name, kind in (("Workbook", "xls"), ("WordDocument", "doc"), ("PowerPoint Document", "ppt"),
                               ("__substg1.0_", "msg"), ("Book", "xls")):
                if has(name):
                    return kind
    return "ole"


BOMS = ((codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"), (codecs.BOM_UTF8, "utf-8-sig"),
        (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16"))


def decode_sample(raw):
    """(text, encoding) for a sample that is text, (None, None) for one that is not."""
    for bom, enc in BOMS:
        if raw.startswith(bom):
            return raw.decode(enc, "ignore"), enc
    if b"\x00" in raw:
        even, odd, n = raw[0::2].count(0), raw[1::2].count(0), len(raw)
        if odd > n // 4 and even < n // 50:
            return raw.decode("utf-16-le", "ignore"), "utf-16-le"
        if even > n // 4 and odd < n // 50:
            return raw.decode("utf-16-be", "ignore"), "utf-16-be"
        return None, None
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError as e:
        if e.start >= len(raw) - 3:
            return raw[: e.start].decode("utf-8", "ignore"), "utf-8"
    text = raw.decode("cp1252", "replace")
    control = sum(1 for ch in text if ord(ch) < 32 and ch not in "\t\r\n\f")
    if control > len(text) // 20:
        return None, None
    return text, "cp1252"


def detect(path):
    """(kind, facts) - from the content, never the name."""
    if not os.path.exists(path):
        raise Refused("no such file")
    if os.path.isdir(path):
        raise Refused("that is a directory, not a document")
    size = os.path.getsize(path)
    facts = {"size": size}
    if size == 0:
        raise Refused("the file is empty (0 bytes) - nothing was saved into it, or the copy failed; get it again")
    with open(path, "rb") as fh:
        head = fh.read(65536)
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"):
        pkg = Pkg(path)
        kind, main = zip_kind(pkg)
        facts.update(pkg=pkg, main=main)
        return kind, facts
    if b"%PDF-" in head[:1024]:
        return "pdf", facts
    if head.startswith(OLE):
        return ole_kind(path), facts
    if head.startswith(b"{\\rtf"):
        return "rtf", facts
    text, enc = decode_sample(head)
    if text is None:
        facts["magic"] = head[:8].hex(" ")
        if head[:2] == b"PK":
            raise Refused("starts like a zip but is not a valid one - damaged or truncated; get the file again")
        return "binary", facts
    facts["encoding"] = enc
    low = text.lstrip("\ufeff \t\r\n").lower()
    if "urn:schemas-microsoft-com:office:spreadsheet" in low[:8000]:
        return "spreadsheetml", facts
    if low.startswith("mime-version") or "content-type: multipart/related" in low[:4000]:
        return "mhtml", facts
    if low.startswith(("<!doctype html", "<html")) or "<table" in low[:8000] or "<html" in low[:2000]:
        return "html", facts
    return "text", facts


EXPECTED = {"xlsx": "xlsx", "xlsm": "xlsm", "xltx": "xlsx", "xltm": "xlsm", "xls": "xls", "docx": "docx", "docm": "docm",
            "dotx": "docx", "doc": "doc", "pptx": "pptx", "pptm": "pptm", "ppt": "ppt", "pdf": "pdf", "ods": "ods",
            "odt": "odt", "odp": "odp", "epub": "epub", "rtf": "rtf", "csv": "text", "tsv": "text", "txt": "text",
            "html": "html", "htm": "html", "xlsb": "xlsb"}


# ---------------------------------------------------------------- spreadsheet readers
# Each reader has `.sheets` (dicts with at least "name") and `.rows(index, stats, formulas)`, a generator of
# (row number, {column number: text}) for every row that holds something, in order.


def scan(rows, keep=12):
    g = {"rows": 0, "cells": 0, "r1": None, "r2": 0, "c1": None, "c2": 0}
    sample = []
    for r, cells in rows:
        g["rows"] += 1
        g["cells"] += len(cells)
        g["r1"] = r if g["r1"] is None else min(g["r1"], r)
        g["r2"] = max(g["r2"], r)
        lo, hi = min(cells), max(cells)
        g["c1"] = lo if g["c1"] is None else min(g["c1"], lo)
        g["c2"] = max(g["c2"], hi)
        if len(sample) < keep:
            sample.append((r, cells))
    return g, sample


def guess_header(sample, frozen_row=None):
    if frozen_row and any(r == frozen_row for r, _ in sample):
        return frozen_row
    if not sample:
        return None
    widest = max(len(c) for _, c in sample)
    for r, cells in sample:
        values = [v for v in cells.values() if v != ""]
        if len(values) >= max(2, widest * 0.5) and all(not is_number(v) for v in values):
            return r
    return None


DATE_IDS = set(range(14, 23)) | set(range(27, 37)) | {45, 46, 47} | set(range(50, 59))


def is_date_format(fmt_id, code):
    if code is None:
        return fmt_id in DATE_IDS
    if re.search(r"\[(h+|m+|s+)\]", code, re.I):
        return False  # elapsed time, a duration rather than a date
    stripped = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", code)
    return code.lower() != "general" and bool(re.search(r"[dmyhs]", stripped, re.I))


def excel_date(value, date1904):
    try:
        f = float(value)
    except ValueError:
        return value
    if f < 0 or f > 2958465:
        return value
    if f < 1 and not date1904:
        secs = round(f * 86400)
        return f"{secs // 3600:02d}:{secs % 3600 // 60:02d}:{secs % 60:02d}"
    if not date1904 and f < 60:
        f += 1  # Excel counts a 29 February 1900 that never was
    base = dt.datetime(1904, 1, 1) if date1904 else dt.datetime(1899, 12, 30)
    d = base + dt.timedelta(seconds=round(f * 86400))
    return d.date().isoformat() if d.time() == dt.time(0) else d.isoformat(sep=" ")


def run_text(el):
    """Text of an OOXML string item (<si>, <is>), without phonetic runs."""
    out = []
    for ch in el:
        t = local(ch.tag)
        if t == "t":
            out.append(ch.text or "")
        elif t == "r":
            out.extend(g.text or "" for g in ch if local(g.tag) == "t")
    return "".join(out)


class Xlsx:
    def __init__(self, pkg, main):
        self.pkg, self.main = pkg, main
        root = pkg.xml(main)
        rels = pkg.rels(main)
        self.date1904 = False
        self.sheets, self.names = [], []
        self.protected = False
        self.calc = {}
        for el in root.iter():
            t = local(el.tag)
            if t == "workbookPr":
                self.date1904 = el.get("date1904") in ("1", "true")
            elif t == "sheet":
                typ, path, _ = rels.get(rel_id(el), ("", None, False))
                self.sheets.append({"name": el.get("name"), "state": el.get("state") or "visible", "kind": typ, "path": path})
            elif t == "definedName":
                self.names.append({"name": el.get("name"), "refers to": (el.text or "").strip(),
                                   **({"sheet": int(el.get("localSheetId")) + 1} if el.get("localSheetId") else {}),
                                   **({"hidden": True} if el.get("hidden") in ("1", "true") else {})})
            elif t == "workbookProtection" and any(el.get(k) in ("1", "true") for k in ("lockStructure", "lockWindows")):
                self.protected = True
            elif t == "calcPr":
                self.calc = dict(el.attrib)
        self.sst_path = next(iter(pkg.related(main, "sharedStrings")), None)
        self.styles_path = next(iter(pkg.related(main, "styles")), None)
        self._sst = None
        self._dates = None

    def sst(self):
        if self._sst is None:
            self._sst = []
            if self.sst_path:
                for _, el in self.pkg.iterparse(self.sst_path):
                    if local(el.tag) == "si":
                        self._sst.append(run_text(el))
                        el.clear()
        return self._sst

    def dates(self):
        if self._dates is None:
            self._dates = []
            if self.styles_path:
                root = self.pkg.xml(self.styles_path)
                codes = {int(el.get("numFmtId", "0")): el.get("formatCode", "") for el in root.iter() if local(el.tag) == "numFmt"}
                xfs = next((el for el in root if local(el.tag) == "cellXfs"), None)
                for xf in list(xfs) if xfs is not None else []:
                    fid = int(xf.get("numFmtId", "0") or 0)
                    self._dates.append(is_date_format(fid, codes.get(fid)))
        return self._dates

    def rows(self, index, stats=None, formulas=False):
        sheet = self.sheets[index]
        st = stats if stats is not None else {}
        if sheet["kind"] != "worksheet" or not sheet["path"] or not self.pkg.has(sheet["path"]):
            return
        sst, dates = self.sst(), self.dates()
        stack, cur, row, col, data = [], {}, 0, 0, None
        for ev, el in self.pkg.iterparse(sheet["path"], events=("start", "end")):
            t = local(el.tag)
            if ev == "start":
                stack.append(t)
                if t == "row":
                    row = int(el.get("r") or row + 1)
                    col, cur = 0, {}
                    if el.get("hidden") in ("1", "true"):
                        st["hidden rows"] = st.get("hidden rows", 0) + 1
                elif t == "sheetData":
                    data = el
                continue
            stack.pop()
            if t == "c":
                try:
                    col = parse_ref(el.get("r"))[1] if el.get("r") else col + 1
                except ValueError:
                    col += 1
                typ = el.get("t", "n")
                v = f = inline = None
                shared = False
                for ch in el:
                    lt = local(ch.tag)
                    if lt == "v":
                        v = ch.text
                    elif lt == "f":
                        f = ch.text or ""
                        shared = ch.get("t") == "shared"
                    elif lt == "is":
                        inline = run_text(ch)
                if typ == "s":
                    i = int(v) if v and v.isdigit() else -1
                    val = sst[i] if 0 <= i < len(sst) else ""
                elif typ == "inlineStr":
                    val = inline or ""
                elif typ == "b":
                    val = "" if v is None else ("TRUE" if v == "1" else "FALSE")
                elif typ == "e":
                    val = v or ""
                    st["error values"] = st.get("error values", 0) + 1
                else:
                    val = v or ""
                    s = int(el.get("s") or 0)
                    if val and typ == "n" and s < len(dates) and dates[s]:
                        val = excel_date(val, self.date1904)
                if f is not None:
                    st["formulas"] = st.get("formulas", 0) + 1
                    if v is None or (v == "" and typ != "str"):
                        st["formulas without a cached value"] = st.get("formulas without a cached value", 0) + 1
                    if formulas and f:
                        val = "=" + f
                    elif formulas and shared:
                        st["shared formulas shown as values"] = st.get("shared formulas shown as values", 0) + 1
                if val != "" or f is not None:
                    cur[col] = val
                elif el.get("s"):
                    st["styled empty cells"] = st.get("styled empty cells", 0) + 1
                el.clear()
            elif t == "row":
                if cur:
                    yield row, cur
                el.clear()
                if data is not None:
                    data.remove(el)
            elif t == "dimension":
                st["declared range"] = el.get("ref")
            elif t == "mergeCell":
                st.setdefault("merged", []).append(el.get("ref"))
            elif t == "dataValidation":
                key = "data validation (extLst)" if "extLst" in stack else "data validation"
                st[key] = st.get(key, 0) + 1
            elif t == "conditionalFormatting":
                key = "conditional formats (extLst)" if "extLst" in stack else "conditional formats"
                st[key] = st.get(key, 0) + 1
            elif t == "sparklineGroup":
                st["sparkline groups"] = st.get("sparkline groups", 0) + 1
            elif t == "sheetProtection":
                st["protected"] = True
            elif t == "autoFilter" and "table" not in stack:
                st["filter"] = el.get("ref")
            elif t == "pane" and el.get("state") in ("frozen", "frozenSplit") and el.get("topLeftCell"):
                st["frozen at"] = el.get("topLeftCell")
            elif t == "col" and el.get("hidden") in ("1", "true"):
                st["hidden columns"] = st.get("hidden columns", 0) + int(el.get("max", "1")) - int(el.get("min", "1")) + 1
            elif t == "hyperlink":
                st["hyperlinks"] = st.get("hyperlinks", 0) + 1

    def parts(self, index):
        """What hangs off a sheet: charts, images, shapes, tables, pivots, comments, controls."""
        sheet, out = self.sheets[index], {}
        if not sheet["path"]:
            return out

        def bump(key, n=1):
            if n:
                out[key] = out.get(key, 0) + n
        for typ, path, ext in self.pkg.rels(sheet["path"]).values():
            if ext or not self.pkg.has(path):
                continue
            if typ == "drawing":
                for t2, _, _ in self.pkg.rels(path).values():
                    if t2 in ("chart", "image"):
                        bump(t2 + "s")
                raw = self.pkg.read(path)
                bump("shapes", len(re.findall(rb"<(?:[\w.-]+:)?sp[\s>/]", raw)))
            elif typ == "table":
                root = self.pkg.xml(path)
                out.setdefault("tables", []).append(f"{root.get('displayName') or root.get('name')} {root.get('ref')}")
            elif typ == "pivotTable":
                bump("pivot tables")
            elif typ == "comments":
                bump("comments", sum(1 for el in self.pkg.xml(path).iter() if local(el.tag) == "comment"))
            elif typ == "threadedComment":
                bump("threaded comments", sum(1 for el in self.pkg.xml(path).iter() if local(el.tag) == "threadedComment"))
            elif typ == "ctrlProp":
                bump("form controls")
            elif typ in ("control", "activeXControlBinary"):
                bump("ActiveX controls")
            elif typ in ("slicer", "timeline"):
                bump(typ + "s")
        return out


class Ods:
    def __init__(self, pkg):
        self.pkg = pkg
        self.sheets = []
        for ev, el in pkg.iterparse("content.xml", events=("start",)):
            if local(el.tag) == "table" and attr(el, "name") is not None:
                self.sheets.append({"name": attr(el, "name"), "state": "visible"})

    def rows(self, index, stats=None, formulas=False):
        st = stats if stats is not None else {}
        table, depth, row, cur, col = -1, 0, 0, {}, 0
        for ev, el in self.pkg.iterparse("content.xml", events=("start", "end")):
            t = local(el.tag)
            if t == "table" and ev == "start":
                depth += 1
                if depth == 1:
                    table += 1
                    row = 0
                continue
            if t == "table" and ev == "end":
                depth -= 1
                if depth == 0 and table == index:
                    return
                continue
            if table != index or depth != 1:
                continue
            if ev == "start":
                if t == "table-row":
                    cur, col = {}, 0
                continue
            if t in ("table-cell", "covered-table-cell"):
                repeat = int(attr(el, "number-columns-repeated") or 1)
                vtype = attr(el, "value-type")
                if vtype in ("float", "percentage", "currency"):
                    val = attr(el, "value") or ""
                elif vtype == "date":
                    val = (attr(el, "date-value") or "").replace("T", " ")
                elif vtype == "time":
                    val = attr(el, "time-value") or ""
                elif vtype == "boolean":
                    val = "TRUE" if attr(el, "boolean-value") == "true" else "FALSE"
                else:
                    val = "\n".join(odf_text(p) for p in el if local(p.tag) in ("p", "h"))
                f = attr(el, "formula")
                if f is not None:
                    st["formulas"] = st.get("formulas", 0) + repeat
                    if formulas:
                        val = "=" + re.sub(r"^of:=?", "", f)
                if int(attr(el, "number-columns-spanned") or 1) > 1 or int(attr(el, "number-rows-spanned") or 1) > 1:
                    st.setdefault("merged", []).append(f"{col_letters(col + 1)}{row + 1}")
                if val != "":
                    for k in range(min(repeat, 1024)):
                        cur[col + 1 + k] = val
                col += repeat
                el.clear()
            elif t == "table-row":
                repeat = int(attr(el, "number-rows-repeated") or 1)
                if cur:
                    for _ in range(min(repeat, 10000)):
                        row += 1
                        yield row, dict(cur)
                    row += max(0, repeat - 10000)
                else:
                    row += repeat
                if attr(el, "visibility") in ("collapse", "filter"):
                    st["hidden rows"] = st.get("hidden rows", 0) + repeat
                el.clear()

    def parts(self, index):
        return {}


def odf_text(el):
    out = [el.text or ""]
    for ch in el:
        t = local(ch.tag)
        if t == "s":
            out.append(" " * int(attr(ch, "c") or 1))
        elif t == "tab":
            out.append("\t")
        elif t == "line-break":
            out.append("\n")
        elif t not in ("annotation", "note", "tracked-changes", "deletion"):
            out.append(odf_text(ch))
        out.append(ch.tail or "")
    return "".join(out)


class SpreadsheetML:
    """Excel 2003 XML, which is what many systems still export as `.xls`."""

    def __init__(self, path):
        self.path = path
        self.sheets = []
        try:
            for ev, el in ET.iterparse(path, events=("start",)):
                if local(el.tag) == "Worksheet":
                    self.sheets.append({"name": attr(el, "Name") or f"Sheet{len(self.sheets) + 1}", "state": "visible"})
        except ET.ParseError as e:
            raise Refused(f"Excel 2003 XML that is not well-formed ({e}) - damaged or truncated") from None

    def rows(self, index, stats=None, formulas=False):
        st = stats if stats is not None else {}
        sheet, row, col, cur = -1, 0, 0, {}
        try:
            for ev, el in ET.iterparse(self.path, events=("start", "end")):
                t = local(el.tag)
                if ev == "start":
                    if t == "Worksheet":
                        sheet += 1
                        row = 0
                    elif t == "Row" and sheet == index:
                        row = int(attr(el, "Index") or row + 1)
                        col, cur = 0, {}
                    continue
                if sheet != index:
                    if t == "Worksheet" and sheet > index:
                        return
                    continue
                if t == "Cell":
                    col = int(attr(el, "Index") or col + 1)
                    data = next((ch for ch in el if local(ch.tag) == "Data"), None)
                    val = "".join(data.itertext()) if data is not None else ""
                    f = attr(el, "Formula")
                    if f:
                        st["formulas"] = st.get("formulas", 0) + 1
                        if formulas:
                            val = f
                    if val != "":
                        cur[col] = val
                    if attr(el, "MergeAcross") or attr(el, "MergeDown"):
                        st.setdefault("merged", []).append(f"{col_letters(col)}{row}")
                    col += int(attr(el, "MergeAcross") or 0)
                    el.clear()
                elif t == "Row":
                    if cur:
                        yield row, cur
                    el.clear()
                elif t == "Worksheet":
                    return
        except ET.ParseError as e:
            raise Refused(f"Excel 2003 XML that is not well-formed ({e}) - damaged or truncated") from None

    def parts(self, index):
        return {}


class HtmlTables(HTMLParser):
    """Every <table> in an HTML page - what a bank or ERP 'Excel export' often really is."""

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.tables, self.stack, self.cell, self.skip = [], [], None, 0
        self.feed(text)
        self.close()
        self.sheets = [{"name": f"table {i + 1}", "state": "visible"} for i in range(len(self.tables))]

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.skip += 1
        elif tag == "table":
            self.tables.append([])
            self.stack.append(len(self.tables) - 1)
        elif tag == "tr" and self.stack:
            self.tables[self.stack[-1]].append([])
        elif tag in ("td", "th") and self.stack:
            self.cell = ([], int(dict(attrs).get("colspan") or 1) if (dict(attrs).get("colspan") or "1").isdigit() else 1)
        elif tag == "br" and self.cell:
            self.cell[0].append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip = max(0, self.skip - 1)
        elif tag in ("td", "th") and self.cell and self.stack:
            rows = self.tables[self.stack[-1]]
            if not rows:
                rows.append([])
            text = re.sub(r"[ \t\r\f\v]+", " ", "".join(self.cell[0])).strip()
            rows[-1].extend([text] + [""] * (self.cell[1] - 1))
            self.cell = None
        elif tag == "table" and self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if self.cell is not None and not self.skip:
            self.cell[0].append(data)

    def rows(self, index, stats=None, formulas=False):
        for r, cells in enumerate(self.tables[index], 1):
            found = {c: v for c, v in enumerate(cells, 1) if v != ""}
            if found:
                yield r, found

    def parts(self, index):
        return {}


def text_lines(path, enc):
    """Decoded lines. Under UTF-8 a line that is not UTF-8 is decoded as cp1252 and counted, not lost."""
    stats = {"lines": 0, "cp1252 lines": 0, "utf8 lines": 0, "first non-utf8 line": None}
    if enc.startswith(("utf-16", "utf-32")):
        def gen():
            with open(path, encoding=enc, errors="replace", newline="") as fh:
                for line in fh:
                    stats["lines"] += 1
                    yield line
        return gen(), stats

    def gen():
        with open(path, "rb") as fh:
            first = True
            for raw in fh:
                for part in raw.splitlines(keepends=True) if b"\r" in raw[:-2] else (raw,):
                    if first:
                        part = part[3:] if part.startswith(codecs.BOM_UTF8) else part
                        first = False
                    stats["lines"] += 1
                    try:
                        line = part.decode("utf-8")
                        if not part.isascii():
                            stats["utf8 lines"] += 1
                    except UnicodeDecodeError:
                        line = part.decode("cp1252", "replace")
                        stats["cp1252 lines"] += 1
                        stats["first non-utf8 line"] = stats["first non-utf8 line"] or stats["lines"]
                    yield line
    return gen(), stats


def sniff_delimiter(lines):
    sample = [line for line in lines[:60] if line.strip()]
    best = None
    for d in (",", ";", "\t", "|"):
        counts = []
        for line in sample:
            try:
                counts.append(len(next(csv.reader([line], delimiter=d))))
            except (csv.Error, StopIteration):
                counts.append(0)
        if not counts:
            continue
        mode = max(set(counts), key=counts.count)
        if mode < 2:
            continue
        cand = (counts.count(mode) / len(counts), mode, d)
        if cand[0] >= 0.6 and (best is None or cand[:2] > best[:2]):
            best = cand
    return best


class CsvBook:
    def __init__(self, path, enc):
        self.path, self.enc = path, enc
        gen, _ = text_lines(path, enc)
        head = []
        for line in gen:
            head.append(line)
            if len(head) >= 60:
                break
        gen.close()
        found = sniff_delimiter(head)
        self.delimiter = found[2] if found else None
        self.sheets = [{"name": os.path.splitext(os.path.basename(path))[0], "state": "visible"}]
        self.line_stats = {}

    def rows(self, index, stats=None, formulas=False):
        st = stats if stats is not None else {}
        gen, self.line_stats = text_lines(self.path, self.enc)
        csv.field_size_limit(min(sys.maxsize, 2 ** 31 - 1))
        reader = csv.reader(gen, delimiter=self.delimiter or ",")
        widths = {}
        r = 0
        try:
            for r, cells in enumerate(reader, 1):
                widths[len(cells)] = widths.get(len(cells), 0) + 1
                if any(len(c) > 100000 for c in cells):
                    st["huge field at row"] = st.get("huge field at row") or r
                found = {c: v for c, v in enumerate(cells, 1) if v != ""}
                if found:
                    yield r, found
        except csv.Error as e:
            raise Refused(f"malformed CSV near row {r + 1} ({e})") from None
        st["widths"] = widths

    def parts(self, index):
        return {}


def open_book(path, kind, facts):
    if kind in ("xlsx", "xlsm"):
        return Xlsx(facts["pkg"], facts["main"])
    if kind == "ods":
        return Ods(facts["pkg"])
    if kind == "spreadsheetml":
        return SpreadsheetML(path)
    if kind == "html":
        return HtmlTables(read_text(path, facts.get("encoding", "utf-8")))
    if kind == "mhtml":
        return HtmlTables(mhtml_html(path))
    if kind == "text":
        book = CsvBook(path, facts["encoding"])
        return book if book.delimiter else None
    return None


def read_text(path, enc):
    with open(path, "rb") as fh:
        raw = fh.read()
    for e in (enc, "utf-8", "cp1252"):
        try:
            return raw.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", "replace")


def mhtml_html(path):
    with open(path, "rb") as fh:
        msg = email.message_from_binary_file(fh)
    for part in msg.walk():
        if part.get_content_type() == "text/html":
            payload = part.get_payload(decode=True) or b""
            return payload.decode(part.get_content_charset() or "utf-8", "replace")
    return ""


# ---------------------------------------------------------------- inspect


def inspect_book(path, kind, facts, book, only=None):
    rep = {"sheets": []}
    warn = rep.setdefault("warnings", [])
    if isinstance(book, Xlsx):
        names = book.names
        if names:
            rep["named ranges"] = [f"{n['name']} = {short(n['refers to'], 60)}" + (" (hidden)" if n.get("hidden") else "") for n in names[:30]]
        if book.protected:
            rep["workbook protection"] = "structure locked (sheets cannot be added or renamed in Excel without the password)"
        pkg = facts["pkg"]
        if any(n.endswith("vbaProject.bin") for n in pkg.names):
            warn.append("contains macros (VBA). Reading is safe. An edit must keep the .xlsm extension and load with keep_vba.")
        links = [n for n in pkg.names if n.startswith("xl/externalLinks/") and n.endswith(".xml")]
        if links:
            warn.append(f"{len(links)} link(s) to other workbooks: formulas that use them show the values cached at the last save.")
        if pkg.has("xl/connections.xml") or any(n.startswith("xl/queryTables/") for n in pkg.names):
            rep["data connections"] = "yes (Power Query / external data) - the cells hold the last refreshed result"
        if any(n.startswith("xl/pivotCache/") for n in pkg.names):
            rep["pivot caches"] = len([n for n in pkg.names if re.match(r"xl/pivotCache/pivotCacheDefinition\d+\.xml$", n)])
    no_cache = 0
    for i, sheet in enumerate(book.sheets):
        if only is not None and i != only:
            continue
        st = {}
        entry = {"name": sheet["name"]}
        if sheet.get("state", "visible") != "visible":
            entry["state"] = sheet["state"]
        if sheet.get("kind") and sheet["kind"] != "worksheet":
            entry["kind"] = sheet["kind"]
            rep["sheets"].append(entry)
            continue
        g, sample = scan(book.rows(i, st))
        if g["rows"]:
            entry["used range"] = f"{col_letters(g['c1'])}{g['r1']}:{col_letters(g['c2'])}{g['r2']}"
            entry["rows with data"] = g["rows"]
            entry["cells"] = g["cells"]
        else:
            entry["used range"] = "empty"
        declared = st.pop("declared range", None)
        if declared and g["rows"] and declared.split(":")[-1] != entry["used range"].split(":")[-1]:
            entry["declared range"] = f"{declared} (Excel's own, padded by formatted-but-empty cells - use the used range)"
        frozen = st.get("frozen at")
        frozen_row = parse_ref(frozen)[0] - 1 if frozen and re.match(r"^[A-Z]+\d+$", frozen) else None
        header = guess_header(sample, frozen_row if frozen_row and frozen_row > 0 else None)
        if header:
            cells = dict(sample)[header]
            entry["header row (guess)"] = header
            named = [c for c in sorted(cells) if cells[c] != ""]
            entry["headers"] = " | ".join(f"{col_letters(c)}={short(cells[c])}" for c in named[:20]) + (" ..." if len(named) > 20 else "")
        merged = st.pop("merged", [])
        if merged:
            entry["merged"] = f"{len(merged)}: " + ", ".join(merged[:8]) + (" ..." if len(merged) > 8 else "")
        widths = st.pop("widths", None)
        if widths and len(widths) > 1:
            common = max(widths, key=widths.get)
            ragged = sum(n for w, n in widths.items() if w != common)
            entry["columns"] = f"{common} on most rows; {ragged} row(s) have a different count (stray delimiter or quote?)"
        elif widths:
            entry["columns"] = next(iter(widths))
        no_cache += st.get("formulas without a cached value", 0)
        entry.update(st)
        entry.update(book.parts(i))
        if isinstance(book, Xlsx) and sheet.get("path") and facts["pkg"].sizes.get(sheet["path"], 0) > 50 << 20:
            entry["size"] = f"{facts['pkg'].sizes[sheet['path']] >> 20} MB of XML - extract it in pages with --rows"
        rep["sheets"].append(entry)
    if no_cache:
        warn.append(f"{no_cache} formula cell(s) have no saved value - the workbook was written by a program that does not "
                    "calculate (openpyxl and the like) and never opened in Excel since. Their values read as empty. To see them: "
                    "`libreoffice --headless --convert-to xlsx --outdir \"$TMPDIR/recalc\" FILE` and inspect the copy.")
    hidden = [s["name"] for s in book.sheets if s.get("state", "visible") != "visible"]
    if hidden:
        warn.append(f"hidden sheet(s): {', '.join(hidden)} - they are still part of the workbook and can feed formulas.")
    if isinstance(book, CsvBook):
        ls = book.line_stats
        rep["encoding"] = facts["encoding"] + (" (with BOM)" if facts["encoding"] == "utf-8-sig" else "")
        rep["delimiter"] = {"\t": "tab", ",": "comma", ";": "semicolon", "|": "pipe"}[book.delimiter]
        if ls.get("cp1252 lines") and ls.get("utf8 lines"):
            warn.append(f"mixed encodings: {ls['cp1252 lines']} line(s) are not UTF-8 (first at line {ls['first non-utf8 line']}); "
                        "extract decodes those as cp1252 and the rest as UTF-8.")
            rep["encoding"] = "mixed - UTF-8, with some lines in cp1252"
        elif ls.get("cp1252 lines"):
            rep["encoding"] = "not UTF-8 - read as cp1252 (Windows-1252 / Latin-1)"
        if book.delimiter == ";":
            rep["numbers"] = "a semicolon file is usually a decimal-comma locale: 1.234,56 means 1234.56"
    return rep


def docx_styles(pkg, main):
    names = {}
    for path in pkg.related(main, "styles"):
        for el in pkg.xml(path).iter():
            if local(el.tag) == "style":
                sid = attr(el, "styleId")
                nm = next((attr(c, "val") for c in el if local(c.tag) == "name"), None)
                if sid:
                    names[sid] = (nm or sid).lower()
    return names


def heading_level(p, styles):
    ppr = next((c for c in p if local(c.tag) == "pPr"), None)
    if ppr is None:
        return None
    for c in ppr:
        t = local(c.tag)
        if t == "pStyle":
            name = styles.get(attr(c, "val"), (attr(c, "val") or "").lower())
            if name == "title":
                return 1
            m = re.match(r"heading\s*(\d)", name)
            if m:
                return int(m.group(1))
        elif t == "outlineLvl" and (attr(c, "val") or "9").isdigit() and int(attr(c, "val")) < 9:
            return int(attr(c, "val")) + 1
    return None


def is_list(p, styles):
    ppr = next((c for c in p if local(c.tag) == "pPr"), None)
    if ppr is None:
        return False
    for c in ppr:
        if local(c.tag) == "numPr" or (local(c.tag) == "pStyle" and styles.get(attr(c, "val"), "").startswith("list")):
            return True
    return False


def word_text(el, changes=False):
    """Text of a Word element: insertions in, deletions out (as if accepted) unless `changes` marks both."""
    out = []

    def walk(node):
        for ch in node:
            t = local(ch.tag)
            if t in ("Fallback", "instrText", "rPr", "pPr", "footnoteReference", "endnoteReference"):
                continue
            if t == "t":
                out.append(ch.text or "")
            elif t == "delText":
                if changes:
                    out.append("[-" + (ch.text or "") + "-]")
            elif t == "tab":
                out.append("\t")
            elif t in ("br", "cr"):
                out.append("\n")
            elif t == "ins" and changes:
                out.append("{+")
                walk(ch)
                out.append("+}")
            else:
                walk(ch)
    walk(el)
    return "".join(out)


def md_cell(v):
    return str(v).replace("|", "\\|").replace("\r\n", "<br>").replace("\n", "<br>")


def md_table(rows):
    if not rows:
        return []
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    out = ["| " + " | ".join(md_cell(c) for c in rows[0]) + " |", "|" + "---|" * width]
    out.extend("| " + " | ".join(md_cell(c) for c in r) + " |" for r in rows[1:])
    return out


def docx_table(tbl, changes=False):
    rows = []
    for tr in tbl:
        if local(tr.tag) != "tr":
            continue
        row = []
        for tc in tr:
            if local(tc.tag) != "tc":
                continue
            tcpr = next((c for c in tc if local(c.tag) == "tcPr"), None)
            span, cont = 1, False
            for c in tcpr if tcpr is not None else []:
                if local(c.tag) == "gridSpan":
                    span = int(attr(c, "val") or 1)
                elif local(c.tag) == "vMerge" and attr(c, "val") in (None, "continue"):
                    cont = True
            text = "\n".join(word_text(p, changes) for p in tc if local(p.tag) in ("p", "tbl", "sdt"))
            row.extend(["" if cont else text.strip()] + [""] * (span - 1))
        rows.append(row)
    return rows


def docx_blocks(body, styles, changes=False):
    """(kind, payload) for each block of the body in order: ('h', (level, text)), ('p', text), ('li', text), ('table', rows)."""
    for el in body:
        t = local(el.tag)
        if t == "p":
            text = word_text(el, changes).strip()
            level = heading_level(el, styles)
            if level and text:
                yield "h", (level, text)
            elif text:
                yield ("li" if is_list(el, styles) else "p"), text
        elif t == "tbl":
            yield "table", docx_table(el, changes)
        elif t in ("sdt", "sdtContent", "customXml", "ins", "smartTag"):
            yield from docx_blocks(el, styles, changes)


def inspect_docx(pkg, main):
    root = pkg.xml(main)
    styles = docx_styles(pkg, main)
    body = next((c for c in root if local(c.tag) == "body"), root)
    counts = {}
    for el in root.iter():
        t = local(el.tag)
        if t in ("p", "tbl", "ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange", "drawing", "pict", "object", "sdt",
                 "sectPr", "commentReference", "footnoteReference", "endnoteReference", "fldSimple", "fldChar", "hyperlink"):
            counts[t] = counts.get(t, 0) + 1
    rep, warn, outline, tables, words = {}, [], [], [], 0
    for kind, payload in docx_blocks(body, styles):
        if kind == "h":
            outline.append(("  " * (payload[0] - 1)) + f"H{payload[0]} {short(payload[1], 70)}")
        elif kind == "table":
            tables.append(f"{len(payload)} rows x {max((len(r) for r in payload), default=0)} cols; first row: "
                          + " | ".join(short(c, 18) for c in (payload[0] if payload else [])[:8]))
            words += sum(len(c.split()) for r in payload for c in r)
        if kind in ("h", "p", "li"):
            words += len((payload[1] if kind == "h" else payload).split())
    rep["paragraphs"] = counts.get("p", 0)
    rep["words (approx.)"] = words
    if counts.get("sectPr", 0) > 1:
        rep["sections"] = counts["sectPr"]
    if outline:
        rep["outline"] = outline[:60] + ([f"... {len(outline) - 60} more headings"] if len(outline) > 60 else [])
    else:
        rep["outline"] = ["no headings - the document uses plain paragraphs (or direct formatting) for its titles"]
    if tables:
        rep["tables"] = tables[:20] + ([f"... {len(tables) - 20} more"] if len(tables) > 20 else [])
    ins, dele = counts.get("ins", 0) + counts.get("moveTo", 0), counts.get("del", 0) + counts.get("moveFrom", 0)
    if ins or dele or counts.get("rPrChange") or counts.get("pPrChange"):
        warn.append(f"tracked changes not yet accepted: {ins} insertion(s), {dele} deletion(s), "
                    f"{counts.get('rPrChange', 0) + counts.get('pPrChange', 0)} formatting change(s). extract shows the text "
                    "as if accepted; --changes marks them {+inserted+} [-deleted-].")
    for p in pkg.related(main, "comments"):
        cs = [el for el in pkg.xml(p).iter() if local(el.tag) == "comment"]
        if cs:
            authors = sorted({attr(c, "author") or "?" for c in cs})
            rep["comments"] = f"{len(cs)} by {', '.join(authors[:6])}"
    images = counts.get("drawing", 0) + counts.get("pict", 0)
    if images:
        rep["images / drawings"] = images
    if counts.get("object"):
        rep["embedded objects"] = counts["object"]
    if counts.get("sdt"):
        rep["content controls"] = counts["sdt"]
    hf = []
    for kind in ("header", "footer"):
        for p in pkg.related(main, kind):
            text = short(word_text(pkg.xml(p)), 60)
            if text:
                hf.append(f"{kind} {posixpath.basename(p)}: {text}")
    if hf:
        rep["headers / footers"] = hf
    for kind in ("footnotes", "endnotes"):
        for p in pkg.related(main, kind):
            n = sum(1 for el in pkg.xml(p) if local(el.tag) in ("footnote", "endnote") and (attr(el, "id") or "0").lstrip("-").isdigit()
                    and int(attr(el, "id")) > 0)
            if n:
                rep[kind] = n
    for p in pkg.related(main, "settings"):
        for el in pkg.xml(p):
            if local(el.tag) == "documentProtection" and attr(el, "enforcement") in ("1", "true", "on"):
                rep["protection"] = f"editing restricted ({attr(el, 'edit') or 'yes'})"
            if local(el.tag) == "trackRevisions" and attr(el, "val") not in ("0", "false", "off"):
                rep["track changes"] = "on - an edit made in Word would be recorded as a change"
    if pkg.has("docProps/app.xml"):
        for el in pkg.xml("docProps/app.xml"):
            if local(el.tag) == "Pages" and el.text:
                rep["pages (as last saved)"] = int(el.text) if el.text.isdigit() else el.text
    if any(n.endswith("vbaProject.bin") for n in pkg.names):
        warn.append("contains macros (VBA) - a .docm; reading is safe, nothing here runs them.")
    if any(n.startswith("word/embeddings/") for n in pkg.names):
        rep["embedded files"] = len([n for n in pkg.names if n.startswith("word/embeddings/")])
    rep["warnings"] = warn
    return rep


def pptx_slides(pkg, main):
    root = pkg.xml(main)
    rels = pkg.rels(main)
    out = []
    for el in root.iter():
        if local(el.tag) == "sldId":
            typ, path, _ = rels.get(rel_id(el), ("", None, False))
            if path and pkg.has(path):
                out.append(path)
    return out


def shape_paragraphs(sp):
    paras = []
    for p in sp.iter():
        if local(p.tag) == "p" and "drawingml" in p.tag:
            text = "".join((t.text or "") if local(t.tag) == "t" else "\n" for t in p.iter() if local(t.tag) in ("t", "br")).strip()
            if text:
                paras.append(text)
    return paras


def placeholder_type(sp):
    for el in sp.iter():
        if local(el.tag) == "ph":
            return el.get("type") or "body"
    return None


def read_slide(pkg, path):
    root = pkg.xml(path)
    slide = {"hidden": root.get("show") in ("0", "false"), "title": "", "text": [], "tables": [], "pictures": 0, "charts": 0}
    tree = next((el for el in root.iter() if local(el.tag) == "spTree"), root)
    for sp in tree.iter():
        t = local(sp.tag)
        if t == "sp":
            paras = shape_paragraphs(sp)
            if placeholder_type(sp) in ("title", "ctrTitle") and paras and not slide["title"]:
                slide["title"] = " ".join(paras)
            elif placeholder_type(sp) not in ("sldNum", "dt", "ftr"):
                slide["text"].extend(paras)
        elif t == "pic":
            slide["pictures"] += 1
        elif t == "tbl":
            slide["tables"].append([["".join(x.text or "" for x in tc.iter() if local(x.tag) == "t") for tc in tr if local(tc.tag) == "tc"]
                                    for tr in sp if local(tr.tag) == "tr"])
        elif t == "chart":
            slide["charts"] += 1
    notes = []
    for npath in pkg.related(path, "notesSlide"):
        for sp in pkg.xml(npath).iter():
            if local(sp.tag) == "sp" and placeholder_type(sp) == "body":
                notes.extend(shape_paragraphs(sp))
    slide["notes"] = notes
    slide["media"] = len(pkg.related(path, "video")) + len(pkg.related(path, "audio")) + len(pkg.related(path, "media"))
    return slide


def inspect_pptx(pkg, main):
    rep, slides = {}, []
    paths = pptx_slides(pkg, main)
    for el in pkg.xml(main).iter():
        if local(el.tag) == "sldSz":
            cx, cy = int(el.get("cx", "0")), int(el.get("cy", "0"))
            rep["slide size"] = f"{cx / 914400:.2f} x {cy / 914400:.2f} in" + (" (16:9)" if cy and abs(cx / cy - 16 / 9) < 0.01 else "")
    rep["slides"] = len(paths)
    for n, path in enumerate(paths, 1):
        s = read_slide(pkg, path)
        bits = [f"{n}. {short(s['title'], 60) or '(no title)'}"]
        if s["hidden"]:
            bits.append("HIDDEN")
        bits.append(f"{sum(len(t) for t in s['text'])} chars")
        for key in ("pictures", "charts", "media"):
            if s[key]:
                bits.append(f"{s[key]} {key}")
        if s["tables"]:
            bits.append(f"{len(s['tables'])} table(s)")
        if s["notes"]:
            bits.append(f"notes: {short(' '.join(s['notes']), 50)}")
        slides.append(", ".join(bits))
    rep["slide list"] = slides[:80] + ([f"... {len(slides) - 80} more"] if len(slides) > 80 else [])
    rep["warnings"] = ["contains macros (VBA) - a .pptm; reading is safe."] if any(n.endswith("vbaProject.bin") for n in pkg.names) else []
    return rep


def pdf_facts(path, sample_pages=5):
    """Pages, encryption, form fields and a text sample, from whichever of pypdf / poppler / raw bytes is here."""
    rep, texts = {}, []
    try:
        import pypdf  # noqa: PLC0415
    except ImportError:
        pypdf = None
    if pypdf is not None:
        try:
            reader = pypdf.PdfReader(path)
            if reader.is_encrypted:
                try:
                    opened = reader.decrypt("")
                except Exception:  # noqa: BLE001 - pypdf raises several kinds here, including for missing crypto libraries
                    opened = 0
                if not opened:
                    raise Refused("the PDF is password-protected - it needs the password to open. Ask for it; with it: "
                                  "`qpdf --password=PASSWORD --decrypt in.pdf \"$TMPDIR/open.pdf\"`")
                rep["encrypted"] = "yes, but it opens without a password (only copying/printing restrictions) - text can be read"
            rep["pages"] = len(reader.pages)
            fields = reader.get_fields() or {}
            if fields:
                filled = sum(1 for f in fields.values() if f.get("/V") not in (None, "", "/Off"))
                rep["form fields"] = f"{len(fields)} ({filled} filled)"
            meta = reader.metadata or {}
            for key, label in (("/Title", "title"), ("/Producer", "made by")):
                if meta.get(key):
                    rep[label] = short(meta.get(key), 60)
            for i in range(min(sample_pages, len(reader.pages))):
                try:
                    texts.append(reader.pages[i].extract_text() or "")
                except Exception:  # noqa: BLE001
                    texts.append("")
            rep["read with"] = "pypdf"
            return rep, texts
        except Refused:
            raise
        except Exception as e:  # noqa: BLE001 - fall through to poppler on a file pypdf trips over
            rep["pypdf"] = f"could not parse it ({type(e).__name__}) - trying poppler"
    if shutil.which("pdfinfo"):
        proc = subprocess.run(["pdfinfo", path], capture_output=True, text=True, errors="replace", timeout=60, check=False)
        if proc.returncode != 0:
            if "password" in proc.stderr.lower():
                raise Refused("the PDF is password-protected - it needs the password to open. Ask for it.")
            raise Refused(f"poppler cannot read it ({short(proc.stderr.strip(), 120)}) - the PDF is damaged")
        for line in proc.stdout.splitlines():
            key, _, val = line.partition(":")
            val = val.strip()
            if key == "Pages":
                rep["pages"] = int(val) if val.isdigit() else val
            elif key == "Encrypted" and val.startswith("yes"):
                rep["encrypted"] = "yes, but it opens without a password - text can be read"
            elif key == "Form" and val != "none":
                rep["form"] = val
            elif key in ("Title", "Producer") and val:
                rep["title" if key == "Title" else "made by"] = short(val, 60)
        if shutil.which("pdftotext"):
            proc = subprocess.run(["pdftotext", "-f", "1", "-l", str(sample_pages), "-layout", path, "-"],
                                  capture_output=True, text=True, errors="replace", timeout=120, check=False)
            texts = proc.stdout.split("\f")[:sample_pages]
        rep["read with"] = "poppler"
        return rep, texts
    with open(path, "rb") as fh:
        raw = fh.read(64 << 20)
    rep["pages (rough)"] = len(re.findall(rb"/Type\s*/Page(?![s\w])", raw))
    if b"/Encrypt" in raw:
        rep["encrypted"] = "yes (may still open without a password)"
    if b"/AcroForm" in raw:
        rep["form"] = "AcroForm present"
    rep["text layer"] = "fonts present, so probably (not certainly) text" if b"/Font" in raw else "no fonts - almost certainly scanned images"
    rep["read with"] = "raw bytes only - install pypdf (`pip install pypdf`) or poppler (`pdftotext`) for a real answer"
    return rep, None


def inspect_pdf(path):
    rep, texts = pdf_facts(path)
    warn = []
    if texts is not None:
        chars = [len(t.strip()) for t in texts]
        if texts and sum(chars) / max(1, len(chars)) < 25:
            rep["text layer"] = "none on the sampled pages"
            warn.append("scanned: the pages are images with no text layer. OCR it (`ocrmypdf in.pdf out.pdf`) or render the "
                        "pages you need (`pdftoppm -png -r 150 -f 3 -l 5 in.pdf \"$TMPDIR/page\"`) and look at them.")
        elif texts:
            joined = "".join(texts)
            odd = sum(1 for ch in joined if ch == "\ufffd" or 0xE000 <= ord(ch) <= 0xF8FF) + joined.count("(cid:")
            rep["text layer"] = f"yes (~{sum(chars) // max(1, len(chars))} chars/page on the first {len(chars)})"
            if odd > len(joined) // 10:
                warn.append("the text layer is garbled (fonts without a Unicode map) - OCR gives better text than extraction.")
    pages = rep.get("pages") or rep.get("pages (rough)") or 0
    if isinstance(pages, int) and pages > 40:
        warn.append(f"{pages} pages: extract once, then grep the file for what you were asked about - or --pages to take a range.")
    rep["warnings"] = warn
    return rep


def inspect_odf_text(pkg, kind):
    root = pkg.xml("content.xml")
    counts, outline = {}, []
    for el in root.iter():
        t = local(el.tag)
        counts[t] = counts.get(t, 0) + 1
        if t == "h":
            level = int(attr(el, "outline-level") or 1)
            outline.append("  " * (level - 1) + f"H{level} {short(odf_text(el), 70)}")
    rep = {"warnings": []}
    if kind == "odp":
        pages = [el for el in root.iter() if local(el.tag) == "page"]
        rep["slides"] = len(pages)
        rep["slide list"] = [f"{i}. {attr(p, 'name') or ''}: {short(' '.join(odf_text(x) for x in p.iter() if local(x.tag) == 'p'), 70)}"
                             for i, p in enumerate(pages[:80], 1)]
        return rep
    rep["paragraphs"] = counts.get("p", 0)
    rep["outline"] = outline[:60] or ["no headings"]
    for key, label in (("table", "tables"), ("image", "images"), ("annotation", "comments")):
        if counts.get(key):
            rep[label] = counts[key]
    if counts.get("changed-region"):
        rep["warnings"].append(f"{counts['changed-region']} tracked change(s) not yet accepted.")
    return rep


def epub_spine(pkg):
    container = pkg.xml("META-INF/container.xml")
    opf = next((attr(el, "full-path") for el in container.iter() if local(el.tag) == "rootfile"), None)
    if not opf or not pkg.has(opf):
        raise Refused("an EPUB with no readable package file - damaged")
    root = pkg.xml(opf)
    base = posixpath.dirname(opf)
    items = {el.get("id"): posixpath.normpath(posixpath.join(base, el.get("href", ""))) for el in root.iter() if local(el.tag) == "item"}
    spine = [items.get(el.get("idref")) for el in root.iter() if local(el.tag) == "itemref"]
    meta = {local(el.tag): (el.text or "").strip() for el in root.iter() if local(el.tag) in ("title", "creator", "language") and el.text}
    return [s for s in spine if s and pkg.has(s)], meta


def inspect_epub(pkg):
    spine, meta = epub_spine(pkg)
    rep = {**meta, "chapters (spine)": len(spine), "warnings": []}
    if pkg.has("META-INF/encryption.xml"):
        algs = {attr(el, "Algorithm") for el in pkg.xml("META-INF/encryption.xml").iter() if local(el.tag) == "EncryptionMethod"}
        if algs - {"http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"}:
            raise Refused("DRM-protected EPUB - the chapters are encrypted and cannot be read here")
    return rep


def inspect_text(path, facts):
    book = CsvBook(path, facts["encoding"])
    if book.delimiter:
        return "csv", book
    gen, stats = text_lines(path, facts["encoding"])
    longest = 0
    for line in gen:
        longest = max(longest, len(line))
    rep = {"encoding": facts["encoding"], "lines": stats["lines"], "longest line": longest, "warnings": []}
    if stats["cp1252 lines"] and stats["utf8 lines"]:
        rep["warnings"].append(f"mixed encodings: {stats['cp1252 lines']} line(s) are not UTF-8 (first at line {stats['first non-utf8 line']}).")
    rep["note"] = "plain text - `read` and `grep` it directly; no conversion needed" + (
        " (it is not UTF-8: `iconv -f cp1252 -t utf-8` first if `read` shows mojibake)" if facts["encoding"] == "cp1252" else "")
    return "text", rep


def inspect(path, only_sheet=None):
    kind, facts = detect(path)
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    rep = {"file": path, "type": kind, "size": human(facts["size"])}
    warn = []
    if ext in EXPECTED and EXPECTED[ext] != kind and not (ext in ("csv", "tsv", "txt") and kind == "text"):
        warn.append(f"named .{ext} but the content is {describe(kind)} - treat it as what it is, not what it is called.")
    locks = lock_files(path)
    if locks:
        warn.append(f"open in an editor right now ({', '.join(locks)} beside it) - someone may be changing it; never "
                    "overwrite it while that lock file exists.")
    body = {}
    if kind in ("xlsx", "xlsm", "ods", "spreadsheetml", "html", "mhtml", "text"):
        book = None if kind == "text" else open_book(path, kind, facts)
        if kind == "text":
            sub, payload = inspect_text(path, facts)
            if sub == "csv":
                rep["type"] = "csv"
                body = inspect_book(path, "csv", facts, payload)
            else:
                body = payload
        elif kind in ("html", "mhtml") and not book.tables:
            body = {"tables": 0, "note": "a web page with no tables - extract gives its text"}
        else:
            body = inspect_book(path, kind, facts, book, only_sheet)
            if kind in ("html", "mhtml"):
                warn.append("this is an HTML page, not an Excel file (common for 'Export to Excel' downloads); extract reads its tables.")
            if kind == "spreadsheetml":
                warn.append("Excel 2003 XML (SpreadsheetML), not a real .xls/.xlsx: extract reads it directly; to edit, "
                            "convert it to .xlsx with LibreOffice first.")
    elif kind in ("docx", "docm"):
        body = inspect_docx(facts["pkg"], facts["main"])
    elif kind in ("pptx", "pptm"):
        body = inspect_pptx(facts["pkg"], facts["main"])
    elif kind == "pdf":
        body = inspect_pdf(path)
    elif kind in ("odt", "odp"):
        body = inspect_odf_text(facts["pkg"], kind)
    elif kind == "epub":
        body = inspect_epub(facts["pkg"])
    elif kind in ("xls", "doc", "ppt", "xlsb"):
        target = {"xls": "xlsx", "xlsb": "xlsx", "doc": "docx", "ppt": "pptx"}[kind]
        converted = libreoffice_convert(path, target)
        sub = inspect(converted, only_sheet)
        sub.pop("file", None)
        sub["type"] = f"{kind} (legacy binary; looked at through a LibreOffice conversion to .{target}: {converted})"
        sub.setdefault("warnings", []).insert(0, f"legacy .{kind}: to edit it, convert to .{target} and edit that copy.")
        return {"file": path, **sub}
    elif kind == "rtf":
        text = rtf_text(read_text(path, "latin-1"))
        body = {"words (approx.)": len(text.split()), "tables": read_text(path, "latin-1").count("\\trowd"), "warnings": []}
    elif kind == "msg":
        body = {"note": "an Outlook message (.msg): `pip install extract-msg` then `extract_msg --out \"$TMPDIR\" FILE`", "warnings": []}
    elif kind == "zip":
        names = sorted(facts["pkg"].names)
        body = {"entries": len(names), "first entries": names[:30], "note": "a plain zip: unzip it into $TMPDIR and inspect the files inside"}
    else:
        body = {"magic bytes": facts.get("magic", ""), "note": "not a document format this knows - `file` may name it"}
    warn.extend(body.pop("warnings", []))
    rep["warnings"] = warn
    rep.update(body)
    return rep


def describe(kind):
    return {"html": "an HTML page", "mhtml": "a saved web page (MHTML)", "spreadsheetml": "Excel 2003 XML", "text": "plain text/CSV",
            "csv": "CSV text", "zip": "a plain zip", "binary": "unrecognised binary"}.get(kind, f"a .{kind} file")


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def render(rep):
    lines = [f"# {rep['file']}", f"type: {rep['type']}, {rep['size']}" if "size" in rep else f"type: {rep['type']}"]
    for w in rep.get("warnings", []):
        lines.append(f"! {w}")
    sections = []
    for key, val in rep.items():
        if key in ("file", "type", "size", "warnings"):
            continue
        if isinstance(val, list):
            if val:
                sections.append((key, val))
        else:
            lines.append(f"{key}: {val}")
    for key, val in sections:
        lines.append(f"\n## {key}")
        for item in val:
            if isinstance(item, dict):
                name = item.get("name", "")
                rest = "; ".join(f"{k}: {', '.join(v) if isinstance(v, list) else v}" for k, v in item.items() if k != "name")
                lines.append(f"- **{name}** - {rest}")
            else:
                lines.append(f"- {item}")
    return "\n".join(lines)


# ---------------------------------------------------------------- extract


def rtf_text(text):
    pattern = re.compile(r"\\([a-z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|(.)", re.I | re.S)
    dest = {"fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "themedata", "datastore", "latentstyles", "listtable",
            "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "mmathPr", "filetbl", "revtbl", "header", "footer"}
    stack, ignorable, ucskip, curskip, out = [], False, 1, 0, []
    for m in pattern.finditer(text):
        word, arg, hexcode, char, brace, tchar = m.groups()
        if brace:
            curskip = 0
            if brace == "{":
                stack.append((ucskip, ignorable))
            elif stack:
                ucskip, ignorable = stack.pop()
        elif char:
            curskip = 0
            if char == "*":
                ignorable = True
            elif not ignorable and char in "{}\\":
                out.append(char)
            elif not ignorable and char == "~":
                out.append("\xa0")
        elif word:
            curskip = 0
            if word in dest:
                ignorable = True
            elif ignorable:
                continue
            elif word in ("par", "line", "row", "sect", "page"):
                out.append("\n")
            elif word in ("tab", "cell"):
                out.append("\t")
            elif word == "uc":
                ucskip = int(arg or 1)
            elif word == "u" and arg:
                code = int(arg)
                out.append(chr(code + 65536 if code < 0 else code))
                curskip = ucskip
        elif hexcode:
            if curskip > 0:
                curskip -= 1
            elif not ignorable:
                out.append(bytes([int(hexcode, 16)]).decode("cp1252", "replace"))
        elif tchar:
            if curskip > 0:
                curskip -= 1
            elif not ignorable:
                out.append(tchar)
    return re.sub(r"\n{3,}", "\n\n", "".join(out))


class HtmlText(HTMLParser):
    BLOCK = {"p", "div", "section", "article", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.out.append("\n")
            if re.fullmatch(r"h[1-6]", tag):
                self.out.append("#" * int(tag[1]) + " ")
            elif tag == "li":
                self.out.append("- ")
        elif tag in ("td", "th"):
            self.out.append(" | ")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.out.append(re.sub(r"\s+", " ", data))

    def text(self):
        return re.sub(r"\n\s*\n\s*(\n\s*)+", "\n\n", "".join(self.out)).strip() + "\n"


def html_text(markup):
    p = HtmlText()
    p.feed(markup)
    p.close()
    return p.text()


def default_out(path, suffix, ext):
    folder = ensure_dir(os.path.join(tmpdir(), "doc-extract"))
    stem = slug(os.path.splitext(os.path.basename(path))[0])
    return os.path.join(folder, f"{stem}{('.' + slug(suffix)) if suffix else ''}.{ext}")


def guard_out(out, src):
    if os.path.abspath(out) == os.path.abspath(src):
        raise Refused("--out is the document itself - extract never writes over its input")
    ensure_dir(os.path.dirname(os.path.abspath(out)))
    return out


def write_grid(rows, bounds, out, fmt):
    r1, c1, r2, c2 = bounds
    written = 0
    with open(out, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, delimiter="\t" if fmt == "tsv" else ",", lineterminator="\n") if fmt != "md" else None

        def emit(values):
            nonlocal written
            if writer:
                writer.writerow(values)
            else:
                fh.write("| " + " | ".join(md_cell(v) for v in values) + " |\n")
                if written == 0:
                    fh.write("|" + "---|" * len(values) + "\n")
            written += 1
        nxt = r1
        for r, cells in rows:
            if r < r1:
                continue
            if r > r2:
                break
            while nxt < r:
                emit([""] * (c2 - c1 + 1))
                nxt += 1
            emit([cells.get(c, "") for c in range(c1, c2 + 1)])
            nxt = r + 1
    return written


def pick_sheets(book, wanted):
    if wanted is None:
        return list(range(len(book.sheets)))
    for i, s in enumerate(book.sheets):
        if s["name"] == wanted:
            return [i]
    for i, s in enumerate(book.sheets):
        if s["name"].strip().lower() == wanted.strip().lower():
            return [i]
    if wanted.isdigit() and 1 <= int(wanted) <= len(book.sheets):
        return [int(wanted) - 1]
    names = ", ".join(repr(s["name"]) for s in book.sheets)
    raise Refused(f"no sheet {wanted!r} - the sheets are: {names}")


def extract_book(path, book, args):
    fmt = args.format or "csv"
    if fmt not in ("csv", "tsv", "md"):
        raise Refused(f"--format {fmt} does not apply to a table; use csv, tsv or md")
    wanted = args.sheet if args.sheet is not None else (str(args.table) if args.table else None)
    indexes = pick_sheets(book, wanted)
    if args.out and len(indexes) > 1:
        raise Refused("--out names one file but this has several sheets - add --sheet")
    done = []
    for i in indexes:
        sheet = book.sheets[i]
        if sheet.get("kind") and sheet["kind"] != "worksheet":
            done.append(f"- {sheet['name']}: a {sheet['kind']}, no cells - skipped")
            continue
        bounds = parse_bounds(args.range) if args.range else (None, None, None, None)
        if args.rows:
            a, b = parse_span(args.rows)
            bounds = (a, bounds[1], b, bounds[3])
        if None in bounds:
            g, _ = scan(book.rows(i, {}))
            if not g["rows"]:
                done.append(f"- {sheet['name']}: empty - nothing written")
                continue
            bounds = (bounds[0] or g["r1"], bounds[1] or g["c1"], bounds[2] or g["r2"], bounds[3] or g["c2"])
        out = guard_out(args.out or default_out(path, sheet["name"] if len(book.sheets) > 1 else "", fmt), path)
        n = write_grid(book.rows(i, {}, args.formulas), bounds, out, fmt)
        r1, c1, r2, c2 = bounds
        done.append(f"- {sheet['name']} -> {out}\n  {n} rows x {c2 - c1 + 1} cols = sheet {col_letters(c1)}{r1}:{col_letters(c2)}{r2}"
                    f" ({'line 1 is' if fmt != 'md' else 'the table header is'} sheet row {r1}); {human(os.path.getsize(out))}")
    return done


def write_text(out, text):
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
    lines = text.count("\n")
    return f"- {out}\n  {lines} lines, {human(os.path.getsize(out))} - `read` it with offset/limit, or `grep -n` it for what you need"


def extract(path, args):
    kind, facts = detect(path)
    if kind in ("xls", "xlsb"):
        return extract(libreoffice_convert(path, "xlsx"), args)
    if kind in ("doc", "ppt"):
        return extract(libreoffice_convert(path, "docx" if kind == "doc" else "pptx"), args)
    if kind in ("xlsx", "xlsm", "ods", "spreadsheetml", "html", "mhtml"):
        book = open_book(path, kind, facts)
        if kind in ("html", "mhtml") and not book.tables:
            markup = read_text(path, facts.get("encoding", "utf-8")) if kind == "html" else mhtml_html(path)
            return [write_text(guard_out(args.out or default_out(path, "", "md"), path), html_text(markup))]
        return extract_book(path, book, args)
    if kind == "text":
        book = open_book(path, kind, facts)
        if book is not None and args.format in (None, "csv", "tsv", "md"):
            return extract_book(path, book, args)
        return [f"- {path} is already plain text ({facts['encoding']}) - `read` or `grep` it directly"]
    if kind in ("docx", "docm"):
        pkg, main = facts["pkg"], facts["main"]
        root = pkg.xml(main)
        styles = docx_styles(pkg, main)
        body = next((c for c in root if local(c.tag) == "body"), root)
        out_lines, prev = [], None
        for block, payload in docx_blocks(body, styles, args.changes):
            if block == "h":
                out_lines.extend(["", "#" * min(payload[0], 6) + " " + payload[1], ""])
            elif block == "li":
                out_lines.append("- " + payload.replace("\n", " "))
            elif block == "p":
                if prev == "li":
                    out_lines.append("")
                out_lines.extend([payload, ""])
            elif block == "table":
                out_lines.extend([""] + md_table(payload) + [""])
            prev = block
        for p in pkg.related(main, "comments"):
            cs = [el for el in pkg.xml(p).iter() if local(el.tag) == "comment"]
            if cs:
                out_lines.extend(["", "## Comments", ""] + [f"- {attr(c, 'author') or '?'}: {word_text(c).strip()}" for c in cs])
        text = re.sub(r"\n{3,}", "\n\n", "\n".join(out_lines)).strip() + "\n"
        return [write_text(guard_out(args.out or default_out(path, "", "md"), path), text)]
    if kind in ("pptx", "pptm"):
        pkg = facts["pkg"]
        out_lines = []
        for n, sp in enumerate(pptx_slides(pkg, facts["main"]), 1):
            s = read_slide(pkg, sp)
            out_lines.append(f"## Slide {n}: {s['title'] or '(no title)'}" + (" [hidden]" if s["hidden"] else ""))
            out_lines.extend(f"- {t}" for t in s["text"])
            for t in s["tables"]:
                out_lines.extend([""] + md_table(t))
            if s["notes"]:
                out_lines.extend(["", "Notes: " + " ".join(s["notes"])])
            out_lines.append("")
        return [write_text(guard_out(args.out or default_out(path, "", "md"), path), "\n".join(out_lines))]
    if kind == "pdf":
        return [extract_pdf(path, args)]
    if kind in ("odt", "odp"):
        root = facts["pkg"].xml("content.xml")
        out_lines = []
        for el in root.iter():
            t = local(el.tag)
            if t == "h":
                out_lines.extend(["", "#" * int(attr(el, "outline-level") or 1) + " " + odf_text(el), ""])
            elif t == "page":
                out_lines.extend(["", f"## Slide: {attr(el, 'name') or ''}", ""])
            elif t == "p" and odf_text(el).strip():
                out_lines.append(odf_text(el))
        return [write_text(guard_out(args.out or default_out(path, "", "md"), path), "\n".join(out_lines).strip() + "\n")]
    if kind == "epub":
        inspect_epub(facts["pkg"])
        spine, meta = epub_spine(facts["pkg"])
        parts = [f"# {meta.get('title', '')}\n"] + [html_text(facts["pkg"].read(s).decode("utf-8", "replace")) for s in spine]
        return [write_text(guard_out(args.out or default_out(path, "", "md"), path), "\n".join(parts))]
    if kind == "rtf":
        if shutil.which("pandoc"):
            out = guard_out(args.out or default_out(path, "", "md"), path)
            subprocess.run(["pandoc", path, "-t", "markdown", "-o", out], capture_output=True, timeout=300, check=False)
            if os.path.exists(out) and os.path.getsize(out):
                return [f"- {out}\n  converted with pandoc, {human(os.path.getsize(out))}"]
        return [write_text(guard_out(args.out or default_out(path, "", "txt"), path), rtf_text(read_text(path, "latin-1")))]
    raise Refused(f"nothing to extract from {describe(kind)} - see `inspect`")


def extract_pdf(path, args):
    a, b = parse_span(args.pages) if args.pages else (1, None)
    out = guard_out(args.out or default_out(path, f"p{a}-{b}" if args.pages else "", "txt"), path)
    pages = None
    if shutil.which("pdftotext"):
        cmd = ["pdftotext", "-layout", "-f", str(a)] + (["-l", str(b)] if b else []) + [path, out]
        proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=600, check=False)
        if proc.returncode == 0 and os.path.exists(out):
            with open(out, encoding="utf-8", errors="replace") as fh:
                pages = fh.read().split("\f")
        elif "password" in (proc.stderr or "").lower():
            raise Refused("the PDF is password-protected - ask for the password")
    if pages is None:
        try:
            import pypdf  # noqa: PLC0415
        except ImportError:
            raise Missing("extracting PDF text needs pdftotext (`nouride pkg install poppler-utils`, `brew install poppler`, "
                          "`apt install poppler-utils`, `apk add poppler-utils`) or pypdf (`pip install pypdf`)") from None
        pdf_facts(path, 0)  # refuses a password-protected file with the same words as inspect
        reader = pypdf.PdfReader(path)
        if reader.is_encrypted:
            reader.decrypt("")
        last = min(b or len(reader.pages), len(reader.pages))
        pages = []
        for i in range(a - 1, last):
            try:
                pages.append(reader.pages[i].extract_text() or "")
            except Exception:  # noqa: BLE001
                pages.append("")
    if pages and pages[-1].strip() == "":
        pages = pages[:-1]
    text = "".join(f"\n=== page {a + i} ===\n{p}" for i, p in enumerate(pages)).lstrip("\n")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
    chars = sum(len(p.strip()) for p in pages)
    note = f"- {out}\n  {len(pages)} page(s), {text.count(chr(10))} lines, {human(os.path.getsize(out))}; pages are marked `=== page N ===` - grep -n for them"
    if pages and chars / len(pages) < 25:
        note += ("\n  ! almost no text came out: the pages are scanned images. OCR (`ocrmypdf in.pdf out.pdf`) or render them "
                 "(`pdftoppm -png -r 150 -f N -l N in.pdf \"$TMPDIR/page\"`) and look - do not report it as blank.")
    return note


# ---------------------------------------------------------------- query
# A sheet or CSV streamed once into a SQLite file in $TMPDIR, kept while the document's size and mtime stay the same,
# so a second question costs a query rather than another parse - and only the answer reaches the conversation.

SQL_WORDS = {"abort", "all", "and", "as", "asc", "between", "by", "case", "check", "collate", "column", "create", "default",
             "delete", "desc", "distinct", "drop", "else", "end", "escape", "except", "exists", "from", "group", "having", "in",
             "index", "insert", "intersect", "into", "is", "join", "key", "like", "limit", "match", "natural", "no", "not",
             "null", "of", "offset", "on", "or", "order", "outer", "primary", "references", "select", "set", "table", "then",
             "to", "union", "unique", "update", "using", "values", "when", "where", "with"}
QUERYABLE = ("xlsx", "xlsm", "ods", "spreadsheetml", "html", "mhtml", "text", "xls", "xlsb")


def sql_name(raw, fallback):
    name = re.sub(r"\W+", "_", str(raw).strip().lower(), flags=re.UNICODE).strip("_") or fallback
    if name[0].isdigit():
        name = "c_" + name
    return name + "_" if name in SQL_WORDS else name


def to_number(v, decimal_comma=False):
    s = v.strip()
    if not s or len(s) > 40 or re.fullmatch(r"[-+]?0\d+", s):
        return None  # leading zeros make a code (phone, ID, postcode), not a number
    if decimal_comma:
        if not re.fullmatch(r"[-+]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?", s):
            return None
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"[-+]?\d{1,3}(,\d{3})+(\.\d+)?", s):
        s = s.replace(",", "")
    elif not re.fullmatch(r"[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?", s):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return int(s) if re.fullmatch(r"[-+]?\d{1,18}", s) else f


def comma_locale(values):
    """Do these numbers write 1.234,56 (Indonesia, most of Europe) rather than 1,234.56? Decided on the sample, so a
    bank export's "150.000" is a hundred and fifty thousand rather than 150."""
    comma = sum(1 for v in values if re.fullmatch(r"[-+]?(\d{1,3}(\.\d{3})+(,\d+)?|\d+,\d{1,2})", v.strip()))
    dot = sum(1 for v in values if re.fullmatch(r"[-+]?(\d+\.\d{1,2}|\d{1,3}(,\d{3})+(\.\d+)?)", v.strip()))
    return comma > dot


def load_table(con, book, index, table, header, decimal_comma):
    """Stream one sheet into `table`. Returns (rows, header row, [(column, letter, header text)], stats)."""
    st = {}
    rows = book.rows(index, st)
    sample = []
    for item in rows:
        sample.append(item)
        if len(sample) >= 12:
            break
    head = guess_header(sample) if header is None else (header or None)
    labels = dict(sample).get(head, {}) if head else {}
    if decimal_comma is None:
        decimal_comma = comma_locale([v for r, cells in sample if not head or r > head for v in cells.values()])
    st["decimal comma"] = decimal_comma
    cols, seen = [], set()

    def add(c):
        name = sql_name(labels.get(c, ""), col_letters(c).lower())
        base, n = name, 2
        while name in seen or name == "_row":
            name, n = f"{base}_{n}", n + 1
        seen.add(name)
        cols.append((c, name, labels.get(c, "")))
        return name

    con.execute(f'DROP TABLE IF EXISTS "{table}"')
    con.execute(f'CREATE TABLE "{table}" ("_row" INTEGER)')
    batch, count = [], 0

    def flush():
        if batch:
            names = ", ".join(f'"{n}"' for _, n, _ in cols)
            con.executemany(f'INSERT INTO "{table}" ("_row", {names}) VALUES ({", ".join("?" * (len(cols) + 1))})', batch)
            batch.clear()

    def take(r, cells):
        nonlocal count
        if head and r <= head:
            return
        missing = [c for c in sorted(cells) if c not in {k for k, _, _ in cols}]
        if missing:
            flush()
            for c in missing:
                con.execute(f'ALTER TABLE "{table}" ADD COLUMN "{add(c)}"')
        values = []
        for c, _, _ in cols:
            v = cells.get(c)
            n = to_number(v, decimal_comma) if isinstance(v, str) else None
            values.append(n if n is not None else (v if v != "" else None))
        batch.append([r] + values)
        count += 1
        if len(batch) >= 5000:
            flush()
    for c in sorted({c for _, cells in sample for c in cells}):
        if not head or c in labels or any(c in cells for r, cells in sample if r > head):
            add(c)
    con.execute(f'DROP TABLE "{table}"')
    con.execute(f'CREATE TABLE "{table}" ("_row" INTEGER{"".join(f", {chr(34)}{n}{chr(34)}" for _, n, _ in cols)})')
    for r, cells in sample:
        take(r, cells)
    for r, cells in rows:
        take(r, cells)
    flush()
    cols.sort()
    return count, head, [(n, col_letters(c), label) for c, n, label in cols], st


_QUOTED = re.compile(r"'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"")


def with_column_names(sql, loaded):
    """
    Every double-quoted name in `sql` checked against the loaded tables: a header's own words ("Unit Penagih") become
    the column's name (unit_penagih), and a name that is neither is returned as unknown. Without this SQLite reads an
    unknown "name" as the text 'name' - a GROUP BY "Unit Penagih" counted every row as one group, with no error (live,
    2026-10-20). An alias after AS is left alone; single-quoted text is never touched.
    """
    names, labels = {"_row"}, {}
    for table, cols in loaded:
        names.add(table.lower())
        for n, _, label in cols:
            names.add(n.lower())
            if label:
                labels.setdefault(str(label).strip().lower(), n)
    out, last, unknown = [], 0, None
    for m in _QUOTED.finditer(sql):
        token = m.group(0)
        out.append(sql[last:m.start()])
        last = m.end()
        if token.startswith("'"):
            out.append(token)
            continue
        inner = token[1:-1].replace('""', '"')
        before = sql[: m.start()].rstrip()
        if re.search(r"\bAS$", before, re.I) or inner.lower() in names:
            out.append(token)
        elif inner.strip().lower() in labels:
            out.append(f'"{labels[inner.strip().lower()]}"')
        else:
            unknown = unknown or inner
            out.append(token)
    out.append(sql[last:])
    return "".join(out), unknown


def query(args):
    path = args.file
    kind, facts = detect(path)
    if kind not in QUERYABLE:
        raise Refused(f"query reads tables (sheets, CSV); this is {describe(kind)} - use extract")
    import hashlib  # noqa: PLC0415
    import sqlite3  # noqa: PLC0415

    stat = os.stat(path)
    folder = ensure_dir(os.path.join(tmpdir(), "doc-query"))
    db = os.path.join(folder, hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:16] + ".sqlite")
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE IF NOT EXISTS _loaded (tbl TEXT PRIMARY KEY, sheet TEXT, stamp TEXT, header INTEGER, "
                "rows INTEGER, columns TEXT, notes TEXT)")
    stamp = f"{stat.st_size}:{stat.st_mtime_ns}"
    book_cache = []

    def book():
        if not book_cache:
            source, k, f = path, kind, facts
            if kind in ("xls", "xlsb"):
                source = libreoffice_convert(path, "xlsx")
                k, f = detect(source)
            b = open_book(source, k, f)
            if b is None:
                raise Refused("plain text with no delimiter found - not a table; read or grep it")
            book_cache.append(b)
        return book_cache[0]

    def ensure(index, table, header):
        # The sheet is part of the stamp: table t is whichever sheet --sheet named this time.
        mark = f"{stamp}:{index}:{header}"
        hit = con.execute("SELECT stamp FROM _loaded WHERE tbl = ?", (table,)).fetchone()
        if hit and hit[0] == mark:
            return "cached"
        b = book()
        rows, head, cols, st = load_table(con, b, index, table, header, False if isinstance(b, Xlsx) else None)
        notes = "numbers read as decimal-comma (1.234,56 = 1234.56)" if st.get("decimal comma") else ""
        if st.get("formulas without a cached value"):
            notes = (notes + "; " if notes else "") + (f"{st['formulas without a cached value']} formula cell(s) have no saved value and load as NULL - "
                     "recalculate with LibreOffice first if those matter")
        con.execute("INSERT OR REPLACE INTO _loaded VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (table, b.sheets[index]["name"], mark, head, rows, json.dumps(cols, ensure_ascii=False), notes))
        con.commit()
        return "loaded"

    # Sheet names are cheap to read; the cells are loaded only for the sheets the question names.
    names = [s["name"] for s in book().sheets]
    sheets = [{"name": n} for n in names]
    primary = pick_sheets(type("B", (), {"sheets": sheets})(), args.sheet)[0] if args.sheet else 0
    wanted = [(primary, "t", args.header)]
    sql = (args.sql or "").strip().rstrip(";")
    for i, s in enumerate(sheets):
        name = sql_name(s["name"], f"sheet{i + 1}")
        if i != primary and (re.search(r"\b" + re.escape(name) + r"\b", sql, re.I) or args.schema):
            wanted.append((i, name, None))
    status = [ensure(i, table, header) for i, table, header in wanted]
    out = []
    for (i, table, _), how in zip(wanted, status):
        sheet, head, rows, cols, notes = con.execute("SELECT sheet, header, rows, columns, notes FROM _loaded WHERE tbl = ?", (table,)).fetchone()
        out.append(f"table {table} = sheet {sheet!r}: {rows} rows" + (f" below header row {head}" if head else ", no header row")
                   + f" ({how})" + (f"\n  ! {notes}" if notes else ""))
        if args.schema or not sql:
            out.append("  columns: _row (the sheet's row number), " + ", ".join(
                f"{n}" + (f" <- {short(label, 30)!r}" if label else "") + f" [{letter}]" for n, letter, label in json.loads(cols)))
    if args.schema or not sql:
        others = [f"{sql_name(s['name'], f'sheet{i + 1}')} = {s['name']!r}" for i, s in enumerate(sheets) if i != primary]
        if others:
            out.append("other sheets, loaded when a query names them: " + ", ".join(others))
        if not sql:
            out.append('ask with: doc.py query FILE "SELECT ... FROM t WHERE ..." (double-quote a column name that clashes with SQL)')
            return "\n".join(out), 0
    con.execute("PRAGMA query_only = ON")
    loaded = [(table, json.loads(con.execute("SELECT columns FROM _loaded WHERE tbl = ?", (table,)).fetchone()[0])) for _, table, _ in wanted]
    sql, unknown = with_column_names(sql, loaded)
    if unknown:
        return "\n".join([f'"{unknown}" is not a column or a table here - SQLite would have read it as the text '
                           f"'{unknown}' and answered without an error. Use a column name below; a header's own words "
                           "in double quotes work too."] + [f"table {t}: _row, " + ", ".join(
                               n + (f" <- {label!r}" if label else "") for n, _, label in cols) for t, cols in loaded]), 1
    try:
        cur = con.execute(sql)
    except sqlite3.Error as e:
        return "\n".join([f"SQL error: {e}"] + out + ["columns are listed above - quote a name with double quotes if it clashes"]), 1
    if cur.description is None:
        return "\n".join(out + ["(no result rows - query only reads)"]), 0
    names = [d[0] for d in cur.description]
    if args.out:
        n = 0
        guard_out(args.out, path)
        with open(args.out, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh, lineterminator="\n")
            w.writerow(names)
            for row in cur:
                w.writerow(row)
                n += 1
        out.append(f"wrote {n} result rows to {args.out} ({human(os.path.getsize(args.out))})")
        return "\n".join(out), 0
    got = cur.fetchmany(args.limit + 1)
    more = len(got) > args.limit
    total = con.execute(f"SELECT COUNT(*) FROM ({sql})").fetchone()[0] if more else len(got)
    out.append("")
    out.extend(md_table([names] + [["" if v is None else short(v, 80) for v in row] for row in got[: args.limit]]))
    out.append(f"\n{total} row(s)" + (f", showing the first {args.limit} - narrow it (WHERE, GROUP BY, LIMIT) or --out FILE "
                                       "to write them all" if more else ""))
    return "\n".join(out), 0


# ---------------------------------------------------------------- main


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"doc.py: {message}", file=sys.stderr)
        sys.exit(1)


def main(argv=None):
    parser = Parser(prog="doc.py", description="Inspect a document, or extract part of it to a file.")
    sub = parser.add_subparsers(dest="cmd")
    pi = sub.add_parser("inspect", help="what is in it: type, sheets/sections/slides/pages, and what to watch for")
    pi.add_argument("file")
    pi.add_argument("--json", action="store_true", help="JSON instead of Markdown")
    pi.add_argument("--sheet", help="only this sheet (name or 1-based number)")
    pe = sub.add_parser("extract", help="to CSV/Markdown/text in a file - never into the reply")
    pe.add_argument("file")
    pe.add_argument("--sheet", help="sheet name or 1-based number (default: every sheet, one file each)")
    pe.add_argument("--table", type=int, help="for an HTML 'spreadsheet': which table (1-based)")
    pe.add_argument("--range", help="cells, e.g. A1:H200, B3, or A:H")
    pe.add_argument("--rows", help="row span to page a big sheet, e.g. 1-500 or 501-")
    pe.add_argument("--pages", help="PDF page span, e.g. 3-5")
    pe.add_argument("--format", choices=["csv", "tsv", "md"], help="tables: csv (default), tsv or md")
    pe.add_argument("--formulas", action="store_true", help="write formulas (=SUM(...)) instead of their values")
    pe.add_argument("--changes", action="store_true", help="Word: mark tracked changes {+ins+} [-del-] instead of accepting them")
    pe.add_argument("--out", help="output file (default: $TMPDIR/doc-extract/...)")
    pq = sub.add_parser("query", help="SQL over a sheet or CSV, through a cached SQLite file; prints only the answer")
    pq.add_argument("file")
    pq.add_argument("sql", nargs="?", help='e.g. "SELECT nama, SUM(jumlah) FROM t GROUP BY nama" - the sheet is table t')
    pq.add_argument("--sheet", help="the sheet that is table t (default: the first); other sheets by their own names")
    pq.add_argument("--header", type=int, help="the header row (default: guessed, as inspect does); 0 = no header")
    pq.add_argument("--schema", action="store_true", help="list the tables and columns, then stop")
    pq.add_argument("--limit", type=int, default=50, help="rows printed at most (default 50)")
    pq.add_argument("--out", help="write every result row to this CSV instead of printing")
    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_help()
        return 1
    try:
        if args.cmd == "inspect":
            only = None
            if args.sheet:
                kind, facts = detect(args.file)
                book = open_book(args.file, kind, facts) if kind in ("xlsx", "xlsm", "ods", "spreadsheetml", "html", "mhtml") else None
                only = pick_sheets(book, args.sheet)[0] if book else None
            rep = inspect(args.file, only)
            print(json.dumps(rep, ensure_ascii=False, indent=1, default=str) if args.json else render(rep))
        elif args.cmd == "query":
            text, code = query(args)
            print(text)
            return code
        else:
            for line in extract(args.file, args):
                print(line)
        return 0
    except Refused as e:
        print(f"doc.py: cannot read {args.file}: {e}", file=sys.stderr)
        return 2
    except Missing as e:
        print(f"doc.py: {e}", file=sys.stderr)
        return 3
    except ValueError as e:
        print(f"doc.py: bad argument: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except OSError as e:
        # A path that is not the document - the cache under $TMPDIR, an --out file - is not the document's fault.
        if e.filename and os.path.abspath(str(e.filename)) != os.path.abspath(args.file):
            print(f"doc.py: {e.strerror or e}: {e.filename} - not the document; check $TMPDIR or the output path", file=sys.stderr)
            return 1
        if os.environ.get("DOC_DEBUG"):
            raise
        print(f"doc.py: could not read {args.file}: {type(e).__name__}: {e}", file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001 - one line, never a traceback (DOC_DEBUG=1 shows it)
        if os.environ.get("DOC_DEBUG"):
            raise
        print(f"doc.py: could not read {args.file}: {type(e).__name__}: {e} - the file may be damaged or unusual; "
              "try the CLI route in the skill (pdftotext / pandoc / libreoffice)", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
