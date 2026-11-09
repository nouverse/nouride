/**
 * The count of history in comments: what is a marker, what is not, and that a file may lose markers and not gain them.
 */

import { describe, expect, test } from "bun:test";
import { comments, withoutComments } from "../../../../scripts/comments.ts";
import { markerCounts, markerFindings } from "../../../../scripts/check-markers.ts";

describe("what is a marker", () => {
  test("a version, a date, a plan id and a name, each counted in a comment", () => {
    const source = [
      "// Kept once, before this start changes it (0.8.18, REVIEW B2).",
      "/** Raised on 2026-11-03 (the owner, G11), as Nox's review asked (`config-restart-ux`). */",
      "const x = 1;",
    ].join("\n");
    // A private document named with an id in it counts twice: the document, and the id.
    expect(markerCounts(source, false)).toEqual({ version: 1, date: 1, plan: 4, name: 2 });
  });

  test("a private document cited by its section is a plan marker; a document of docs/ is not", () => {
    expect(markerCounts("// Collections stay apart (KNOWLEDGE_BASE §11).\n", false)).toEqual({ plan: 1 });
    // A long comment wraps between the document and its section.
    expect(markerCounts("/**\n * Who answers, in order (SMART_AUTOMATION\n * §3.1), or none.\n */\n", false)).toEqual({ plan: 1 });
    expect(markerCounts("// A new install starts careful (SIMPLIFY RFC §7.5).\n", false)).toEqual({ plan: 1 });
    expect(markerCounts("// The dashboard speaks HTTP (ARCHITECTURE.md §3, DEPLOY.md § The upgrade floor).\n", false)).toEqual({});
  });

  test("a string is not a comment: what a person or a model reads keeps its words", () => {
    const source = 'const prompt = "Released in 0.8.12 (G11) on 2026-11-03, the owner said"; // why\nconst url = "https://x.test/a"; // still code\n';
    expect(markerCounts(source, false)).toEqual({});
  });

  test("the product's words are not a person's: an owner of a box or a connection, formats, the memory tags' rules", () => {
    const source = [
      "// Whether the owner of this connection answers, and what the box's owner turned off.",
      "// An MP4 or an MP3 with an ID3 header, ranked by BM25 with PKCE's S256; R5 folds a qualified tag.",
      "// U+F900, the week 2026-W39 (a date's week, not a plan), and 10.0.0.1 is no version.",
      "// MATCH lives in the store alone (`lint:sql` S5), a public rule.",
    ].join("\n");
    expect(markerCounts(source, false)).toEqual({});
  });
});

describe("a file against its record", () => {
  test("a file may not gain a marker past its record", () => {
    expect(markerFindings("a.ts", { version: 3 }, { version: 2 }).map((finding) => finding.rule)).toEqual(["markers-grew"]);
    expect(markerFindings("a.ts", { plan: 1 }, undefined).map((finding) => finding.rule)).toEqual(["markers-grew"]);
  });

  test("a file at its record passes, and one under it asks for the record to be lowered", () => {
    expect(markerFindings("a.ts", { version: 2, date: 1 }, { version: 2, date: 1 })).toEqual([]);
    const lower = markerFindings("a.ts", { version: 1 }, { version: 2 });
    expect(lower.map((finding) => finding.rule)).toEqual(["record-stale"]);
    expect(lower[0]!.detail).toContain("--write");
  });

  test("a plan id or a name is refused whatever its record says: none is allowed", () => {
    expect(markerFindings("a.ts", { plan: 1 }, { plan: 1 }).map((finding) => finding.rule)).toEqual(["markers-grew"]);
    expect(markerFindings("a.ts", { name: 2 }, { name: 5 }).map((finding) => finding.rule)).toEqual(["markers-grew"]);
    expect(markerFindings("a.ts", { plan: 1 }, undefined)[0]!.detail).not.toContain("raise its record");
  });

  test("what to write instead is said with the refusal", () => {
    expect(markerFindings("a.ts", { plan: 1 }, undefined)[0]!.detail).toContain("say the reason it pointed at");
    expect(markerFindings("a.ts", { name: 1 }, undefined)[0]!.detail).toContain("what was decided and why");
  });
});

describe("the comments it reads", () => {
  test("a URL, a glob, a regex and a template are code; the comments around them are found", () => {
    const source = [
      'const url = "http://x.test/a"; // one',
      "const glob = `src/**/*.ts`; /* two */",
      "const re = /\\/\\/ not a comment/; // three",
      "const t = `${a /* four */ + b}`;",
      "const ratio = x! / 4; // five",
    ].join("\n");
    expect(comments(source).map((comment) => comment.text)).toEqual(["// one", "/* two */", "// three", "/* four */", "// five"]);
  });

  test("JSX text with a URL, a self-closing tag, and an apostrophe on the line before, hide no comment", () => {
    const source = "const a = <p>see http://x.test</p>; // one\nconst b = <Foo a={b} /> {/* two */};\nconst c = <p>Don't</p>;\n// three\n";
    expect(comments(source, true).map((comment) => comment.text)).toEqual(["// one", "/* two */", "// three"]);
  });

  test("taken out, the comments leave the code and its lines as they were", () => {
    const source = "const a = 1; // one\n/* two\n   lines */\nconst b = 2;\n";
    const code = withoutComments(source);
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
    expect(code.replace(/\s+/g, " ").trim()).toBe("const a = 1; const b = 2;");
  });
});
