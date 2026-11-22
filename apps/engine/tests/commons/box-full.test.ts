/**
 * How full the machine is, said on a turn's message (`commons/box-full.ts`): only where it is short of room, in the
 * machine's own figures, and through the real pipeline on the message and never in the history. The figures are the
 * test's: none of this reads the machine it runs on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { boxFull, COMMANDS_FULL_SHARE, DISK_FREE_BYTES, DISK_FREE_SHARE, fullNote, type BoxFigures } from "@/commons/box-full.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const GB = 1024 ** 3;
const roomy: BoxFigures = { commands: { usedBytes: 1 * GB, maxBytes: 6 * GB }, disk: { totalBytes: 100 * GB, freeBytes: 60 * GB } };

describe("the line is said only where the machine is short of room", () => {
  test("with room in both, nothing is said", () => {
    expect(fullNote(roomy)).toBeNull();
  });

  test("the commands' memory is said from the share of their cap on, in their own figures", () => {
    const at = (share: number) => fullNote({ ...roomy, commands: { usedBytes: share * 5 * GB, maxBytes: 5 * GB } });
    expect(at(COMMANDS_FULL_SHARE - 0.01)).toBeNull();
    expect(at(COMMANDS_FULL_SHARE)).toBe(
      "(This machine is short of room now: the commands running here hold 4.0GB of the 5.0GB of memory they may use together. Something heavy started now may be stopped or fail: wait for work to end, or do the light part first, and say so if the person asked for the heavy part.)",
    );
  });

  test("commands with no cap of their own are near none, however much they hold", () => {
    expect(fullNote({ ...roomy, commands: { usedBytes: 64 * GB, maxBytes: null } })).toBeNull();
    expect(fullNote({ ...roomy, commands: null })).toBeNull();
  });

  test("the disk is said when little of it is free, as a share and in all: either alone is not short", () => {
    // A tenth of a large disk is room for anything an agent does.
    expect(fullNote({ ...roomy, disk: { totalBytes: 500 * GB, freeBytes: 40 * GB } })).toBeNull();
    // A few gigabytes are most of a small one.
    expect(fullNote({ ...roomy, disk: { totalBytes: 16 * GB, freeBytes: 6 * GB } })).toBeNull();
    expect(fullNote({ ...roomy, disk: { totalBytes: 16 * GB, freeBytes: 1.5 * GB } })).toContain("1.5GB of disk is free, of 16.0GB");
    expect(fullNote({ ...roomy, disk: { totalBytes: 500 * GB, freeBytes: 8 * GB } })).toContain("8.0GB of disk is free, of 500.0GB");
    // Right at each bound it is not yet short.
    expect(fullNote({ ...roomy, disk: { totalBytes: 50 * GB, freeBytes: DISK_FREE_SHARE * 50 * GB } })).toBeNull();
    expect(fullNote({ ...roomy, disk: { totalBytes: 1000 * GB, freeBytes: DISK_FREE_BYTES } })).toBeNull();
  });

  test("both short, both are said in one line", () => {
    const note = fullNote({ commands: { usedBytes: 5.5 * GB, maxBytes: 5.9 * GB }, disk: { totalBytes: 32 * GB, freeBytes: 0.8 * GB } });
    expect(note).toContain("the commands running here hold 5.5GB of the 5.9GB of memory they may use together; 819.2MB of disk is free, of 32.0GB.");
  });

  test("a machine that says nothing of itself has nothing said of it", () => {
    expect(fullNote({ commands: null, disk: null })).toBeNull();
    expect(fullNote({ commands: { usedBytes: 0, maxBytes: 0 }, disk: { totalBytes: 0, freeBytes: 0 } })).toBeNull();
  });
});

describe("the reading is kept a little while, and a failed one says nothing", () => {
  test("the machine is read once in half a minute, and again after", () => {
    let reads = 0;
    let clock = 1_000;
    let figures = roomy;
    const read = boxFull(() => (reads++, figures), () => clock);
    expect(read()).toBeNull();
    figures = { ...roomy, disk: { totalBytes: 16 * GB, freeBytes: 1 * GB } };
    clock += 29_000;
    // Still the reading it kept: the disk filled a moment ago, and the next reading says so.
    expect(read()).toBeNull();
    expect(reads).toBe(1);
    clock += 2_000;
    expect(read()).toContain("of disk is free");
    expect(reads).toBe(2);
  });

  test("a reading that throws is no reading", () => {
    const read = boxFull(() => {
      throw new Error("statfs refused");
    });
    expect(read()).toBeNull();
  });
});

describe("through the pipeline", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const undo of cleanup.splice(0).reverse()) undo();
  });

  async function bench(full?: () => string | null) {
    const made = await pipelineBench({ turns: [{ text: "First." }, { text: "Second." }], deps: full ? { full } : {} });
    cleanup.push(made.dispose);
    made.pipeline.attach();
    let n = 0;
    const say = async (text: string) => {
      made.gateway.receive(envelope({ id: `m${++n}`, timestamp: Date.now() + n, text, chatType: "dm", senderId: "operator", gatewayId: made.gateway.id }));
      await made.pipeline.idle();
    };
    return { ...made, say };
  }
  const SHORT = "(This machine is short of room now: 1.0GB of disk is free, of 16.0GB. Something heavy started now may be stopped or fail.)";

  test("the line rides on the message the turn answers, and a later message with room says nothing", async () => {
    let note: string | null = SHORT;
    const h = await bench(() => note);
    await h.say("build the site");
    const first = h.requests[0]!.messages;
    expect(String(first.at(-1)!.content)).toEndWith(SHORT);
    // On the message, never in the prompt: a line that moves by the minute there would write the cached part again.
    expect(String(first[0]!.content)).not.toContain("short of room");
    // Room again: the next message says nothing. What was said stays on the message it was said on, as it was sent.
    note = null;
    await h.say("and now?");
    const second = h.requests[1]!.messages;
    expect(String(second.at(-1)!.content)).not.toContain("short of room");
    expect(String(second[1]!.content)).toEndWith(SHORT);
  });

  test("where nothing reads the machine, nothing is said", async () => {
    const h = await bench();
    await h.say("build the site");
    expect(JSON.stringify(h.requests[0]!.messages)).not.toContain("short of room");
  });
});
