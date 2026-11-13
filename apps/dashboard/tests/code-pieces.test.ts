/**
 * Code read into the pieces a code block colours (`commons/lib/highlight.ts`).
 *
 * Two things it must never do. Lose or change a character: the pieces put together are the code, whatever is in it.
 * And hand markup on: what the highlighter returns is read into text with a name, so a tag in it that the highlighter
 * did not write is the text it is. A language is never guessed.
 */

import { describe, expect, test } from "bun:test";
import { pieces, piecesOf } from "../src/commons/lib/highlight.ts";

const whole = (found: { text: string }[] | null) => (found ?? []).map((piece) => piece.text).join("");

describe("the highlighter's markup, read into pieces", () => {
  test("a piece takes the scope it stands closest inside, and text outside any is plain", () => {
    expect(piecesOf('<span class="hljs-keyword">const</span> x = <span class="hljs-string">&quot;a&quot;</span>;')).toEqual([
      { text: "const", scope: "keyword" },
      { text: " x = " },
      { text: '"a"', scope: "string" },
      { text: ";" },
    ]);
    // A title that is a function is a title; what is inside a string and has no scope of its own is the string's.
    expect(piecesOf('<span class="hljs-title function_">run</span>')).toEqual([{ text: "run", scope: "title" }]);
    expect(piecesOf('<span class="hljs-string">a<span class="hljs-subst">${b}</span>c</span>').map((piece) => piece.scope)).toEqual(["string", "subst", "string"]);
    // Code of another language inside names no scope: its pieces keep the ones they have.
    expect(piecesOf('<span class="language-xml">&lt;b&gt;<span class="hljs-name">x</span></span>')).toEqual([{ text: "<b>" }, { text: "x", scope: "name" }]);
  });

  test("the five escaped characters come back as themselves, once", () => {
    expect(whole(piecesOf("a &amp;&amp; b &lt; c &gt; d &quot;e&quot; &#x27;f&#x27;"))).toBe("a && b < c > d \"e\" 'f'");
    // Code that itself says `&lt;` was escaped to `&amp;lt;`: it comes back as `&lt;`, not as `<`.
    expect(whole(piecesOf("&amp;lt;"))).toBe("&lt;");
  });

  test("a tag the highlighter did not write is text, never an element", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><span onclick="x">y</span>';
    const read = piecesOf(hostile);
    expect(whole(read)).toBe(hostile);
    expect(read.every((piece) => piece.scope === undefined)).toBe(true);
  });
});

describe("code in a language", () => {
  const TS = 'const greet = (name: string) => `hi ${name} <b>&amp;</b>`; // "quoted" & \'single\'\nif (a < b && c > d) { return 0x2A; }\n';
  const SH = "for i in $(seq 1 40); do grep -qE \"FIN_[0-9]+_END\" <<< \"$x\" && break; sleep 3; done 2>&1 | tail -50 # <tag>\n";

  test("the pieces put together are the code, character for character", () => {
    for (const [language, code] of [["ts", TS], ["bash", SH], ["json", '{"a": "<x> & </y>", "n": 1.5e3}'], ["html", '<a href="x?a=1&amp;b=2">&lt;</a>'], ["yaml", "key: 'value: <&>'\n- 1\n"]] as const) {
      expect(whole(pieces(language, code))).toBe(code);
    }
  });

  test("its words are named: a keyword, a string, a number, a comment", () => {
    const named = Object.fromEntries((pieces("ts", TS) ?? []).filter((piece) => piece.scope).map((piece) => [piece.text, piece.scope]));
    expect(named.const).toBe("keyword");
    expect(named["0x2A"]).toBe("number");
    expect(Object.entries(named).some(([text, scope]) => scope === "comment" && text.startsWith("//"))).toBe(true);
    expect(Object.values(named)).toContain("string");
  });

  test("the names a fence is given are known, and the first word is the language", () => {
    for (const name of ["sh", "zsh", "console", "tsx", "jsx", "py", "yml", "toml", "html", "md", "golang", "rs", "docker", "patch", "TypeScript", " ts ", "ts title=app.ts"]) expect(pieces(name, "x")).not.toBeNull();
  });

  test("a language that is not one of them, or none, is not guessed at", () => {
    for (const name of ["", "  ", "text", "plaintext", "output", "foo"]) expect(pieces(name, "const x = 1;")).toBeNull();
  });
});
