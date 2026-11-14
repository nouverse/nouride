/**
 * The accounts an agent goes on with when the one it starts on reaches its limit: which may be added, and what is saved.
 */

import { describe, expect, test } from "bun:test";
import { accountList, addable, MOVE_AT_DEFAULT, moveAtOf } from "@/commons/lib/next-accounts";

describe("the accounts an agent may go on with", () => {
  const accounts = [{ name: "rina", signedIn: true }, { name: "work", signedIn: true }, { name: "team", signedIn: false }, { name: "own", signedIn: null }];

  test("signed in once for every agent, and not listed already", () => {
    expect(addable(accounts, ["rina"])).toEqual(["work"]);
    expect(addable(accounts, ["rina", "work"])).toEqual([]);
  });

  test("the share of a limit at which it moves on early is a whole number of percent from 1 to 99, and nine tenths to begin with", () => {
    expect(["1", "90", "99", " 85 "].map(moveAtOf)).toEqual([1, 90, 99, 85]);
    expect(["0", "100", "9.5", "", "abc", "-5", "090"].map(moveAtOf)).toEqual([null, null, null, null, null, null, null]);
    expect(MOVE_AT_DEFAULT).toBe(90);
  });

  test("saved as its first account and the ones after it, in order, each once", () => {
    expect(accountList("rina", ["work", "spare"])).toEqual(["rina", "work", "spare"]);
    expect(accountList("rina", [])).toEqual(["rina"]);
    // Its first account named again, or one named twice, is in the list once.
    expect(accountList("rina", ["work", "rina", "work"])).toEqual(["rina", "work"]);
  });
});
