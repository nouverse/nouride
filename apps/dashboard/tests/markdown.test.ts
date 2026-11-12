import { describe, expect, it, test } from "bun:test";
import { Markdown } from "../src/commons/components/ui/Markdown";
import { renderToString } from "react-dom/server";

describe("Markdown list rendering", () => {
  it("renders ordered list numbers correctly when separated by empty lines (loose list)", () => {
    const md = `1. Step one\n\n2. Step two\n\n3. Step three`;
    const html = renderToString(Markdown({ source: md }));
    expect(html).toContain("<ol class=\"list-decimal space-y-1.5 pl-6 text-base-content/85\"><li>Step one</li><li>Step two</li><li>Step three</li></ol>");
  });

  it("renders CommonMark lazy numbered lists (1. 1. 1.) as a single auto-incrementing list", () => {
    const md = `1. Step one\n1. Step two\n1. Step three`;
    const html = renderToString(Markdown({ source: md }));
    expect(html).toContain("<ol class=\"list-decimal space-y-1.5 pl-6 text-base-content/85\"><li>Step one</li><li>Step two</li><li>Step three</li></ol>");
  });

  it("preserves start and value for lists interrupted by paragraphs and code blocks", () => {
    const md = [
      "1. **MCP Server**",
      "Explanation paragraph",
      "```bash",
      "command here",
      "```",
      "More notes",
      "2. **Google Workspace**",
      "API details",
      "3. **Otomasi**",
      "- Pengecekan berkala",
      "- Push notification",
    ].join("\n\n");

    const html = renderToString(Markdown({ source: md }));

    // Item 1 has no start offset (defaults to 1) or start=1
    expect(html).toContain("MCP Server");
    // Item 2 starts at 2
    expect(html).toContain('start="2"');
    expect(html).toContain('value="2"');
    expect(html).toContain("Google Workspace");
    // Item 3 starts at 3
    expect(html).toContain('start="3"');
    expect(html).toContain('value="3"');
    expect(html).toContain("Otomasi");
    // Nested/sub bullet items render as an unordered list
    expect(html).toContain("<ul class=\"list-disc space-y-1.5 pl-6 text-base-content/85\"><li>Pengecekan berkala</li><li>Push notification</li></ul>");
  });

  it("handles unordered lists with blank lines", () => {
    const md = `- Item A\n\n- Item B\n\n- Item C`;
    const html = renderToString(Markdown({ source: md }));
    expect(html).toContain("<ul class=\"list-disc space-y-1.5 pl-6 text-base-content/85\"><li>Item A</li><li>Item B</li><li>Item C</li></ul>");
  });
});

/**
 * What a model writes is drawn as links, so the link is the one place its text becomes something a click acts on.
 * Only `http(s)` is ever an `href`: a `javascript:` link in an answer — written by the model, or by a page it read —
 * would run in the dashboard's origin, with the operator's session, on one click. The one path that is a link is a
 * page of the dashboard the text is drawn in (`page-link.test.ts`, `mount-chat-links.test.ts`); drawn anywhere else,
 * as here, a path is a page of nothing.
 */
describe("Markdown links", () => {
  const html = (source: string) => renderToString(Markdown({ source }));

  test("a link that is not http(s) is drawn as its label, with no href", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "/api/control/secrets", "/dashboard/memories/graph"]) {
      const drawn = html(`see [the docs](${href}) now`);
      expect(drawn, href).not.toContain("href=");
      expect(drawn, href).toContain("the docs");
    }
    expect(html("see [the docs](https://example.com/docs) now")).toContain('href="https://example.com/docs"');
  });

  test("code that is not an http(s) address stays code, never a link", () => {
    expect(html("run `javascript:alert(1)` now")).not.toContain("href=");
    expect(html("open `https://example.com/x`")).toContain('href="https://example.com/x"');
  });

  test("a bare address leaves the sentence's punctuation out of the link", () => {
    const drawn = html("It is at https://example.com/a/b.");
    expect(drawn).toContain('href="https://example.com/a/b"');
    expect(drawn).not.toContain('href="https://example.com/a/b."');
  });
});
