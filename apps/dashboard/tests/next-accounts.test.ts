/**
 * The accounts an agent goes on with when the one it starts on reaches its limit: which may be added, and what is saved.
 */

import { describe, expect, test } from "bun:test";
import { accountList, addable } from "@/commons/lib/next-accounts";

describe("the accounts an agent may go on with", () => {
  const accounts = [{ name: "rina", signedIn: true }, { name: "work", signedIn: true }, { name: "team", signedIn: false }, { name: "own", signedIn: null }];

  test("signed in once for every agent, and not listed already", () => {
    expect(addable(accounts, ["rina"])).toEqual(["work"]);
    expect(addable(accounts, ["rina", "work"])).toEqual([]);
  });

  test("saved as its first account and the ones after it, in order, each once", () => {
    expect(accountList("rina", ["work", "spare"])).toEqual(["rina", "work", "spare"]);
    expect(accountList("rina", [])).toEqual(["rina"]);
    // Its first account named again, or one named twice, is in the list once.
    expect(accountList("rina", ["work", "rina", "work"])).toEqual(["rina", "work"]);
  });
});
