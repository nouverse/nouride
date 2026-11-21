/**
 * `nouride agent delete <id>`: what goes and what is kept said first, then the agent's id asked for, typed. Nothing is
 * sent to the daemon's delete until what was typed is the id, and a refusal or a note of what was left is said.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { deleteAgent } from "../../../cli/src/commands/agent-delete.ts";

const FOUND = {
  agent: "rex", displayName: "Rex", missions: 1, jobs: 0, automations: 2, handed: 1, connections: ["telegram:rex"], rooms: 1, grants: 3, signIns: 0,
  folder: { bytes: 5 * 1024 * 1024, files: 40, more: false }, account: true,
};
const DONE = { deleted: "rex", took: {}, account: "left", notes: ["Its account on the machine, nr-rex, is left: the part of Nouride that removes one was installed by an earlier release. Running the installer again brings it up to date."] };

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function run(typed: string | Error, found: unknown = FOUND) {
  const asked: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    get: async (path: string) => (asked.push({ method: "GET", path }), found),
    post: async (path: string, body: unknown) => (asked.push({ method: "POST", path, body }), DONE),
  } as unknown as Client;
  const out: string[] = [];
  const err: string[] = [];
  const clean = (line: unknown) => String(line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  spies.push(spyOn(console, "log").mockImplementation((line?: unknown) => void out.push(clean(line))));
  spies.push(spyOn(console, "error").mockImplementation((line?: unknown) => void err.push(clean(line))));
  spies.push(spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Exit(code ?? 0); }) as never));
  const questions: string[] = [];
  let closed = 0;
  let exit: number | null = null;
  try {
    const ask = async (question: string) => {
      questions.push(question);
      if (typed instanceof Error) throw typed;
      return typed;
    };
    await deleteAgent(client, "rex", { ask, close: () => void closed++ });
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    exit = error.code;
  }
  return { asked, out, err, questions, closed, exit };
}

describe("nouride agent delete", () => {
  test("says what goes and what is kept, asks for the id, and deletes when it is typed", async () => {
    const { asked, out, questions, closed, exit } = await run("rex");
    expect(exit).toBeNull();
    expect(questions).toEqual(["Type the agent's id to delete it (rex): "]);
    expect(asked).toEqual([{ method: "GET", path: "/agents/rex/delete" }, { method: "POST", path: "/agents/rex/delete", body: { confirm: "rex" } }]);
    expect(out).toEqual([
      "Delete Rex (rex)? This cannot be undone. With it go:",
      "  - its own files: its pack and its private folder, where a coding CLI's sign-ins are (40 files, 5.0MB)",
      "  - 1 mission still open: stopped first",
      "  - 2 automations of its own",
      "  - 1 automation of other agents with a step given to it: turned off, each saying why",
      "  - the connection only it answers: telegram:rex (the token stays in Secrets)",
      "  - its seat in 1 room",
      "  - 3 standing permissions",
      "  - its user on this machine, nr-rex",
      "Kept: its chats, what it remembered, the records of its missions, the audit log and usage. An agent made later with the id rex is joined to them.",
      "✓ rex deleted",
      "  ! Its account on the machine, nr-rex, is left: the part of Nouride that removes one was installed by an earlier release. Running the installer again brings it up to date.",
    ]);
    expect(closed).toBe(1);
  });

  test("anything else typed deletes nothing and exits 1", async () => {
    for (const typed of ["Rex", "yes", "rex2"]) {
      const { asked, exit, closed, err } = await run(typed);
      expect(exit).toBe(1);
      expect(asked.map((one) => one.method)).toEqual(["GET"]);
      expect(err.join("\n")).toContain(`not deleted: "${typed}" is not the agent's id`);
      expect(closed).toBe(1);
    }
  });

  test("nothing typed, or input that ends before a line (a script with no stdin), deletes nothing and says so in a line", async () => {
    for (const typed of ["", "  ", new Error("the input ended")]) {
      const { asked, exit, closed, err } = await run(typed);
      expect(exit).toBe(1);
      expect(asked.map((one) => one.method)).toEqual(["GET"]);
      expect(err.join("\n")).toContain("not deleted: the agent's id was not typed");
      expect(err.join("\n")).not.toContain("the input ended");
      expect(closed).toBe(1);
    }
  });

  test("an agent with nothing but its files says only those, and no user where agents have none", async () => {
    const { out } = await run("rex", { ...FOUND, missions: 0, automations: 0, handed: 0, connections: [], rooms: 0, grants: 0, account: false, folder: { bytes: null, files: 20_000, more: true } });
    expect(out.slice(1, 3)).toEqual([
      "  - its own files: its pack and its private folder, where a coding CLI's sign-ins are (over 20000 files)",
      "Kept: its chats, what it remembered, the records of its missions, the audit log and usage. An agent made later with the id rex is joined to them.",
    ]);
  });
});
