/**
 * Something that happened to a conversation, in the chat (0.8.1): a short event is a pill; a long one — a mission's
 * notice with its report — is a card that keeps its lines and renders its markdown, where the pill let a paragraph run
 * out past its rounded ends with its line breaks gone and its backticks shown.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventPill } from "@/modules/chat/components/EventPill";

const render = (text: string) => renderToStaticMarkup(createElement(EventPill, { event: { id: "e1", kind: "note", text, at: 0 } as never }));

describe("an event in the chat", () => {
  test("a short one is a pill", () => {
    const html = render("Nero joined the room.");
    expect(html).toContain("rounded-full");
    expect(html).not.toContain('data-shape="card"');
  });

  test("a mission's notice is a card: each line its own, its code as code, a long branch broken rather than run out", () => {
    const html = render("☑ Mission msn_80c47a is done.\nTwo helpers ran:\n- Helper 1: `mission/msn_80c47a1922334920ad81-helper-1`\nAccept: /mission accept msn_80c47a");
    expect(html).toContain('data-shape="card"');
    expect(html).not.toContain("rounded-full border");
    expect(html).toContain("<code");
    expect(html).not.toContain("`mission/");
    expect(html).toContain("<li");
    expect(html.match(/<p /g)?.length).toBe(3);
    expect(html).toContain("[overflow-wrap:anywhere]");
  });
});
