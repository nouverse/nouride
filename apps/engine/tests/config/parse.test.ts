/**
 * Parsing slash commands and filtering platform mentions.
 *
 * `isPlatformMention` exists because `/approve @Nero | Infra Agent` on Discord produced args
 * `["<@1111111111111111111>"]`, which was treated as an explicit approval id, matched nothing, and
 * replied "not waiting for an answer any more" — while the request sat unresolved. The operator had
 * to figure out the bare `/approve` form on their own.
 */

import { describe, expect, test } from "bun:test";
import { isPlatformMention, parseCommand } from "@/modules/hooks/parse.ts";

describe("parseCommand", () => {
  test("args split on any run of whitespace, and the command is case-folded", () => {
    // A phone keyboard capitalises the first letter and a paste brings tabs and double spaces.
    expect(parseCommand("  /Approve \t apr_abc123   always ")).toEqual({
      command: "/approve",
      args: ["apr_abc123", "always"],
    });
  });

  test("a bare slash is not a command", () => {
    expect(parseCommand("/")).toBeNull();
    expect(parseCommand("/ approve")).toBeNull();
  });

  test("strips Telegram bot suffix from the command", () => {
    expect(parseCommand("/new@nouride_bot")).toEqual({
      command: "/new",
      args: [],
    });
  });

  test("non-command returns null", () => {
    expect(parseCommand("just a message")).toBeNull();
  });
});

describe("isPlatformMention", () => {
  test("Discord mention <@id>", () => {
    expect(isPlatformMention("<@1111111111111111111>")).toBe(true);
  });

  test("Discord mention with nickname flag <@!id>", () => {
    expect(isPlatformMention("<@!1111111111111111111>")).toBe(true);
  });

  test("bare @username", () => {
    expect(isPlatformMention("@nouva_bot")).toBe(true);
  });

  test("an approval id is not a mention", () => {
    expect(isPlatformMention("apr_9e78e0824d944834a14d")).toBe(false);
  });

  test("the keyword 'always' is not a mention", () => {
    expect(isPlatformMention("always")).toBe(false);
  });

  test("the keyword 'all' is not a mention", () => {
    expect(isPlatformMention("all")).toBe(false);
  });

  test("empty string is not a mention", () => {
    expect(isPlatformMention("")).toBe(false);
  });

  // Discord display-name fragments that arrive when the mention is split by whitespace:
  // `/approve @Nero | Infra Agent` → args ["<@id>"] (already caught), but if the adapter
  // delivered it differently, fragments like "|", "Infra", "Agent" are not mentions.
  test("pipe character is not a mention", () => {
    expect(isPlatformMention("|")).toBe(false);
  });

  test("an @ inside a token is not a mention — only the whole token counts", () => {
    expect(isPlatformMention("ops@example")).toBe(false);
  });
});
