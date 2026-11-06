/**
 * The memory graph's filter in the URL: several of each kind, and the same choice in another order
 * asking the daemon for the same graph; and whether the documents' layer is on.
 */

import { describe, expect, test } from "bun:test";
import { parseGraphSearch, toFilter } from "@/modules/memories/graph/search";

describe("parseGraphSearch", () => {
  test("reads several of each kind, without blanks or repeats", () => {
    expect(parseGraphSearch({ agents: ["nouva", "nix", "nouva", " "], tags: ["homelab"] })).toEqual({ agents: ["nouva", "nix"], tags: ["homelab"] });
  });

  test("reads only the list keys: the one-value form never shipped in a release", () => {
    // `?agent=` lived for under an hour on 2026-10-09 (7e21686b to b5b4c5ad), and v0.6.6, the first tag
    // with the graph, already had the lists. A key it does not know is dropped like any other.
    expect(parseGraphSearch({ agent: "nouva", person: "gading", tag: "homelab", agents: ["nix"] })).toEqual({ agents: ["nix"] });
  });

  test("drops what it does not know, and the defaults", () => {
    expect(parseGraphSearch({ agents: [], range: "all", limit: 300, colour: "red", tags: [3] })).toEqual({});
  });

  test("the documents' layer (0.8.20): on as a link writes it, off otherwise", () => {
    for (const on of [true, "true", "1"]) expect(parseGraphSearch({ knowledge: on })).toEqual({ knowledge: true });
    for (const off of [false, "false", "0", "yes", undefined]) expect(parseGraphSearch({ knowledge: off })).toEqual({});
  });
});

describe("toFilter", () => {
  test("the same choice in another order is the same request", () => {
    expect(toFilter({ agents: ["nix", "nouva"] })).toEqual(toFilter({ agents: ["nouva", "nix"] }));
  });

  test("an empty kind is no filter at all", () => {
    expect(toFilter({ tags: [] })).toEqual({ limit: 300 });
  });

  test("the documents' layer is asked for only when it is on", () => {
    expect(toFilter({ knowledge: true })).toEqual({ limit: 300, knowledge: true });
    expect(toFilter({})).toEqual({ limit: 300 });
  });
});
