#!/usr/bin/env python3
"""Draw a diagram from a small JSON spec, or render a Graphviz file, with the checks a finished picture needs.

  diagram.py render spec.json --out <dir>/<name>   # JSON spec -> <name>.dot, <name>.svg, <name>.png
  diagram.py dot file.dot --out <dir>/<name>       # your own Graphviz file -> .svg and .png
  diagram.py fonts                                 # which of the usual fonts this machine has
  diagram.py example                               # a spec to start from

Standard library only; needs Graphviz's `dot`. Prints what it wrote, how many arrows cross, and every warning; exits 1
when nothing usable was made.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

KINDS = {
    # kind: (shape, light fill, light border, dark fill, dark border)
    "service": ("box", "#EEF2FF", "#4F46E5", "#1E1B4B", "#818CF8"),
    "app": ("box", "#EEF2FF", "#4F46E5", "#1E1B4B", "#818CF8"),
    "db": ("cylinder", "#F5F3FF", "#7C3AED", "#2E1065", "#A78BFA"),
    "storage": ("cylinder", "#F5F3FF", "#7C3AED", "#2E1065", "#A78BFA"),
    "queue": ("box3d", "#FFF7ED", "#EA580C", "#431407", "#FB923C"),
    "user": ("oval", "#ECFDF5", "#059669", "#022C22", "#34D399"),
    "person": ("oval", "#ECFDF5", "#059669", "#022C22", "#34D399"),
    "external": ("box", "#F8FAFC", "#64748B", "#0F172A", "#94A3B8"),
    "cloud": ("box", "#FFF7ED", "#F97316", "#431407", "#FB923C"),
    "device": ("box", "#F0F9FF", "#0284C7", "#082F49", "#38BDF8"),
    "network": ("hexagon", "#F0FDF4", "#16A34A", "#052E16", "#4ADE80"),
    "decision": ("diamond", "#FEFCE8", "#CA8A04", "#422006", "#FACC15"),
    "step": ("box", "#FFFFFF", "#334155", "#111827", "#CBD5E1"),
    "note": ("note", "#FEFCE8", "#A16207", "#422006", "#FDE047"),
}
FONTS = ["Inter", "DejaVu Sans", "Helvetica", "Arial", "Liberation Sans", "Noto Sans"]
MAX_NODES = 12
MAX_LABEL = 32
MAX_CROSSINGS = 1          # one crossing the shape forces is fine; past it the reader starts losing which arrow goes where
SPLINES = {"spline": "true", "ortho": "ortho", "polyline": "polyline"}

EXAMPLE = {
    "title": "Home setup",
    "direction": "LR",
    "theme": "light",
    "groups": [{"id": "home", "label": "Home network"}],
    "nodes": [
        {"id": "phone", "label": "Phone", "kind": "user"},
        {"id": "box", "label": "Nouride box", "kind": "service", "group": "home"},
        {"id": "ha", "label": "Home Assistant", "kind": "service", "group": "home"},
        {"id": "cam", "label": "CCTV", "kind": "device", "group": "home"},
    ],
    "edges": [
        {"from": "phone", "to": "box", "label": "Tailscale"},
        {"from": "box", "to": "ha", "label": "REST"},
        {"from": "ha", "to": "cam", "label": "RTSP", "style": "dashed"},
    ],
}


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def installed_font():
    """The first of the usual fonts fc-list knows; Graphviz falls back silently to one that looks wrong."""
    if not shutil.which("fc-list"):
        return None, []
    try:
        listed = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True, timeout=20).stdout
    except subprocess.TimeoutExpired:
        return None, []
    have = [font for font in FONTS if font.lower() in listed.lower()]
    return (have[0] if have else None), have


def back_edges(nodes, edges):
    """Edges that close a loop, taking the edges in the order the spec lists them: the main path is written first.

    dot ranks a graph by turning one edge of every loop around, and that edge still pulls: the node it points at is
    dragged to the far end, and the arrow comes back as a long arc. dot picks the edge by its own walk, which can be
    the main path (a client -> API). Read in the spec's order, the edge that closes a loop is the one written after
    the path it returns along - the reply, the callback, the notification. "constraint": false on it is the fix, and
    an edge marked so is not counted.
    """
    ids = {n["id"] for n in nodes}
    out = {i: set() for i in ids}

    def reaches(a, b):
        seen, todo = set(), [a]
        while todo:
            n = todo.pop()
            if n == b:
                return True
            if n not in seen:
                seen.add(n)
                todo.extend(out[n])
        return False

    found = []
    for e in edges:
        a, b = e.get("from"), e.get("to")
        if e.get("constraint") is False or a not in ids or b not in ids:
            continue
        if reaches(b, a):
            found.append((a, b))
        else:
            out[a].add(b)
    return found


def quote(text):
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def to_dot(spec, warnings):
    theme = spec.get("theme", "light")
    if theme not in ("light", "dark"):
        warnings.append(f'theme "{theme}" is not light or dark; light used')
        theme = "light"
    dark = theme == "dark"
    direction = spec.get("direction", "LR")
    if direction not in ("LR", "TB", "RL", "BT"):
        warnings.append(f'direction "{direction}" is not LR, TB, RL or BT; LR used')
        direction = "LR"
    splines = spec.get("splines", "spline")
    if splines not in SPLINES:
        warnings.append(f'splines "{splines}" is not one of {", ".join(SPLINES)}; spline used')
        splines = "spline"
    # Graphviz cannot place a label on a right-angled edge ("Orthogonal edges do not currently handle edge labels"),
    # so with ortho the label goes beside the edge instead.
    label_attr = "xlabel" if splines == "ortho" else "label"
    font, _ = installed_font()
    fontname = font or "sans-serif"
    if not font:
        warnings.append("none of " + ", ".join(FONTS) + " is installed: text falls back to whatever Graphviz finds. Look at the PNG")
    bg, fg, edge = ("#0D1117", "#E6EDF3", "#8B949E") if dark else ("#FFFFFF", "#0F172A", "#475569")

    nodes = spec.get("nodes") or []
    edges = spec.get("edges") or []
    groups = {g["id"]: g for g in (spec.get("groups") or []) if "id" in g}
    if not nodes:
        fail("the spec has no nodes")
    ids = [n.get("id") for n in nodes]
    if any(not i for i in ids):
        fail("every node needs an id")
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        fail("node ids used twice: " + ", ".join(dupes))
    if len(nodes) > MAX_NODES:
        warnings.append(f"{len(nodes)} nodes: past {MAX_NODES} a first diagram is hard to read. Offer a simpler one with the main parts")
    linked = set()
    for e in edges:
        for end in ("from", "to"):
            if e.get(end) not in ids:
                fail(f"edge {e.get('from')} -> {e.get('to')}: no node with id {e.get(end)!r}")
        linked.update((e["from"], e["to"]))
    loops = back_edges(nodes, edges)
    if loops:
        warnings.append("arrows going back against the flow drag the layout - the node they point at is pulled to the "
                        "far end and the arrow returns as a long arc: " + ", ".join(f"{a} -> {b}" for a, b in loops)
                        + '. Mark each one "constraint": false (a reply, a callback, a notification), so the main '
                        "path stays straight")
    for n in nodes:
        if len(nodes) > 1 and n["id"] not in linked:
            warnings.append(f"node {n['id']!r} has no edge: is a line missing?")
        if len(str(n.get("label", n["id"]))) > MAX_LABEL and "\n" not in str(n.get("label", "")):
            warnings.append(f"label of {n['id']!r} is over {MAX_LABEL} characters: break it with \\n or shorten it")
        if n.get("kind", "service") not in KINDS:
            warnings.append(f"kind {n.get('kind')!r} of {n['id']!r} is unknown; service used. Kinds: " + ", ".join(KINDS))
        if n.get("group") and n["group"] not in groups:
            warnings.append(f"group {n['group']!r} of {n['id']!r} is not in groups; drawn outside any")

    lines = [
        "digraph G {",
        f"  graph [rankdir={direction}, bgcolor={quote(bg)}, fontname={quote(fontname)}, fontcolor={quote(fg)}, fontsize=20, pad=0.4, nodesep=0.5, ranksep=0.8, splines={SPLINES[splines]}{', newrank=true' if any('rank' in n for n in nodes) else ''}{', labelloc=t, label=' + quote(spec['title']) if spec.get('title') else ''}];",
        f"  node [fontname={quote(fontname)}, fontsize=14, fontcolor={quote(fg)}, style=\"filled,rounded\", penwidth=1.6, margin=\"0.25,0.12\"];",
        f"  edge [fontname={quote(fontname)}, fontsize=12, fontcolor={quote(fg)}, color={quote(edge)}, penwidth=1.4, arrowsize=0.8];",
    ]

    def node_line(n, indent):
        shape, lf, lb, df, db = KINDS.get(n.get("kind", "service"), KINDS["service"])
        fill, border = (df, db) if dark else (lf, lb)
        style = "filled" if shape in ("cylinder", "oval", "diamond", "hexagon", "note", "box3d") else "filled,rounded"
        return f"{indent}{quote(n['id'])} [label={quote(n.get('label', n['id']))}, shape={shape}, style={quote(style)}, fillcolor={quote(fill)}, color={quote(border)}];"

    for gid, g in groups.items():
        members = [n for n in nodes if n.get("group") == gid]
        if not members:
            warnings.append(f"group {gid!r} has no nodes; left out")
            continue
        lines.append(f"  subgraph {quote('cluster_' + gid)} {{")
        lines.append(f"    label={quote(g.get('label', gid))}; style=\"rounded,dashed\"; color={quote(edge)}; fontcolor={quote(fg)}; fontsize=14;")
        lines.extend(node_line(n, "    ") for n in members)
        lines.append("  }")
    lines.extend(node_line(n, "  ") for n in nodes if not n.get("group") or n["group"] not in groups)
    # Nodes that share a "rank" are drawn side by side: the layout lines them up instead of guessing.
    ranks = {}
    for n in nodes:
        if "rank" in n:
            ranks.setdefault(str(n["rank"]), []).append(n["id"])
    for rank, members in ranks.items():
        if len(members) < 2:
            warnings.append(f"rank {rank!r} has only {members[0]!r}: a rank lines up two or more nodes")
            continue
        lines.append("  { rank=same; " + " ".join(quote(m) + ";" for m in members) + " }")
    for e in edges:
        attrs = []
        if e.get("label"):
            attrs.append(f"{label_attr}={quote(' ' + str(e['label']) + ' ')}")
        if e.get("style") in ("dashed", "dotted", "bold"):
            attrs.append(f"style={e['style']}")
        if e.get("both"):
            attrs.append("dir=both")
        if e.get("constraint") is False:
            attrs.append("constraint=false")
        lines.append(f"  {quote(e['from'])} -> {quote(e['to'])}" + (f" [{', '.join(attrs)}]" if attrs else "") + ";")
    lines.append("}")
    return "\n".join(lines) + "\n"


def render(dot_path, out, warnings):
    if not shutil.which("dot"):
        fail("Graphviz `dot` is not installed. Install the `graphviz` package the way your instructions say (apt install graphviz, brew install graphviz)")
    made = []
    for fmt, extra in (("svg", []), ("png", ["-Gdpi=150"])):
        target = f"{out}.{fmt}"
        try:
            run = subprocess.run(["dot", f"-T{fmt}", *extra, dot_path, "-o", target], capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            fail(f"dot took over 60 s on {dot_path}: the graph is too big; draw fewer nodes")
        if run.returncode != 0:
            fail(f"dot failed on {dot_path}:\n{run.stderr.strip()}")
        if run.stderr.strip():
            warnings.extend("dot: " + line for line in run.stderr.strip().splitlines())
        if not os.path.exists(target) or os.path.getsize(target) == 0:
            fail(f"dot wrote nothing to {target}")
        made.append(target)
    return made


def crossings(dot_path):
    """How many edge crossings dot's layout ended with (`dot -v` says it), or None when this dot does not say."""
    try:
        run = subprocess.run(["dot", "-v", "-Tdot", "-o", os.devnull, dot_path], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    found = [(name, int(n)) for name, n in re.findall(r"^mincross (\S+): (\d+) crossings", run.stderr, re.M)]
    whole = [n for name, n in found if not name.startswith("cluster")]
    return whole[-1] if whole else None


def crossing_check(dot_path, warnings):
    count = crossings(dot_path)
    if count is None:
        return
    print(f"crossings: {count}")
    if count > MAX_CROSSINGS:
        warnings.append(f"{count} arrows cross each other, and a reader loses which goes where. In this order: give the "
                        "nodes that belong side by side the same \"rank\"; mark an arrow that goes back (a reply, a loop, "
                        "a sync) \"constraint\": false; try the other direction (LR <-> TB); \"splines\": \"ortho\" for "
                        f"an architecture; past {MAX_NODES} boxes, an overview and one diagram per part")


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def report(made, warnings):
    for path in made:
        line = f"wrote {path} ({os.path.getsize(path)} bytes"
        if path.endswith(".png"):
            w, h = png_size(path)
            line += f", {w}x{h} px"
            if max(w, h) > 5 * min(w, h):
                warnings.append(f"the picture is {w}x{h}: very long and thin, unreadable on a phone. Switch direction (LR <-> TB) or split it")
        print(line + ")")
    for w in warnings:
        print(f"warning: {w}")
    print("next: `read` the PNG and check every label is whole, the arrows point the right way and nothing overlaps.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render", help="JSON spec -> .dot, .svg, .png")
    r.add_argument("spec")
    r.add_argument("--out", required=True, help="path without extension, e.g. $TMPDIR/home-setup")
    d = sub.add_parser("dot", help="your own .dot -> .svg, .png")
    d.add_argument("file")
    d.add_argument("--out", required=True)
    sub.add_parser("fonts", help="which of the usual fonts are installed")
    sub.add_parser("example", help="print a spec to start from")
    args = parser.parse_args()

    if args.cmd == "example":
        print(json.dumps(EXAMPLE, indent=2))
        return
    if args.cmd == "fonts":
        font, have = installed_font()
        print("installed: " + (", ".join(have) if have else "none of " + ", ".join(FONTS)))
        print(f"used: {font or 'sans-serif (fallback)'}")
        return
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    warnings = []
    if args.cmd == "render":
        try:
            with open(args.spec, encoding="utf-8") as f:
                spec = json.load(f)
        except FileNotFoundError:
            fail(f"no file {args.spec}")
        except json.JSONDecodeError as err:
            fail(f"{args.spec} is not valid JSON: {err}")
        dot_path = f"{args.out}.dot"
        with open(dot_path, "w", encoding="utf-8") as f:
            f.write(to_dot(spec, warnings))
        made = [dot_path, *render(dot_path, args.out, warnings)]
    else:
        if not os.path.exists(args.file):
            fail(f"no file {args.file}")
        dot_path = args.file
        made = render(args.file, args.out, warnings)
    crossing_check(dot_path, warnings)
    report(made, warnings)


if __name__ == "__main__":
    main()
