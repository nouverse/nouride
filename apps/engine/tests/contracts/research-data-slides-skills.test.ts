/**
 * research, data-sheets and slides (0.8.12): built-in skills with helpers a small model drives. Held here without a
 * browser, matplotlib or python-pptx: the ledger refuses a citation with no source and a source never cited; numbers
 * and money follow any locale and currency, not one country's (the owner: "users are generic"); an ambiguous `1.250` is
 * flagged, never guessed; and the skills keep what live runs taught them.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS = join(import.meta.dir, "../../../../content/skills");
const read = (name: string) => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8").replace(/\s+/g, " ");

describe("research", () => {
  test("its description is read before any web search answers a question that needs backing", () => {
    expect(read("research")).toContain("Read first whenever the person wants something found out and backed up");
  });

  test("the ledger refuses a citation with no source, and a source the report never cites", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const LEDGER = join(SKILLS, "research/scripts/ledger.py");
    try {
      const l = join(dir, "l.json");
      execFileSync("python3", [LEDGER, "init", l, "what is it"]);
      for (const [url, title] of [["https://a.example/x", "A"], ["https://b.example/y", "B"]]) {
        execFileSync("python3", [LEDGER, "add", l, "--url", url!, "--title", title!, "--claim", "c", "--quote", "q", "--date", "2026-01-01", "--kind", "primary"]);
      }
      writeFileSync(join(dir, "r.md"), "Claim one [1]. Claim two [3].\n");
      const out = spawnSync("python3", [LEDGER, "check", l, join(dir, "r.md")]);
      expect(out.status).toBe(4);
      expect(out.stdout.toString()).toContain("[3] is cited in the report but there is no source 3 in the ledger");
      expect(out.stdout.toString()).toContain("[2] B is in the ledger but the report never cites it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("data-sheets", () => {
  // The built-in table's answers, the same on every machine: a Babel installed here would answer instead, in its own
  // version's words. `sys.modules["babel"] = None` makes the import fail as it does where Babel is not installed.
  const NO_BABEL = 'sys.modules["babel"] = None; '
  test("money and numbers follow the locale and the currency — any of them, and a code where it knows neither", () => {
    const code = `import sys, json; ${NO_BABEL}sys.path.insert(0, ${JSON.stringify(join(SKILLS, "data-sheets/scripts"))}); from numfmt import Formatter
print(json.dumps([Formatter(l, c).money(v) for l, c, v in [("id-ID","IDR",1234567.5),("en-US","USD",1234567.5),("de-CH","CHF",1234.5),("en-IN","INR",1234567),("fr-FR","EUR",1234.5),("xx-YY","IDR",1234.5)]]))`;
    const out = JSON.parse(execFileSync("python3", ["-c", code]).toString()) as string[];
    expect(out).toEqual(["Rp1.234.568", "$1,234,567.50", "CHF 1’234.50", "₹12,34,567.00", "1 234,50 €", "IDR 1234"]);
  });

  test("an older Babel, without compact formats, falls back to the table — no traceback (0.8.12, found on CI)", () => {
    const fake = `import sys, types, json
babel = types.ModuleType("babel"); numbers = types.ModuleType("babel.numbers")
class UnknownLocaleError(Exception): pass
class Locale:
    number_symbols = {"decimal": ",", "group": "."}
    @staticmethod
    def parse(tag): return Locale()
babel.Locale = Locale; babel.UnknownLocaleError = UnknownLocaleError; babel.numbers = numbers
sys.modules["babel"] = babel; sys.modules["babel.numbers"] = numbers
sys.path.insert(0, ${JSON.stringify(join(SKILLS, "data-sheets/scripts"))}); from numfmt import Formatter
f = Formatter("id-ID", "IDR"); print(json.dumps([f.money(1234567.5), f.source]))`;
    expect(JSON.parse(execFileSync("python3", ["-c", fake]).toString())).toEqual(["Rp1.234.568", "built-in CLDR table"]);
  });

  test("a number that reads two ways is flagged, never guessed", () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"));
    try {
      writeFileSync(join(dir, "t.csv"), "nama,harga\nA,1.234\nB,2.500\n");
      const out = execFileSync("python3", [join(SKILLS, "data-sheets/scripts/profile.py"), join(dir, "t.csv")]).toString();
      expect(out).toContain('"harga": numbers like 1.250 read two ways (thousands or decimals)');
      expect(out).toContain("Ask the person or check a known total, then pass --decimal comma");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it takes the old chart-maker's JSON, and sends a chart with send_file after reading it", () => {
    const skill = read("data-sheets");
    expect(skill).toContain("the same format as the older `chart-maker` skill's");
    expect(skill).toContain("Put the chart in your reply with `send_file` after `read`ing it");
  });

  /**
   * A dashboard (the owner, after Nouva drew a 2×2 one by hand): a script of the agent's own, started from a working
   * example rather than from nothing. Run here through the built-in number table; matplotlib draws where it is
   * installed, and where it is not, every number is printed before the script says what to install.
   */
  const DASH = join(SKILLS, "data-sheets/scripts/dashboard_example.py");
  const dashboard = (dir: string) =>
    spawnSync("python3", ["-c", `import runpy, sys; ${NO_BABEL}
sys.argv = ["dashboard_example.py", ${JSON.stringify(join(dir, "s.csv"))}, "--date", "Date", "--category", "City", "--value", "Total", "--locale", "id-ID", "--currency", "IDR", "--out", ${JSON.stringify(join(dir, "d.png"))}]
runpy.run_path(${JSON.stringify(DASH)}, run_name="__main__")`]);
  const SALES = "Date,City,Total\n2026-01-05,Bandung,1500000\n2026-01-20,Jakarta,500000\n2026-02-03,Bandung,1000000\n,Jakarta,250000\n";

  test("a dashboard is the agent's own script, from an example that prints every number it draws and checks the totals", () => {
    const skill = read("data-sheets");
    expect(skill).toContain("is **your own matplotlib script**. Do not start it from nothing");
    expect(skill).toContain("every number from a query over the file or a script's output, never typed into the script");
    expect(skill).toContain("every plotted number printed, and the totals checked against each other and against §4");
    const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
    try {
      writeFileSync(join(dir, "s.csv"), SALES);
      const run = dashboard(dir);
      const out = run.stdout.toString();
      expect(out).toContain("by City (2): Bandung Rp2.500.000; Jakarta Rp750.000");
      expect(out).toContain("by month: Jan 2026 Rp2.000.000; Feb 2026 Rp1.000.000");
      expect(out).toContain("note: 1 row(s) have no date (Rp250.000): in the total and by City, not in the month charts");
      expect(out).toContain("check: total, by City, by month + undated, running total + undated all Rp3.250.000 - ok");
      if (run.status === 0) expect(readFileSync(join(dir, "d.png")).subarray(1, 4).toString()).toBe("PNG");
      else {
        expect(run.status).toBe(3);
        expect(run.stderr.toString()).toContain("`pip install matplotlib`");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dashboard query edited wrong stops it before it draws, and a file not cleaned is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
    try {
      writeFileSync(join(dir, "s.csv"), SALES);
      // A copy whose category query leaves a city out: three totals that should be one.
      const patched = spawnSync("python3", ["-c", `import sys; ${NO_BABEL}sys.path.insert(0, ${JSON.stringify(join(SKILLS, "data-sheets/scripts"))})
import importlib.util; spec = importlib.util.spec_from_file_location("dash", ${JSON.stringify(DASH)}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.QUERIES["by_category"] = "SELECT cat, SUM(v) FROM t WHERE cat <> 'Jakarta' GROUP BY cat"
sys.argv = ["d", ${JSON.stringify(join(dir, "s.csv"))}, "--date", "Date", "--category", "City", "--value", "Total", "--out", ${JSON.stringify(join(dir, "d.png"))}]
m.main()`]);
      expect(patched.status).toBe(5);
      expect(patched.stderr.toString()).toContain("PROBLEM: the totals do not reconcile");
      writeFileSync(join(dir, "s.csv"), 'Date,City,Total\n2026-01-05,Bandung,"1.234,56"\n');
      const dirty = dashboard(dir);
      expect(dirty.status).toBe(2);
      expect(dirty.stderr.toString()).toContain("are not plain numbers: row 2 '1.234,56' - run clean.py on the file first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slides", () => {
  test("an outline first for a yes, every slide looked at, a PDF always", () => {
    const skill = read("slides");
    expect(skill).toContain("the person approves the outline before you build anything");
    expect(skill).toContain("`deck.pdf` with `send_file`, always; it opens on a phone");
  });

  test("the printed PDF is counted against the slides: a slide that spills only in print is a finding (0.8.12)", () => {
    // Nouva rated HTML-to-PDF prone to print quirks. Rendered for real: a deck whose third slide grew only under
    // @media print measured clean on screen and printed eleven pages for ten slides. Held here by the words that
    // carry it; the renderer itself needs a browser, so that run is recorded in the commit.
    expect(read("slides")).toContain("in print a slide runs onto another page, while its picture looks right; the PDF is printed, the pictures are not");
    const render = readFileSync(join(SKILLS, "slides/scripts/render.mjs"), "utf8");
    expect(render).toContain("if (pdfPages !== null && pdfPages !== results.length) {");
  });
});
