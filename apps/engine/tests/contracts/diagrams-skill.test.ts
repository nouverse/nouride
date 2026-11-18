/**
 * The built-in `diagrams` skill (0.8.12), from an older `draw-diagram`: what it learned in use — draw less first,
 * look before sending, Graphviz rather than an online renderer — and a helper that turns a short JSON list of boxes and
 * arrows into Graphviz, so a small model writes data instead of DOT. The helper's checks run here without `dot`: they
 * come before it.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whichBinary } from "@nouride/runtime";

const DIR = join(import.meta.dir, "../../../../content/skills/diagrams");
const SCRIPT = join(DIR, "scripts/diagram.py");
const skill = readFileSync(join(DIR, "SKILL.md"), "utf8").replace(/\s+/g, " ");

/** The helper's `to_dot`, called on a spec: the DOT it writes and the warnings it collects. */
function toDot(spec: unknown): { dot: string; warnings: string[] } {
  const code = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(SCRIPT)}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
w = []; print(json.dumps({"dot": m.to_dot(json.loads(sys.stdin.read()), w), "warnings": w}))`;
  return JSON.parse(execFileSync("python3", ["-c", code], { input: JSON.stringify(spec) }).toString());
}

describe("the skill", () => {
  test("draws little first, looks before it sends, and never through an online renderer", () => {
    expect(skill).toContain("the first diagram has **3 to 7 boxes**");
    expect(skill).toContain("**`read` the PNG** and look");
    expect(skill).toContain("**No online renderers**: Mermaid.ink, Kroki");
    expect(skill).toContain("`send_file` the PNG");
  });
});

describe("two ways to draw, and the machine decides", () => {
  test("a browser already set up means a page; none means Graphviz, and never a browser set up for a diagram", () => {
    expect(skill).toContain('ls <private>/browser/node_modules/playwright-core >/dev/null 2>&1 && echo "browser: set up" || echo "browser: not set up"');
    // Decided by the check and not by the kind of diagram: on the box an agent with a browser read "a real graph is
    // still Graphviz's" and drew boxes and arrows with Graphviz, never running the check.
    expect(skill).toContain("**Which one is decided by a check you run first, every time: not by the kind of diagram, and not by which you know better.**");
    expect(skill).toContain("## 0. Which way: run this before anything else");
    expect(skill).toContain("**`browser: set up`**: draw it as a page, §6, **whatever the diagram is, boxes and arrows included**.");
    expect(skill.indexOf("## 0. Which way")).toBeLessThan(skill.indexOf("**With Graphviz** you write"));
    expect(skill).toContain("**`browser: not set up`**: Graphviz, §1 to §5. **Do not set a browser up for a diagram**");
    expect(skill).toContain("It exits 3 where no browser starts: that is Graphviz, §1 to §5, not a browser to install.");
  });

  test("as a page: the browser places things, an arrow is drawn, a real graph is still computed, and it is looked at", () => {
    expect(skill).toContain("**The browser places things, you do not.**");
    expect(skill).toContain("No `position: absolute`, no pixel coordinates, no hand-written `<svg>` of boxes");
    expect(skill).toContain("**An arrow is drawn, not typed.**");
    expect(skill).toContain("**Arrows that cross or branch are laid out by Graphviz, inside the page.**");
    expect(skill).toContain("the picture you send is still the page's");
    expect(skill).toContain('node PICTURE "$TMPDIR/flow.html" --browser-dir <private>/browser --out "$TMPDIR/flow.png"');
    expect(skill).toContain("**Fix every finding and render again**, then **`read` the PNG** as in §3");
  });

  test("in a mission's report the picture is handed back and named where it belongs, and the report still reads without it", () => {
    expect(skill).toContain("**hand the PNG back among the mission's files**");
    expect(skill).toContain("**Name it in the report where it belongs**, by its file's name: `![How a message travels now](flow.png)`");
    expect(skill).toContain("a report must still read without it");
    expect(skill).toContain("A list of things with their state is a table, not a picture.");
  });
});

describe("picture.mjs, run as an agent runs it", () => {
  const PICTURE = join(DIR, "scripts/picture.mjs");
  const PAGES = join(import.meta.dir, "fixtures/diagram-pages");
  const runner = whichBinary("node") ?? process.execPath;
  const run = (args: string[]) => {
    const done = spawnSync(runner, [PICTURE, ...args], { encoding: "utf8", env: { ...process.env } });
    return { code: done.status, out: done.stdout, err: done.stderr };
  };

  test("bad arguments exit 1, a page that is not there exits 2, and no browser to borrow exits 3 saying Graphviz, not an install", () => {
    expect(run([])).toMatchObject({ code: 1 });
    expect(run([join(PAGES, "good.html"), join(PAGES, "faults.html")]).err).toContain("one page at a time");
    expect(run([join(PAGES, "good.html"), "--width", "90"]).err).toContain("--width is a whole number of pixels, 320 to 2400");
    expect(run([join(PAGES, "not-there.html")])).toMatchObject({ code: 2 });
    const none = run([join(PAGES, "good.html"), "--browser-dir", join(tmpdir(), "no-browser-here"), "--out", join(tmpdir(), "nouride-picture-none.png")]);
    // 3 where this machine has no Playwright to find; where it has one, the page is drawn and that is not this case.
    if (none.code === 3) {
      expect(none.err).toContain("Draw it with Graphviz instead: this skill's steps 2 to 5.");
      expect(none.err).not.toMatch(/install-browser|npm i/);
    }
  });

  const BROWSER = process.env.NOURIDE_TEST_BROWSER_DIR;
  const drawn = describe.skipIf(!BROWSER);
  drawn("in a real browser (NOURIDE_TEST_BROWSER_DIR)", () => {
    const out = mkdtempSync(join(tmpdir(), "nouride-picture-"));
    const chromium = process.env.NOURIDE_TEST_CHROMIUM ? ["--chromium", process.env.NOURIDE_TEST_CHROMIUM] : [];
    const draw = (page: string) => run([join(PAGES, page), "--browser-dir", BROWSER!, "--out", join(out, page.replace(".html", ".png")), ...chromium]);

    test("a page laid out by the browser measures clean and is written at twice its size", () => {
      const good = draw("good.html");
      expect(good.code).toBe(0);
      expect(good.out).toContain("nothing found. Now read the PNG and look");
      const png = readFileSync(join(out, "good.png"));
      // A PNG's width, from its header: the picture is 1200 wide, written at 2400.
      expect(png.readUInt32BE(16)).toBe(2400);
    });

    test("each fault is found and named: cut, small, an arrow typed, contrast, past the edge, text over text", () => {
      const faults = draw("faults.html");
      expect(faults.code).toBe(4);
      for (const kind of ["cut:", "small:", "typed:", "contrast:", "outside:", "overlap:"]) expect(faults.out).toContain(kind);
      expect(faults.out).toContain('"Service one" is over "Service two"');
      expect(readFileSync(join(out, "faults-check.png")).length).toBeGreaterThan(1000);
    });
  });
});

describe("the helper", () => {
  test("its example is a spec it accepts: groups, kinds and edge styles in the DOT", () => {
    const example = JSON.parse(execFileSync("python3", [SCRIPT, "example"]).toString());
    const { dot, warnings } = toDot(example);
    expect(dot).toContain('subgraph "cluster_home"');
    expect(dot).toContain('"cam" [label="CCTV", shape=box');
    expect(dot).toContain('"ha" -> "cam" [label=" RTSP ", style=dashed];');
    expect(warnings.filter((w) => !w.includes("is installed"))).toEqual([]);
  });

  test("an arrow to a node that is not there stops it, naming the id", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagrams-"));
    try {
      writeFileSync(join(dir, "bad.json"), JSON.stringify({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] }));
      const run = spawnSync("python3", [SCRIPT, "render", join(dir, "bad.json"), "--out", join(dir, "bad")]);
      expect(run.status).toBe(1);
      expect(run.stderr.toString()).toContain("edge a -> b: no node with id 'b'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("what makes a diagram hard to read is warned about", () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({ id: `n${i}`, label: i === 0 ? "a label far longer than thirty-two characters" : `N${i}` }));
    const edges = nodes.slice(1, 12).map((n) => ({ from: "n0", to: n.id }));
    const { warnings } = toDot({ nodes, edges, theme: "neon" });
    expect(warnings).toContain("13 nodes: past 12 a first diagram is hard to read. Offer a simpler one with the main parts");
    expect(warnings).toContain("node 'n12' has no edge: is a line missing?");
    expect(warnings.some((w) => w.startsWith("label of 'n0' is over 32 characters"))).toBe(true);
    expect(warnings).toContain('theme "neon" is not light or dark; light used');
  });

  /**
   * Arrows that wind (0.8.12, after Nouva rated Graphviz poor at complex diagrams). Rendered for real on the box: a
   * nine-box shop diagram had no crossing at all, yet put its mobile app at the far right under an arc, because dot
   * turned the main path (mobile -> API) around to break the loop that a `push` arrow closed.
   */
  test("an arrow going back is named by the spec's order — not the main path — and constraint: false quiets it", () => {
    const nodes = ["web", "mobile", "api", "orders", "pay", "queue"].map((id) => ({ id }));
    const edges = [
      { from: "web", to: "api" }, { from: "mobile", to: "api" }, { from: "api", to: "orders" },
      { from: "orders", to: "pay" }, { from: "orders", to: "queue" },
      { from: "queue", to: "web", label: "notify" }, { from: "pay", to: "orders", label: "webhook" },
      { from: "queue", to: "mobile", label: "push" },
    ];
    const tangled = toDot({ nodes, edges }).warnings.find((w) => w.startsWith("arrows going back against the flow"));
    expect(tangled).toContain("long arc: queue -> web, pay -> orders, queue -> mobile. Mark each one \"constraint\": false");
    const fixed = toDot({
      nodes: nodes.map((n) => (n.id === "web" || n.id === "mobile" ? { ...n, rank: "clients" } : n)),
      edges: edges.map((e) => (e.label ? { ...e, constraint: false } : e)),
      splines: "ortho",
    });
    expect(fixed.warnings.filter((w) => !w.includes("is installed"))).toEqual([]);
    expect(fixed.dot).toContain('{ rank=same; "web"; "mobile"; }');
    expect(fixed.dot).toContain("splines=ortho, newrank=true");
    // A label on a right-angled arrow is one Graphviz cannot place: it goes beside it.
    expect(fixed.dot).toContain('"queue" -> "web" [xlabel=" notify ", constraint=false];');
  });

  test("the crossings dot's layout ended with are printed — the whole graph's, not a cluster's — and past one warned", () => {
    const dir = mkdtempSync(join(tmpdir(), "diagrams-"));
    try {
      const PY = execFileSync("python3", ["-c", "import sys; print(sys.executable)"]).toString().trim();
      mkdirSync(join(dir, "bin"));
      // A stand-in dot: the files it is asked for, and on -v the lines a real one prints at the end of mincross.
      writeFileSync(join(dir, "bin/dot"), `#!${PY}
import os, sys
a = sys.argv[1:]; out = a[a.index("-o") + 1]; fmt = next(x[2:] for x in a if x.startswith("-T"))
if "-v" in a: sys.stderr.write("mincross cluster_home: 9 crossings, 0.00 secs.\\nmincross G: " + os.environ["CROSS"] + " crossings, 0.00 secs.\\n")
data = b"\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\rIHDR\\x00\\x00\\x02\\x00\\x00\\x00\\x01\\x00" if fmt == "png" else b"<svg/>"
open(out, "wb").write(data)
`);
      chmodSync(join(dir, "bin/dot"), 0o755);
      writeFileSync(join(dir, "s.json"), JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] }));
      const draw = (cross: string) =>
        spawnSync(PY, [SCRIPT, "render", join(dir, "s.json"), "--out", join(dir, "out/s")], { env: { PATH: join(dir, "bin"), CROSS: cross } });
      const three = draw("3").stdout.toString();
      expect(three).toContain("crossings: 3");
      expect(three).toContain("warning: 3 arrows cross each other, and a reader loses which goes where.");
      const one = draw("1").stdout.toString();
      expect(one).toContain("crossings: 1");
      expect(one).not.toContain("arrows cross each other");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
