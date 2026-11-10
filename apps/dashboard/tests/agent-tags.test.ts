/**
 * An agent's tag in its colour (`AgentTag`): one function finds the tags in a line (`splitTags`), and only a name
 * that is one of our agents' is one — not an `@` naming nobody, not an email's, not one in backticks.
 */

import { describe, expect, test } from "bun:test";
import { splitTags } from "@/commons/components/chat/AgentTag";

const NAMES = [
  { name: "nouva", agentId: "nouva" },
  { name: "Nouva", agentId: "nouva" },
  { name: "nix", agentId: "nix" },
  { name: "Nexa Bot", agentId: "nexa" },
];
const tags = (text: string) => splitTags(text, NAMES).flatMap((part) => (typeof part === "string" ? [] : [`${part.tag}=${part.agentId}`]));

describe("the tags in a line", () => {
  test("each agent's, by its id or its name, whatever the case, at a line's start or after a word", () => {
    expect(tags("@nouva @nix cek CI ketiga repo")).toEqual(["@nouva=nouva", "@nix=nix"]);
    expect(tags("Thanks, @Nouva.")).toEqual(["@Nouva=nouva"]);
    expect(tags("ask @NIX, then @Nexa Bot")).toEqual(["@NIX=nix", "@Nexa Bot=nexa"]);
  });

  test("not an @ that names nobody, an email's, a longer name, or one in backticks", () => {
    expect(tags("@nobody here, mail a@nouva.com, @nouvax, `@nouva` and `say @nix`")).toEqual([]);
  });

  test("the words around them are kept as they were, in order", () => {
    const parts = splitTags("hi @nouva and `@nix` ok", NAMES);
    expect(parts).toEqual(["hi ", { tag: "@nouva", agentId: "nouva" }, " and `@nix` ok"]);
    expect(splitTags("no tags here", NAMES)).toEqual(["no tags here"]);
  });
});
