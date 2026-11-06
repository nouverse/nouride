/**
 * A tool call's result is one commit — through the real pipeline, wired as the daemon wires it (`boot/durable.ts`).
 *
 * Its writes were four commits in two frames: the `audit` event from inside the tool's own wrapper, then the
 * `tool_done` step twice over (a `turn_steps` row, an event) and the journal's record of the tool message. A follower
 * could read the step before the audit row, and a crash in between left the journal holding a result the stream never
 * said. From a call's `tool` row to its result it is three commits now — the step, the journal's "started", the result
 * — where 0.7.5 made seven.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { audited } from "@/modules/tools/audited.ts";
import { countingDb, envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

describe("a tool call's result", () => {
  test("its audit row, its tool_done and the journal's record are one commit — after the call's own two", async () => {
    let counted!: ReturnType<typeof countingDb>;
    bench = await pipelineBench({
      turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "probed." }],
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
      db: (opened) => (counted = countingDb(opened)).db,
    });
    const { pipeline, gateway, db, events } = bench;
    const probe: Tool = {
      requiresApproval: false,
      definition: { name: "probe", description: "checks a thing", parameters: { type: "object", properties: {} } },
      execute: async () => ({ content: "probe ok", isError: false }),
    };
    // Audited as `buildTools` audits every built-in; the table row is buffered, so it is no commit of the turn's.
    pipeline.setTools(new Map([["probe", audited("probe", probe, new AuditLog(db))]]));
    pipeline.attach();

    gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "probe it", timestamp: Date.now() }));
    await pipeline.idle();

    const commits = counted.commits.map((commit) => commit.join(" + "));
    const from = commits.findIndex((commit) => commit.endsWith("INSERT events:tool"));
    const to = commits.findIndex((commit) => commit.includes("INSERT events:tool_done"));
    expect(from).toBeGreaterThan(-1);
    expect(commits.slice(from, to + 1)).toEqual([
      // The line of the request that asked for the call (0.7.26) goes with the call's row — no commit of its own.
      "INSERT events:context + INSERT events:tool",
      "INSERT turn_journal",
      "INSERT events:audit + INSERT events:tool_done + INSERT turn_journal",
    ]);

    const rows = events.list({ kinds: ["tool", "audit", "tool_done"] });
    expect(rows.map((row) => row.kind)).toEqual(["tool", "audit", "tool_done"]);
    expect(rows.map((row) => row.data.callId)).toEqual(["c1", "c1", "c1"]);
    expect(rows[2]!.seq).toBe(rows[1]!.seq + 1);
  });
});
