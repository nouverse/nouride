/**
 * Capping a tool result before it reaches the context.
 *
 * The behaviour this replaces put a 6.6MB `exec` log into the working set whole. `trimToolResults`
 * could not save it — it never touches the newest results, which is exactly where a result that just
 * arrived sits — so it was paid for on every request until three more tool calls pushed it out.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, listDir, readTextFileIfExists, removePath, statFile, writeTextFile } from "@nouride/runtime";
import { childSessionId } from "@nouride/shared";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";

let dir: string;
let root: string;
let spill: ToolOutputSpill;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-spill-"));
  root = join(dir, "tool-output");
  spill = new ToolOutputSpill(root);
});

afterEach(() => {
  removePath(dir);
});

/** `n` numbered lines, so a test can tell head from tail from middle by reading one. */
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

const keep = (content: string, maxTokens = 100) =>
  spill.keep({ agentId: "nouva", sessionId: "s1", callId: "call_1", toolName: "exec", content, maxTokens });

describe("what fits is left alone", () => {
  test("a small result comes back byte-identical and writes nothing", async () => {
    // The common case, and it has to cost nothing: most tool calls return a sentence.
    const outcome = await keep("done");

    expect(outcome.content).toBe("done");
    expect(outcome.path).toBeNull();
    // The directory exists from construction (it is a sandbox root), and stays empty.
    expect(listDir(root)).toEqual([]);
  });

  test("a result exactly at the budget is not spilled", async () => {
    // Off-by-one here would spill on the boundary and put a file on disk for output that fit.
    const outcome = await keep("x".repeat(40), 10);

    expect(outcome.path).toBeNull();
    expect(outcome.content.length).toBe(40);
  });
});

describe("what does not fit goes to disk", () => {
  test("the whole output is on disk, unmodified", async () => {
    // The point of the file is that nothing was lost. An excerpt written to disk would be the same
    // truncation with an extra step.
    const content = lines(5_000);
    const outcome = await keep(content);

    expect(outcome.path).not.toBeNull();
    expect(await readTextFileIfExists(outcome.path!)).toBe(content);
  });

  test("the model gets the head and the tail, not the middle", async () => {
    // A long log carries its signal at the two ends — what it set out to do, and whether it worked.
    const outcome = await keep(lines(5_000));

    expect(outcome.content).not.toContain("line 2500");
    // In the order they were printed, at both ends: the head opens on the first line and the tail
    // closes on the last. "Contains line 0" passed with either end shown upside down.
    expect(outcome.content).toContain("--- first");
    const [, head = "", tail = ""] = outcome.content.split(/^--- (?:first|last) \d+ lines ---$/m);
    expect(head.trim()).toStartWith("line 0\nline 1\n");
    expect(tail.trim()).toEndWith("line 4998\nline 4999");
  });

  test("it reports the real size, and how much it is not showing", async () => {
    // Silently substituting a short result invites the model to conclude the command printed nothing
    // and report success. Every number here is measured.
    const content = lines(5_000);
    const outcome = await keep(content);

    expect(outcome.content).toContain("5000 lines");
    expect(outcome.content).toContain(`~${Math.round(content.length / 1024)}KB`);
    expect(outcome.content).toMatch(/\d+ in the middle are not/);
  });

  test("it names the path and says how to read more", async () => {
    // The path is only useful with an instruction attached: a model told a file exists and not how to
    // open part of it re-runs the command instead.
    const outcome = await keep(lines(5_000));

    expect(outcome.content).toContain(outcome.path!);
    expect(outcome.content).toContain("read");
    expect(outcome.content).toContain("grep");
  });

  test("the excerpt honours the token budget it was given", async () => {
    // The cap is the whole feature. An excerpt that ignored it would move the overflow rather than
    // prevent it — and the budget is derived per turn from the real window.
    const small = await keep(lines(20_000), 50);
    const large = await keep(lines(20_000), 2_000);

    expect(small.content.length).toBeLessThan(large.content.length);
    // Header and footing are not free, so the check is on the excerpt's order of magnitude rather
    // than an exact byte count.
    expect(small.content.length).toBeLessThan(50 * 4 + 600);
  });

  test("only whole lines are kept", async () => {
    // A fragment ending mid-token reads as corruption rather than as truncation.
    const outcome = await keep(lines(5_000), 60);
    // Every line that is neither blank nor one of the harness's own framing lines has to be a whole
    // line of the original output.
    const body = outcome.content
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("[") && !line.startsWith("---"))
      .filter((line) => !line.startsWith("Full output:") && !line.startsWith("Search it"));

    expect(body.length).toBeGreaterThan(1);
    for (const line of body) expect(line).toMatch(/^line \d+$/);
  });

  test("output with no newlines at all still yields an excerpt", async () => {
    // A minified blob, a base64 payload. Taking "whole lines" from a single line means taking that
    // line, and returning nothing would look like a tool that printed nothing.
    const outcome = await keep("x".repeat(100_000), 100);

    expect(outcome.path).not.toBeNull();
    expect(outcome.content).toContain("1 lines");
    expect(outcome.content).toContain("xxx");
  });

  test("the file is not world-readable", async () => {
    // A tool result can hold whatever the agent read — a credential file, a database dump. Same mode
    // the job logs and the secret store use.
    const outcome = await keep(lines(5_000));
    const mode = (await import("node:fs")).statSync(outcome.path!).mode & 0o777;

    expect(mode).toBe(0o600);
  });
});

describe("ids the daemon did not choose", () => {
  test("a session id with path characters cannot escape the spill directory", async () => {
    // A session id is derived from a chat id, and a chat id is whatever the platform sends. A WhatsApp
    // JID already contains `@`; nothing stops a future one containing a slash. This is the one place
    // that writes with the daemon's own privileges.
    const outcome = await spill.keep({
      agentId: "../nouva",
      sessionId: "../../../../etc/evil",
      callId: "../../x",
      toolName: "exec",
      content: lines(5_000),
      maxTokens: 100,
    });

    expect(outcome.path).not.toBeNull();
    expect(outcome.path!.startsWith(root)).toBe(true);
    expect(outcome.path).not.toContain("..");
  });

  test("two calls in one turn do not overwrite each other", async () => {
    const first = await spill.keep({
      agentId: "nouva", sessionId: "s1", callId: "call_a", toolName: "exec", content: lines(5_000), maxTokens: 100,
    });
    const second = await spill.keep({
      agentId: "nouva", sessionId: "s1", callId: "call_b", toolName: "exec", content: lines(4_000), maxTokens: 100,
    });

    expect(first.path).not.toBe(second.path);
    expect((await readTextFileIfExists(first.path!))?.split("\n").length).toBe(5_000);
    expect((await readTextFileIfExists(second.path!))?.split("\n").length).toBe(4_000);
  });
});

describe("when the write fails", () => {
  test("the turn still gets an excerpt, and is told the file is not there", async () => {
    // A failed write is not a failed tool call. The excerpt is still the most useful thing available,
    // and claiming a path that does not exist would send the agent to open nothing.
    // A *file* where the session directory has to go: `ensureDir` cannot create a directory over it.
    // Written first, because the constructor creates its own root and would otherwise take this path.
    ensureDir(join(dir, "blocked", "nouva"));
    await writeTextFile(join(dir, "blocked", "nouva", "s1"), "not a directory");
    const blocked = new ToolOutputSpill(join(dir, "blocked"));

    const outcome = await blocked.keep({
      agentId: "nouva", sessionId: "s1", callId: "c", toolName: "exec", content: lines(5_000), maxTokens: 100,
    });

    expect(outcome.path).toBeNull();
    expect(outcome.content).toContain("could not be written");
    expect(outcome.content).toContain("line 0");
    expect(outcome.content).not.toContain("Full output:");
  });
});

describe("cleaning up", () => {
  const age = (path: string, days: number) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60_000);
    (require("node:fs") as typeof import("node:fs")).utimesSync(path, when, when);
  };

  test("a conversation's files go as a unit once it is old enough", async () => {
    const outcome = await keep(lines(5_000));
    const sessionDir = join(root, "nouva", "s1");
    age(sessionDir, 5);

    expect(spill.sweep(2)).toBe(1);
    expect(statFile(outcome.path!)).toBeNull();
  });

  test("a conversation still producing output keeps all of it", async () => {
    // Swept by directory mtime, not per file: per-file would strand a session whose first call is old
    // and whose last is minutes ago — which is the session still being read from.
    const outcome = await keep(lines(5_000));

    expect(spill.sweep(2)).toBe(0);
    expect(statFile(outcome.path!)).not.toBeNull();
  });

  test("zero disables the sweep instead of deleting everything", async () => {
    // A knob whose zero wipes a directory eventually wipes one.
    const outcome = await keep(lines(5_000));
    age(join(root, "nouva", "s1"), 500);

    expect(spill.sweep(0)).toBe(0);
    expect(statFile(outcome.path!)).not.toBeNull();
  });
});

describe("counting lines", () => {
  test("a trailing newline is the end of the last line, not another one", async () => {
    const outcome = await keep(`${lines(5_000)}\n`);
    expect(outcome.content).toContain("5000 lines");
  });
});

describe("one line bigger than the budget", () => {
  test("is cut to the budget instead of being kept whole", async () => {
    // Minified JSON, a base64 blob. "At least one whole line" used to return the entire line — in the
    // head and again in the tail — so the excerpt came out twice the size of the output it replaced.
    const blob = `${"a".repeat(50_000)}${"z".repeat(50_000)}`;
    const outcome = await keep(blob, 100);

    expect(outcome.content.length).toBeLessThan(100 * 4 + 800);
    // The head shows how the line starts and the tail how it ends — each end cut from its own side.
    expect(outcome.content).toMatch(/\na+ \[…line continues\]\n/);
    expect(outcome.content).toMatch(/\[line began earlier…\] z+$/);
    expect(outcome.content).toContain("0 in the middle are not");
  });

  test("a cut never splits a character in two", async () => {
    // An emoji is two UTF-16 units. Slicing between them leaves a lone surrogate, which a provider's
    // JSON encoder rejects or replaces.
    const outcome = await keep("😀".repeat(50_000), 100);

    expect(outcome.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  test("the head and the tail never show the same line", async () => {
    // Three lines, the middle one enormous: the head takes line 0 and cuts nothing, the tail must not
    // reach back into what the head already showed.
    const outcome = await keep(["first", "y".repeat(100_000), "last"].join("\n"), 100);

    const shown = outcome.content.split("\n");
    expect(shown.filter((line) => line === "first")).toHaveLength(1);
    expect(shown.filter((line) => line === "last")).toHaveLength(1);
    expect(outcome.content).toContain("1 in the middle are not");
  });
});

describe("output a tool already streamed to disk", () => {
  const spooled = async (content: string, whole: { chars: number; lines: number }, path: string | null) =>
    spill.keep({
      agentId: "nouva", sessionId: "s1", callId: "call_1", toolName: "exec", content, maxTokens: 100,
      spooled: { path, ...whole },
    });

  test("is named, not written again", async () => {
    const path = join(dir, "already-there.txt");
    const outcome = await spooled(lines(5_000), { chars: 9_000_000, lines: 1_200_000 }, path);

    expect(outcome.path).toBe(path);
    expect(outcome.content).toContain(`Full output: ${path}`);
    // Nothing of its own on disk: the file the tool wrote is the only copy.
    expect(listDir(join(root, "nouva", "s1"))).toEqual([]);
  });

  test("reports the size of the whole output, not of the ends it was handed", async () => {
    const outcome = await spooled(lines(5_000), { chars: 9_000_000, lines: 1_200_000 }, join(dir, "f.txt"));

    expect(outcome.content).toContain("1200000 lines");
    expect(outcome.content).toContain(`~${Math.round(9_000_000 / 1024)}KB`);
  });

  test("is an excerpt even when the ends it was handed would fit", async () => {
    // The ends are not the output. Returned as they were, the model would read them as all of it.
    const outcome = await spooled("start\nend", { chars: 5_000_000, lines: 80_000 }, join(dir, "f.txt"));

    expect(outcome.content).toContain("80000 lines");
    expect(outcome.content).toContain("Full output:");
    // Both lines fit the head, so the tail has nothing left to show — not the same two lines again.
    const shown = outcome.content.split("\n");
    expect(shown.filter((line) => line === "start" || line === "end")).toHaveLength(2);
  });

  test("with no file, says the ends are all that is left", async () => {
    const outcome = await spooled(lines(5_000), { chars: 9_000_000, lines: 1_200_000 }, null);

    expect(outcome.path).toBeNull();
    expect(outcome.content).toContain("could not be written");
  });
});

describe("whose output it is", () => {
  test("two agents never share a directory", () => {
    // The whole directory used to be every agent's read-only root.
    const nouva = spill.rootFor({ agentId: "nouva", sessionId: "ses_x" });
    const nix = spill.rootFor({ agentId: "nix", sessionId: "ses_x" });

    expect(nouva).not.toBe(nix);
    expect(nouva.startsWith(nix)).toBe(false);
    expect(nix.startsWith(nouva)).toBe(false);
  });

  test("two conversations of one agent never share a directory", () => {
    expect(spill.rootFor({ agentId: "nouva", sessionId: "ses_a" })).not.toBe(
      spill.rootFor({ agentId: "nouva", sessionId: "ses_b" }),
    );
  });

  test("a delegate helper writes where the lead it reports to can read", () => {
    // The helper names its spill file in the handoff; the lead can only open it from its own root.
    const lead = spill.rootFor({ agentId: "nouva", sessionId: "ses_nouva:tg:1" });
    const helperFile = spill.pathFor({ agentId: "nouva", sessionId: childSessionId("ses_nouva:tg:1", "sub"), callId: "c1" });

    expect(helperFile.startsWith(`${lead}/`)).toBe(true);
  });

  test("forgetting a conversation removes its files and nobody else's", async () => {
    const mine = await keep(lines(5_000));
    const other = await spill.keep({
      agentId: "nouva", sessionId: "s2", callId: "c", toolName: "exec", content: lines(5_000), maxTokens: 100,
    });

    spill.forget({ agentId: "nouva", sessionId: "s1" });

    expect(statFile(mine.path!)).toBeNull();
    expect(statFile(other.path!)).not.toBeNull();
  });
});

describe("sweeping both layouts", () => {
  const age = (path: string, days: number) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60_000);
    (require("node:fs") as typeof import("node:fs")).utimesSync(path, when, when);
  };

  test("an old conversation goes, a live one of the same agent stays", async () => {
    // An agent directory's mtime moves only when a conversation is added, so sweeping it as a unit
    // would delete a conversation still being read from.
    const old = await keep(lines(5_000));
    const live = await spill.keep({
      agentId: "nouva", sessionId: "s2", callId: "c", toolName: "exec", content: lines(5_000), maxTokens: 100,
    });
    age(join(root, "nouva", "s1"), 5);
    age(join(root, "nouva"), 5);

    expect(spill.sweep(2)).toBe(1);
    expect(statFile(old.path!)).toBeNull();
    expect(statFile(live.path!)).not.toBeNull();
  });

  test("a conversation from before the split is swept by its own age", async () => {
    // A daemon upgraded mid-conversation has the flat layout on disk as well.
    const legacy = join(root, "ses_legacy");
    ensureDir(legacy);
    await writeTextFile(join(legacy, "call.txt"), "old output");
    age(legacy, 5);

    expect(spill.sweep(2)).toBe(1);
    expect(statFile(legacy)).toBeNull();
  });

  test("an agent left with no conversations is removed too", async () => {
    await keep(lines(5_000));
    age(join(root, "nouva", "s1"), 5);

    spill.sweep(2);

    expect(statFile(join(root, "nouva"))).toBeNull();
  });
});
