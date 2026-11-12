/**
 * Something that happened to a conversation, in the chat (0.8.1): a short event is a pill; a long one — a mission's
 * notice with its report — is a card that keeps its lines and renders its markdown, where the pill let a paragraph run
 * out past its rounded ends with its line breaks gone and its backticks shown. What happened to a room is said in the
 * dashboard's words (`eventWords`): the agents' names, "You" for the one reading, and no login for the server itself.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatEvent } from "@nouride/wire";
import { EventPill } from "@/commons/components/chat/EventPill";
import { eventWords } from "@/commons/lib/event-words";

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

  test("an event the agents were told too carries no tag a person cannot read", () => {
    const html = renderToStaticMarkup(createElement(EventPill, { event: { id: "e1", kind: "joined", audience: "agents", text: "x", at: 0 } as never, words: "You started this room with Nouva." }));
    expect(html).toContain("You started this room with Nouva.");
    expect(html.toLowerCase()).not.toContain("agents");
  });
});

describe("what happened to a room, in plain words", () => {
  const NAMES: Record<string, string> = { nouva: "Nouva", nestor: "Nestor", nix: "Nix" };
  const names = { viewer: "mira", nameOf: (id: string) => NAMES[id] ?? id };
  const event = (over: Partial<ChatEvent>): ChatEvent => ({ id: "e", gatewayId: "web:dashboard", chatId: "r", audience: "agents", kind: "joined", text: "the daemon's sentence", at: 0, ...over });
  const say = (over: Partial<ChatEvent>) => eventWords(event(over), names);

  test("who started it with whom: the agents' names joined as a person writes them, and You for the one reading", () => {
    expect(say({ actor: "mira", details: { members: ["nouva", "nestor", "nix"] } })).toBe("You started this room with Nouva, Nestor and Nix.");
    expect(say({ actor: "sam", details: { members: ["nouva", "nix"] } })).toBe("sam started this room with Nouva and Nix.");
  });

  test("the server itself is nobody by name: the line is said without a who", () => {
    expect(say({ actor: "cli", details: { members: ["nouva", "nestor", "nix"] } })).toBe("This room was started with Nouva, Nestor and Nix.");
    expect(say({ actor: "cli", agentId: "nix" })).toBe("Nix was added to this room.");
    expect(say({ actor: "cli", kind: "left", agentId: "nix" })).toBe("Nix was taken out of this room.");
    expect(say({ actor: "cli", kind: "topic", details: { title: "Launch crew" } })).toBe('This room was named "Launch crew".');
  });

  test("added, taken out, named and its name cleared", () => {
    expect(say({ actor: "mira", agentId: "nestor" })).toBe("You added Nestor to this room.");
    expect(say({ actor: "mira", kind: "left", agentId: "nestor" })).toBe("You took Nestor out of this room.");
    expect(say({ actor: "mira", kind: "topic", details: { title: "Launch crew" } })).toBe('You named this room "Launch crew".');
    expect(say({ actor: "mira", kind: "topic", details: { title: null } })).toBe("You cleared this room's name.");
  });

  test("an event without the data to say it keeps the daemon's sentence", () => {
    expect(say({ actor: "mira", kind: "topic" })).toBe("the daemon's sentence");
    expect(say({ kind: "note", text: "Mission done." })).toBe("Mission done.");
  });
});
