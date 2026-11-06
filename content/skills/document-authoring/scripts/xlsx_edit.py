#!/usr/bin/env python3
"""
xlsx_edit.py - change an existing Excel workbook without silently losing what openpyxl cannot carry.

    python3 xlsx_edit.py check FILE
    python3 xlsx_edit.py apply FILE PLAN.json [--out COPY] [--accept-loss]

`check` needs only the standard library: it lists what the workbook holds that openpyxl drops or damages on save
(charts it rebuilds, shapes, slicers, Power Query, data validation stored in extLst, ...) and says whether `apply`
would go ahead.

`apply` never writes FILE. It writes a copy (default $TMPDIR/<name>.edited.<ext>), reopens it, checks every cell it
set, and compares the copy's parts with the original's - anything that went missing deletes the copy and exits 5,
unless --accept-loss. A workbook holding something on the drop list is refused before any work (exit 4), unless
--accept-loss. Macros (.xlsm) are kept with keep_vba, and the copy keeps the extension.

The plan is JSON - a list of operations, applied in order:

    {"ops": [
      {"add_sheet": "KK 1.2b", "after": "KK 1.2", "copy_of": "KK 1.2"},
      {"set": {"KK 1.2b!B4": "Nilai", "'KK 1.2b'!C4": 12.5, "Rekap!D10": "=SUM('KK 1.2b'!C4:C20)"}},
      {"rows": "KK 1.2b!A5", "values": [["a", 1], ["b", 2]]},
      {"append": "Rekap", "values": [["x", 3]]}
    ]}

    add_sheet  name; optional "after"/"before" a sheet, or "index" (1-based); optional "copy_of" a sheet
               (cells, styles, merges, validation, conditional formats, freeze panes, print titles - not its
               charts, images or tables, which openpyxl cannot copy; the report says if any were left behind)
    set        {"Sheet!A1": value}; a string starting with "=" is a formula
    rows       a block of rows written from a top-left cell
    append     rows after the sheet's last row with a value (not Excel's padded last row), styled like that row
    values     number, true/false, null (clears), "text", "=FORMULA", {"text": "=not a formula"},
               {"date": "2026-10-20"}, {"value": 0.25, "format": "0%"}

openpyxl writes no calculated values: every formula in the copy is empty to anything that reads values (pandas,
doc.py extract) until Excel or LibreOffice recalculates it. The copy is marked to recalculate when Excel opens it.

Exit: 0 written and verified; 1 usage or plan error; 2 cannot read; 3 openpyxl missing; 4 refused before editing;
5 the copy lost something and was deleted.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import warnings
import zipfile


class Stop(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# (label, part-name pattern, severity, what openpyxl does with it). "refuse" stops apply; "note" is reported.
PARTS = [
    ("charts", r"xl/charts/chart\d+\.xml$", "refuse",
     "rebuilt from what openpyxl understands - titles, colours, labels and formatting are often lost"),
    ("chart sheets", r"xl/chartsheets/sheet\d+\.xml$", "refuse", "dropped"),
    ("images", r"xl/media/", "pillow", "kept only when Pillow is installed in this Python - otherwise dropped"),
    ("slicers", r"xl/slicers?(Caches)?/", "refuse", "dropped"),
    ("timelines", r"xl/timeline", "refuse", "dropped"),
    ("threaded comments", r"xl/threadedComments/", "refuse", "dropped (classic notes survive)"),
    ("form controls", r"xl/ctrlProps/", "refuse", "dropped"),
    ("ActiveX controls", r"xl/activeX/", "refuse", "dropped"),
    ("data connections / Power Query", r"xl/(connections\.xml$|queryTables/)", "refuse", "dropped - the data can no longer be refreshed"),
    ("data model", r"xl/model/", "refuse", "dropped"),
    ("images in cells", r"xl/richData/", "refuse", "dropped"),
    ("custom ribbon", r"customUI/", "refuse", "dropped"),
    ("pivot tables", r"xl/pivotTables/pivotTable\d+\.xml$", "note", "kept as they are, not refreshed"),
    ("tables", r"xl/tables/table\d+\.xml$", "note", "kept"),
    ("external links", r"xl/externalLinks/externalLink\d+\.xml$", "note", "kept"),
    ("macros (VBA)", r"xl/vbaProject\.bin$", "note",
     "kept (opened with keep_vba, copy stays .xlsm); a digital signature on the macros does not survive"),
    ("custom XML parts", r"customXml/item\d+\.xml$", "note", "may be dropped - usually SharePoint or label metadata, not content"),
]
# (label, element, where in the sheet XML, severity, what happens)
COUNTED = [
    ("data validation", "dataValidation", "main", "note", "kept"),
    ("data validation in extLst", "dataValidation", "ext", "refuse",
     "dropped - Excel stores lists that point at another sheet this way, so the dropdowns vanish"),
    ("conditional formats", "conditionalFormatting", "main", "note", "kept"),
    ("conditional formats in extLst", "conditionalFormatting", "ext", "refuse", "dropped (newer data bars, icon sets)"),
    ("sparklines", "sparklineGroup", "ext", "refuse", "dropped"),
    ("merged ranges", "mergeCell", "main", "note", "kept"),
    ("hyperlinks", "hyperlink", "main", "note", "kept"),
]


def count(tag, data):
    return len(re.findall(rb"<(?:[\w.-]+:)?" + tag.encode() + rb"[\s/>]", data))


def features(path):
    """{label: count} for everything on the two lists above, read straight from the zip."""
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise Stop(2, f"{path} is not a readable .xlsx/.xlsm ({e}) - run doc.py inspect on it to see what it is") from None
    with z:
        names = z.namelist()
        if any(i.flag_bits & 1 for i in z.infolist()):
            raise Stop(2, f"{path} has encrypted parts - it needs a password")
        if "xl/workbook.xml" not in names:
            raise Stop(2, f"{path} is a zip but not an Excel workbook (no xl/workbook.xml) - run doc.py inspect on it")
        found = {}
        for label, pattern, _, _ in PARTS:
            n = sum(1 for name in names if re.match(pattern, name))
            if n:
                found[label] = n
        if any(name.startswith("customXml/item") and b"DataMashup" in z.read(name) for name in names):
            found["data connections / Power Query"] = found.get("data connections / Power Query", 0) + 1
        for name in names:
            if re.match(r"xl/worksheets/sheet\d+\.xml$", name):
                main, _, ext = z.read(name).partition(b"<extLst")
                for label, tag, where, _, _ in COUNTED:
                    n = count(tag, main if where == "main" else ext)
                    if n:
                        found[label] = found.get(label, 0) + n
            elif re.match(r"xl/comments[^/]*\.xml$|xl/comments/comment\d+\.xml$", name):
                n = count("comment", z.read(name))
                if n:
                    found["classic comments"] = found.get("classic comments", 0) + n
            elif re.match(r"xl/drawings/drawing\d+\.xml$", name):
                n = count("sp", z.read(name))
                if n:
                    found["shapes / text boxes"] = found.get("shapes / text boxes", 0) + n
        n = count("definedName", z.read("xl/workbook.xml"))
        if n:
            found["named ranges"] = n
        found["sheets"] = count("sheet", z.read("xl/workbook.xml"))
    return found


def verdicts(found):
    """[(label, count, refuse?, what happens)] - what openpyxl will do to each thing found."""
    pillow = importlib.util.find_spec("PIL") is not None
    table = {label: (sev, what) for label, _, sev, what in PARTS}
    table.update({label: (sev, what) for label, _, _, sev, what in COUNTED})
    table["shapes / text boxes"] = ("refuse", "dropped")
    table["classic comments"] = ("note", "kept; their box size and formatting are reset")
    out = []
    for label, n in found.items():
        sev, what = table.get(label, ("note", "kept"))
        if sev == "pillow":
            sev, what = ("note", "kept (Pillow is installed)") if pillow else ("refuse", "dropped - Pillow is not installed (`pip install pillow`)")
        out.append((label, n, sev == "refuse", what))
    return out


def lock_files(path):
    folder, base = os.path.split(os.path.abspath(path))
    names = {"~$" + base, "~$" + base[2:], ".~lock." + base + "#"}
    return sorted(n for n in names if os.path.exists(os.path.join(folder, n)))


def check_report(path):
    found = features(path)
    rows = verdicts(found)
    lines = [f"# {path}"]
    locks = lock_files(path)
    if locks:
        lines.append(f"! open in an editor right now ({', '.join(locks)}) - edit a copy, and do not copy anything back over it "
                     "until they have closed it")
    for label, n, refuse, what in rows:
        if label == "sheets":
            continue
        lines.append(f"- {label}: {n} - {'WOULD BE LOST: ' if refuse else ''}{what}")
    blocking = [label for label, _, refuse, _ in rows if refuse]
    if blocking:
        lines.append(f"\nverdict: apply refuses this workbook ({', '.join(blocking)}). Options: edit it in Excel or LibreOffice "
                     "instead; or, if losing those is acceptable and the person agrees, --accept-loss.")
    else:
        lines.append("\nverdict: safe for apply - nothing here is on openpyxl's drop list.")
    return "\n".join(lines), blocking


# ---------------------------------------------------------------- the plan

REF = re.compile(r"^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Za-z]{1,3})\$?(\d+)$")
BAD_NAME = re.compile(r"[\[\]:*?/\\]")


def split_ref(text):
    m = REF.match(str(text).strip())
    if not m:
        raise Stop(1, f"{text!r} is not a cell reference like Sheet!B4 or 'KK 1.2b'!B4")
    sheet = m.group(1).replace("''", "'") if m.group(1) is not None else m.group(2).strip()
    return sheet, f"{m.group(3).upper()}{m.group(4)}"


def sheet_of(wb, name):
    if name in wb.sheetnames:
        return wb[name]
    for title in wb.sheetnames:
        if title.lower() == str(name).lower():
            return wb[title]
    raise Stop(1, f"no sheet {name!r} - the sheets are: {', '.join(repr(s) for s in wb.sheetnames)}")


def convert(value):
    """(value, number format or None, force text?)"""
    if isinstance(value, dict):
        if "text" in value:
            return str(value["text"]), None, True
        if "date" in value:
            text = str(value["date"])
            try:
                parsed = dt.datetime.fromisoformat(text)
            except ValueError:
                raise Stop(1, f"{text!r} is not an ISO date (YYYY-MM-DD or YYYY-MM-DD HH:MM)") from None
            return (parsed.date() if len(text) <= 10 else parsed), ("yyyy-mm-dd" if len(text) <= 10 else "yyyy-mm-dd hh:mm"), False
        if "formula" in value:
            return "=" + str(value["formula"]).lstrip("="), None, False
        if "value" in value:
            return value["value"], value.get("format"), False
        raise Stop(1, f"cannot read the value {value!r}")
    if isinstance(value, (list, tuple)):
        raise Stop(1, f"a single cell cannot hold a list ({value!r}) - use rows")
    return value, None, False


def write_cell(ws, coord, raw, changes, style_from=None):
    from openpyxl.cell.cell import MergedCell  # noqa: PLC0415

    cell = ws[coord]
    if isinstance(cell, MergedCell):
        top = next((str(r).split(":")[0] for r in ws.merged_cells.ranges if coord in r), "?")
        raise Stop(1, f"{ws.title}!{coord} is inside a merged range - write to its top-left cell {top}")
    value, fmt, text = convert(raw)
    old = cell.value
    if style_from is not None and style_from.has_style:
        cell._style = copy.copy(style_from._style)
    cell.value = value
    if text:
        cell.data_type = "s"
    if fmt:
        cell.number_format = fmt
    changes.append((ws.title, coord, old, value))


def last_row(ws):
    for row in range(ws.max_row, 0, -1):
        if any(c.value is not None for c in ws[row]):
            return row
    return 0


def place(wb, ws, op):
    if "index" in op:
        target = int(op["index"]) - 1
    elif "after" in op:
        target = wb.sheetnames.index(sheet_of(wb, op["after"]).title) + 1
    elif "before" in op:
        target = wb.sheetnames.index(sheet_of(wb, op["before"]).title)
    else:
        return
    current = wb.sheetnames.index(ws.title)
    if target > current:
        target -= 1
    wb.move_sheet(ws, offset=target - current)


def copy_extras(src, new, notes):
    for dv in src.data_validations.dataValidation:
        new.add_data_validation(copy.deepcopy(dv))
    for cf in src.conditional_formatting:
        for rule in cf.rules:
            new.conditional_formatting.add(str(cf.sqref), copy.deepcopy(rule))
    new.freeze_panes = src.freeze_panes
    for attr in ("print_title_rows", "print_title_cols"):
        if getattr(src, attr):
            setattr(new, attr, getattr(src, attr))
    if src.auto_filter.ref:
        new.auto_filter.ref = src.auto_filter.ref
    if src.sheet_properties.tabColor is not None:
        new.sheet_properties.tabColor = copy.deepcopy(src.sheet_properties.tabColor)
    left = {"charts": len(getattr(src, "_charts", [])), "images": len(getattr(src, "_images", [])), "tables": len(src.tables)}
    left = {k: v for k, v in left.items() if v}
    if left:
        notes.append(f"{new.title}: copied from {src.title} without its " + ", ".join(f"{v} {k}" for k, v in left.items())
                     + " - openpyxl cannot copy those; add them in Excel if they are needed")


def apply_ops(wb, ops, changes, notes):
    for i, op in enumerate(ops, 1):
        if not isinstance(op, dict):
            raise Stop(1, f"operation {i} is not an object")
        if "add_sheet" in op:
            name = str(op["add_sheet"])
            if not name or len(name) > 31 or BAD_NAME.search(name) or name.startswith("'") or name.endswith("'"):
                raise Stop(1, f"{name!r} cannot be a sheet name: at most 31 characters, none of [ ] : * ? / \\, no quote at either end")
            if name.lower() in (s.lower() for s in wb.sheetnames):
                raise Stop(1, f"a sheet named {name!r} already exists")
            if "copy_of" in op:
                src = sheet_of(wb, op["copy_of"])
                ws = wb.copy_worksheet(src)
                ws.title = name
                copy_extras(src, ws, notes)
            else:
                ws = wb.create_sheet(name)
            place(wb, ws, op)
            notes.append(f"added sheet {name!r} at position {wb.sheetnames.index(name) + 1}" + (f", a copy of {op['copy_of']!r}" if "copy_of" in op else ""))
        elif "set" in op:
            if not isinstance(op["set"], dict):
                raise Stop(1, f"operation {i}: set takes an object of {{\"Sheet!A1\": value}}")
            for ref, value in op["set"].items():
                sheet, coord = split_ref(ref)
                write_cell(sheet_of(wb, sheet), coord, value, changes)
        elif "rows" in op or "append" in op:
            values = op.get("values")
            if not isinstance(values, list) or not all(isinstance(r, list) for r in values):
                raise Stop(1, f"operation {i}: values must be a list of rows, each a list")
            from openpyxl.utils import column_index_from_string, get_column_letter  # noqa: PLC0415

            if "rows" in op:
                sheet, coord = split_ref(op["rows"])
                ws = sheet_of(wb, sheet)
                m = re.match(r"([A-Z]+)(\d+)", coord)
                col0, row0 = column_index_from_string(m.group(1)), int(m.group(2))
                style_row = None
            else:
                ws = sheet_of(wb, op["append"])
                base = last_row(ws)
                col0, row0 = 1, base + 1
                style_row = base if base and op.get("keep_style", True) else None
            for dr, row in enumerate(values):
                for dc, value in enumerate(row):
                    col = col0 + dc
                    src = ws.cell(row=style_row, column=col) if style_row else None
                    write_cell(ws, f"{get_column_letter(col)}{row0 + dr}", value, changes, src)
        else:
            raise Stop(1, f"operation {i} has none of add_sheet, set, rows, append: {json.dumps(op)[:120]}")


def shown(value):
    """A cell value as a person reads it: rich text as its plain text, a date as ISO."""
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat(sep=" ") if isinstance(value, dt.datetime) else value.isoformat()
    if value is not None and type(value).__name__ == "CellRichText":
        value = str(value)
    return repr(value)


def same(expected, actual):
    if isinstance(expected, dt.date) and isinstance(actual, dt.datetime):
        return actual.date() == expected or actual == expected
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)) and not isinstance(expected, bool):
        return abs(expected - actual) < 1e-9
    return expected == actual


def apply(path, plan_path, out, accept_loss):
    if not os.path.isfile(path):
        raise Stop(2, f"no such file: {path}")
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        raise Stop(2, f"{ext or 'no extension'}: this edits .xlsx/.xlsm only - convert a .xls/.ods with LibreOffice first "
                   "(`libreoffice --headless --convert-to xlsx`), and say so to the person")
    out = out or os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(),
                              os.path.splitext(os.path.basename(path))[0] + ".edited" + ext)
    if os.path.abspath(out) == os.path.abspath(path):
        raise Stop(2, "--out is the original - this never writes over it. Write the copy, check it, then replace the "
                   "original yourself (after keeping a backup)")
    if os.path.splitext(out)[1].lower() != ext:
        raise Stop(2, f"the copy must keep the {ext} extension - Excel refuses a workbook whose extension does not match its content")
    if os.path.exists(out):
        raise Stop(2, f"{out} already exists - pick another --out, or delete it if it is an old copy of yours")
    try:
        with open(plan_path, encoding="utf-8") as fh:
            plan = json.load(fh)
    except (OSError, ValueError) as e:
        raise Stop(1, f"cannot read the plan {plan_path}: {e}") from None
    ops = plan.get("ops") if isinstance(plan, dict) else plan
    if not isinstance(ops, list) or not ops:
        raise Stop(1, 'the plan needs {"ops": [ ... ]} with at least one operation')

    before = features(path)
    blocking = [label for label, _, refuse, _ in verdicts(before) if refuse]
    if blocking and not accept_loss:
        report, _ = check_report(path)
        raise Stop(4, report)
    try:
        import openpyxl  # noqa: PLC0415
    except ImportError:
        raise Stop(3, "this needs openpyxl in the Python that runs it: `pip install openpyxl` (on a Nouride host `pip` "
                   "already installs into the shared env). Pillow too if the workbook has images: `pip install pillow`") from None

    vba = ext in (".xlsm", ".xltm")
    said = warnings.catch_warnings(record=True)
    heard = said.__enter__()
    warnings.simplefilter("always")
    try:
        try:
            wb = openpyxl.load_workbook(path, keep_vba=vba, keep_links=True, rich_text=True)
        except TypeError:
            wb = openpyxl.load_workbook(path, keep_vba=vba, keep_links=True)
    except Exception as e:  # noqa: BLE001 - openpyxl raises many kinds for a file it cannot read
        said.__exit__(None, None, None)
        raise Stop(2, f"openpyxl cannot open it ({type(e).__name__}: {e})") from None
    said.__exit__(None, None, None)

    changes, notes = [], []
    apply_ops(wb, ops, changes, notes)
    if wb.calculation is None:
        from openpyxl.workbook.properties import CalcProperties  # noqa: PLC0415

        wb.calculation = CalcProperties()
    wb.calculation.fullCalcOnLoad = True
    folder = os.path.dirname(os.path.abspath(out))
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=ext, dir=folder)
    os.close(fd)
    try:
        wb.save(tmp)
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    try:
        check = openpyxl.load_workbook(out, keep_vba=vba)
    except Exception as e:  # noqa: BLE001
        os.remove(out)
        raise Stop(5, f"the copy did not reopen ({type(e).__name__}: {e}) - deleted it; nothing was changed") from None
    wrong = []
    for sheet, coord, _, value in changes:
        got = check[sheet][coord].value
        if not same(value, got):
            wrong.append(f"{sheet}!{coord}: wrote {value!r}, reads back {got!r}")
    after = features(out)
    lost = {k: (v, after.get(k, 0)) for k, v in before.items() if after.get(k, 0) < v}
    if wrong or (lost and not accept_loss):
        os.remove(out)
        detail = [f"- {k}: {a} in the original, {b} in the copy" for k, (a, b) in lost.items()] + [f"- {w}" for w in wrong]
        raise Stop(5, "the copy was not faithful, so it was deleted and nothing changed:\n" + "\n".join(detail))

    # The copy's fingerprint, so a copy back to another machine is checked in one step: the far side's must match.
    with open(out, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    lines = [f"wrote {out} (the original is untouched)",
             f"copy: {os.path.getsize(out)} bytes, sha256 {digest} - after copying it anywhere, compare there",
             f"sheets: {' | '.join(check.sheetnames)}"]
    lines += [f"- {n}" for n in notes]
    lines += [f"- openpyxl said: {m}" for m in sorted({str(w.message) for w in heard} - {"Workbook contains no default style, apply openpyxl's default"})]
    if changes:
        lines.append(f"{len(changes)} cell(s) set:")
        for sheet, coord, old, value in changes[:40]:
            lines.append(f"- {sheet}!{coord}: {shown(old)} -> {shown(value)}")
        if len(changes) > 40:
            lines.append(f"- ... {len(changes) - 40} more")
    if lost:
        lines.append("lost, as accepted: " + ", ".join(f"{k} ({a} -> {b})" for k, (a, b) in lost.items()))
    locks = lock_files(path)
    if locks:
        lines.append(f"! the original is open in an editor ({', '.join(locks)}) - do not copy this over it until it is closed")
    lines.append("verified: reopens, every cell reads back as written, and " + ("nothing went missing beyond the losses above" if lost else "no part of the workbook went missing"))
    lines.append("formulas: openpyxl stores none of their results - Excel recalculates on open (flag set); to read computed "
                 f"values here: `libreoffice --headless --convert-to xlsx --outdir \"$TMPDIR/recalc\" {out}`")
    return "\n".join(lines)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        self.print_usage(sys.stderr)
        print(f"xlsx_edit.py: {message}", file=sys.stderr)
        sys.exit(1)


def main(argv=None):
    parser = Parser(prog="xlsx_edit.py", description="Edit a copy of an Excel workbook, refusing what openpyxl would lose.")
    sub = parser.add_subparsers(dest="cmd")
    pc = sub.add_parser("check", help="what openpyxl would lose; exit 4 if apply would refuse")
    pc.add_argument("file")
    pa = sub.add_parser("apply", help="apply a JSON plan to a copy")
    pa.add_argument("file")
    pa.add_argument("plan")
    pa.add_argument("--out", help="the copy to write (default $TMPDIR/<name>.edited.<ext>)")
    pa.add_argument("--accept-loss", action="store_true", help="go ahead even though something listed by check will be lost")
    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_help()
        return 1
    try:
        if args.cmd == "check":
            if not os.path.isfile(args.file):
                raise Stop(2, f"no such file: {args.file}")
            report, blocking = check_report(args.file)
            print(report)
            return 4 if blocking else 0
        print(apply(args.file, args.plan, args.out, args.accept_loss))
        return 0
    except Stop as e:
        print(f"xlsx_edit.py: {e}", file=sys.stderr)
        return e.code
    except Exception as e:  # noqa: BLE001 - one line, never a traceback (XLSX_EDIT_DEBUG=1 shows it)
        if os.environ.get("XLSX_EDIT_DEBUG"):
            raise
        print(f"xlsx_edit.py: {type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
