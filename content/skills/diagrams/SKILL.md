---
name: diagrams
description: Draw a diagram as a sharp PNG and SVG (architecture, homelab or network map, flowchart, process, data flow, org chart, sequence of steps) with Graphviz, from a short JSON list of boxes and arrows a helper turns into a clean picture. Use when asked to draw, sketch, map, diagram or visualise how something is connected or how a process goes, or to redraw or update an existing diagram.
requires: dot, python3
needs_tools: exec, read, write, send_file
author: Nouride
---

# Drawing a diagram

A diagram is for seeing the shape of a thing at a glance. You write *what* is connected to *what* as a short JSON
list; `scripts/diagram.py`, in the folder this file is in, turns it into Graphviz with a consistent style, renders a
PNG and an SVG, and warns about what makes a diagram hard to read. Below, `DIAGRAM` stands for that script's full path.
Write the full path in each command, e.g. `python3 /opt/nouride/skills/diagrams/scripts/diagram.py`.

## This machine

Light. Graphviz and the helper peaked at about 13 MB for a small diagram (measured on a Linux box), so they run on a
512 MB board.

## 1. Draw less than you know

The most common correction is "too complicated, I meant a simple one". So the first diagram has **3 to 7 boxes**,
one direction, short labels, and no inner detail. Offer the detailed version ("want the agents and the review loop in
it too?") instead of drawing it first. When the person says it is too busy, do not trim a little: start again from the
3 to 5 main parts and the arrows between them.

Every box and arrow is something you know from what they told you, their files or what you checked. A part you are
guessing at is left out, or drawn dashed and said to be a guess when you send it.

## 2. Write the spec

Start from the example (`python3 DIAGRAM example`) and change it. Write the file with your `write` tool:

```json
{
  "title": "Home setup",
  "direction": "LR",
  "theme": "light",
  "groups": [{"id": "home", "label": "Home network"}],
  "nodes": [
    {"id": "phone", "label": "Phone", "kind": "user"},
    {"id": "box", "label": "Nouride box", "kind": "service", "group": "home"},
    {"id": "ha", "label": "Home Assistant", "kind": "service", "group": "home"},
    {"id": "cam", "label": "CCTV", "kind": "device", "group": "home"}
  ],
  "edges": [
    {"from": "phone", "to": "box", "label": "Tailscale"},
    {"from": "box", "to": "ha", "label": "REST"},
    {"from": "ha", "to": "cam", "label": "RTSP", "style": "dashed"}
  ]
}
```

| Field | What it takes |
|---|---|
| `direction` | `LR` (left to right) for a chain or a flow; `TB` (top to bottom) for a hierarchy, or when a chain runs long |
| `theme` | `light` for a document, a README, a website; `dark` for a chat screenshot or a dark slide |
| `kind` | service or app (box), db or storage (cylinder), queue, user or person (oval), external, cloud, device, network (hexagon), decision (diamond, for a flowchart's question), step (a plain step in a process), note |
| `group` | puts a node in a dashed frame: a network, a machine, a team, a phase |
| edge `style` | `solid` (default), `dashed` (optional, async or guessed), `dotted`, `bold` (the main path) |
| edge `both` | `true` for a two-way arrow |
| edge `constraint` | `false` for an arrow that goes back (a reply, a callback, a notification): drawn, but it no longer drags the layout (§3) |
| node `rank` | any name: nodes that share it are drawn side by side (the two client apps, the three databases) |
| `splines` | `spline` (curves, the default), `ortho` (right angles, for an architecture; labels go beside the arrows), `polyline` |
| `label` | short: a box over 32 characters is warned about; break a long one with `\n` |

Kind is one meaning per shape: every database is a `db`, every person a `user`, so the picture reads the same way all
over. Colour comes from the kind; do not ask for colours one by one.

## 3. Render, then look

```sh
python3 DIAGRAM render "$TMPDIR/home.json" --out "$TMPDIR/home"
```

It writes `home.dot`, `home.svg` and `home.png` and prints each with its size, then any warning: an arrow to a node
that does not exist (it stops), a node with no arrow, a label too long, more than 12 nodes, a picture so long and thin
it shrinks to nothing on a phone. **Fix every warning before you go on.** Each one is something the person would see.

Then **`read` the PNG** and look: every label whole, every arrow pointing the way the thing flows, nothing on top of
anything, the groups holding what they should. A file that exists is not a diagram that reads. If your model cannot
see images, say so when you send it, and do not describe it as clean.

A flowchart that reads top to bottom is `"direction": "TB"` with `decision` nodes; a yes/no branch is two edges from
the decision, labelled `yes` and `no`.

### Arrows that cross or wind

It prints `crossings: N` (how many arrows cross, from Graphviz's own layout) and warns past one. It also names every
arrow that goes back against the flow: Graphviz drags the box such an arrow points at to the far end, and brings the
arrow back as a long arc over everything. That shows no crossing at all. In a test, a nine-box shop diagram put its
mobile app at the far right under an arc across the top, because of one `push` arrow. Fix them in this order:

1. **The main path first in `edges`**, the arrows that come back after it; the helper reads them in that order to tell
   which ones go back.
2. **`"constraint": false`** on each arrow it names: still drawn, no longer dragging the layout.
3. **`"rank"`** on the nodes that belong side by side.
4. **The other direction**, `LR` ↔ `TB`.
5. **`"splines": "ortho"`** for an architecture.
6. **Past 12 boxes**: an overview of the main parts, and one diagram per part.

A crossing the shape forces (each of three things wired to each of three others) stays: say so when you send it.

## 4. What the spec cannot say

For what the spec has no field for (ports on a record, a legend, a group inside a group), write Graphviz yourself, starting
from the `.dot` the spec made, and render it with the same checks:

```sh
python3 DIAGRAM dot "$TMPDIR/home.dot" --out "$TMPDIR/home-v2"
```

Keep the font the helper chose; `python3 DIAGRAM fonts` says which is installed. A font that is not installed is
replaced silently, and the boxes then fit their text badly.

## 5. Send it

- `send_file` the PNG, with one or two lines on what it shows and which parts are your reading rather than known.
- Keep the spec, the `.dot` and the SVG beside each other where the work lives (a repository's `docs/`, the project
  folder), so the next change is an edit of the spec and one command, not a redraw.
- The SVG is for a website or a document; the PNG is for chat.

## Not this way

- **No online renderers**: Mermaid.ink, Kroki or any site you paste the diagram into. They send the person's
  architecture to someone else's server, and the PNGs come back with empty boxes and broken fonts often enough not to
  rely on. Graphviz runs here.
- **Not a picture of a chart.** Numbers over time, shares, comparisons are a chart (the `data-sheets` skill), not a
  diagram.
- **No `dot`?** Install the `graphviz` package the way your instructions say to install software (`apt install
  graphviz`, `brew install graphviz`). The helper says so when it is missing.
