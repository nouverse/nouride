/**
 * How a progress line reads.
 *
 * Tested against a fake gateway rather than through the pipeline, because the pipeline replaces a tool
 * named `exec` with the real one — and what is under test here is the *rendering*, not the tool loop.
 * Every case below came from looking at the real thing on a phone.
 */

import { describe, expect, test } from "bun:test";
import type { Gateway, OutboundMessage } from "@nouride/shared";
import { ChatProgress } from "@/modules/pipeline/chat-progress.ts";
import { nudgeRead } from "@/modules/llm/executor/nudges.ts";
import { eventually, sleep } from "../wait.ts";

function fakeGateway() {
  const sent: OutboundMessage[] = [];
  const edits: string[] = [];
  const gateway = {
    id: "telegram:test",
    platform: "telegram",
    status: "connected",
    async send(msg: OutboundMessage) {
      sent.push(msg);
      return [`id-${sent.length}`];
    },
    async editMessage(_chat: string, _id: string, text: string) {
      edits.push(text);
      return true;
    },
    async setTyping() {},
    async start() {},
    async stop() {},
    onMessage() {},
    onEvent() {},
  } as unknown as Gateway;
  return { gateway, sent, edits };
}

const progressOn = (gateway: Gateway) =>
  new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 0 });

/** A platform that asked for one closing line instead of a live bubble. See `Gateway.progressStyle`. */
function summaryRecorder() {
  const it = fakeGateway();
  return { ...it, gateway: { ...it.gateway, progressStyle: "summary" } as unknown as Gateway };
}

/** A platform that paces its sends, as Telegram's are a second apart per chat: each waits until `release`. */
function pacedGateway() {
  const it = fakeGateway();
  const held: (() => void)[] = [];
  const send = it.gateway.send.bind(it.gateway);
  Object.assign(it.gateway, { send: (msg: OutboundMessage) => new Promise<string[]>((resolve) => held.push(() => void send(msg).then(resolve))) });
  return { ...it, held, release: () => held.splice(0).forEach((go) => go()) };
}

/** The write happens on a timer, so a test has to let it land. */
const settle = () => sleep(10);

describe("the live line", () => {
  test("a multi-line command collapses to one line", async () => {
    // `describeToolCall` joins an argv with spaces, so `exec python3 -c "<script>"` arrives carrying
    // every newline of the script. In a terminal that wraps; in a chat it was a wall of text.
    const { gateway, sent } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("exec python3 -c import urllib.request\nurl = 'https://lite.duckduckgo.com/'\nprint(url)");
    await settle();

    expect(sent[0]?.text).not.toContain("\n");
    expect(sent[0]?.text).toContain("exec python3 -c import urllib.request");
  });

  test("in-progress is marked, and marked by kind", async () => {
    const cases: [string, string][] = [
      ["exec ls -la", "⏳ 💻"],
      ["read config.toml", "⏳ 📖"],
      ["write notes.md", "⏳ ✏️"],
      ["grep TODO", "⏳ 🔍"],
      ["web_fetch https://example.com", "⏳ 🌐"],
      ["plan 2 of 5 done", "⏳ 📋"],
      ["nouva-mcp__memory_query recall", "⏳ 🔌"],
      ["something_unknown x", "⏳ 🔧"],
      // The plan tool's name until 0.7.16: no live turn calls it now.
      ["task_plan 2 of 5 done", "⏳ 🔧"],
    ];

    for (const [line, expected] of cases) {
      const { gateway, sent } = fakeGateway();
      progressOn(gateway).step(line);
      await settle();
      expect(sent[0]?.text.startsWith(expected)).toBe(true);
    }
  });

  test("a coding CLI's step, its command alone, is marked by the tool of Nouride's it is like (0.8.5)", async () => {
    // Claude Code's step line is "git status": no tool name to read a mark from, so every command was marked 🔧.
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);
    progress.show("tool", "git status", { callId: "t1", name: "Bash", like: "exec" });
    await settle();
    expect(sent[0]?.text).toBe("⏳ 💻 git status");
    // Like none: the line's own mark, as before.
    progress.show("tool", "apps/engine/src/index.ts", { callId: "t2", name: "Read" });
    await settle();
    expect(edits.at(-1)).toBe("⏳ 🔧 apps/engine/src/index.ts");
  });

  test("waiting on a human is marked differently from working", async () => {
    // A turn parked on an approval is not slow — it is waiting for somebody, and the somebody is the
    // person reading the line. Without a distinct mark those two states look identical.
    const { gateway, sent } = fakeGateway();
    progressOn(gateway).step("waiting for approval: exec", true);
    await settle();

    expect(sent[0]?.text.startsWith("⏸")).toBe(true);
  });

  test("the platform is told not to decorate a link", async () => {
    // A URL inside a command is incidental. Left alone, Telegram rendered a full preview card for a
    // page nobody asked about, on the message that exists to say one thing.
    const { gateway, sent } = fakeGateway();
    progressOn(gateway).step("exec curl https://example.com/thing");
    await settle();

    expect(sent[0]?.suppressPreview).toBe(true);
  });

  test("a long line is truncated rather than sent whole", async () => {
    const { gateway, sent } = fakeGateway();
    progressOn(gateway).step(`exec ${"x".repeat(500)}`);
    await settle();

    expect(sent[0]!.text.length).toBeLessThan(200);
    expect(sent[0]!.text).toContain("…");
  });

  test("a cut line keeps its end, because that is what the command is about", async () => {
    // The head-only cut spent the whole budget on a key path and a pile of flags, so every long `ssh`
    // line read as "nouva is ssh-ing somewhere" — identically, for a whole turn. Which host, running
    // what, is at the far end.
    const { gateway, sent } = fakeGateway();
    progressOn(gateway).step(
      "exec ssh -i /srv/nouride/.nouride/agents/shared/.credentials/id_ed25519_nouva " +
        "-o ConnectTimeout=5 -o StrictHostKeyChecking=no user@192.168.0.6 " +
        'powershell -Command "Get-ChildItem D:\\projects\\voice-compute\\voices"',
    );
    await settle();

    const line = sent[0]!.text;
    // Still one short line, and still says what kind of work it is.
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("exec ssh");
    // The half that used to be thrown away.
    expect(line).toContain("voice-compute");
    expect(line).toContain("…");
  });
});

describe("one message, not many", () => {
  test("later steps edit the first message", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    progress.step("read b.txt");
    await settle();
    progress.step("exec ls");
    await settle();

    expect(sent).toHaveLength(1);
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.at(-1)).toContain("exec ls");
  });

  test("finishing leaves a record, not a stale running line", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    await progress.finish("ok");

    expect(edits.at(-1)).toMatch(/^✓ \d+ steps? · \d+s$/);
  });

  test("a failed turn says so", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("exec ls");
    await settle();
    await progress.finish("failed");

    expect(edits.at(-1)?.startsWith("✕")).toBe(true);
  });

  test("nothing is posted when no step ever happened", async () => {
    // A plain question the model just answers should leave the conversation untouched.
    const { gateway, sent, edits } = fakeGateway();
    await progressOn(gateway).finish("ok");

    expect(sent).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });

  test("repeating the same step does not rewrite the message", async () => {
    // The tool loop can report the same action twice; an edit to identical text is a wasted write and
    // Telegram rejects it outright.
    const { gateway, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    progress.step("read a.txt");
    await settle();

    expect(edits).toHaveLength(0);
  });

  test("steps after finish are ignored", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    await progress.finish("ok");
    const after = edits.length;

    progress.step("exec ls");
    await settle();
    expect(edits).toHaveLength(after);
  });
});

describe("gateways that cannot edit", () => {
  test("are not offered progress at all", () => {
    const plain = { id: "x", platform: "web", async send() { return []; } } as unknown as Gateway;
    expect(ChatProgress.supported(plain)).toBe(false);
  });
});

describe("an approval interrupts the bubble", () => {
  /**
   * The bug, exactly as it looked on a phone.
   *
   * Progress is one message, edited. When an approval prompt is posted the live bubble stops being the
   * last thing in the chat — the prompt, the person's `/approve` and the acknowledgement all land
   * below it. Editing it after that moves numbers somewhere the reader has already scrolled past, so
   * approving looked like it made the agent stop dead: the count kept climbing to "18 steps" in a
   * message far above, and nothing new appeared underneath.
   */
  test("sealing writes the count so far and stops using that message", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    expect(sent).toHaveLength(1);

    await progress.seal("waiting for you");

    const sealed = edits.at(-1) ?? "";
    expect(sealed).toContain("⏸");
    // The count is kept, not reset — it is what the turn cost so far.
    expect(sealed).toContain("1 step");
    expect(sealed).toContain("waiting for you");
  });

  test("the next step posts a new message instead of editing the sealed one", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    await progress.seal("waiting for you");
    const editsAfterSeal = edits.length;

    progress.step("write b.txt");
    await settle();

    // A second message, below the approval — which is the whole point.
    expect(sent).toHaveLength(2);
    expect(edits).toHaveLength(editsAfterSeal);
    expect(sent[1]?.text).toContain("write b.txt");
  });

  test("each bubble reports its own steps and time, not a running total", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    progress.step("read b.txt");
    await settle();
    await progress.seal("waiting for you");

    // First bubble: what happened before the approval.
    expect(edits.at(-1)).toContain("2 steps");

    progress.step("write c.txt");
    await settle();
    await progress.finish("ok");

    // Second bubble: one step, counted from zero. A running total made one long turn read as several
    // cheap ones, and a bubble that opened at "step 13" gave the reader no way to see where that came
    // from — the earlier count was in a message they had scrolled past.
    expect(sent).toHaveLength(2);
    expect(edits.at(-1)).toContain("1 step");
    expect(edits.at(-1)).not.toContain("3 steps");
  });

  test("the bubble is posted before the approval, even if the throttle has not elapsed", async () => {
    // The case that made this wrong on a phone: a tool needing approval fires `tool` and `waiting`
    // milliseconds apart, so nothing had been posted when the prompt went out — and the bubble arrived
    // *underneath* the question it was meant to precede. Sealing ignores the throttle.
    const { gateway, sent } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 60_000 });

    progress.step("nouva-mcp__memory_grep {\"query\":\"cinda\"}");
    // Deliberately no settle: the timer is a minute away.
    expect(sent).toHaveLength(0);

    await progress.seal("waiting for you");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("1 step");
  });

  test("sealing before anything was posted does nothing", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    // A turn parked on an approval before its first tool has no bubble to seal, and must not invent
    // one — a turn with no tools leaves no trace.
    await progress.seal("waiting for you");
    expect(sent).toHaveLength(0);
    expect(edits).toHaveLength(0);
  });

  test("two seals in a row do not post an empty bubble", async () => {
    const { gateway, sent } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("read a.txt");
    await settle();
    await progress.seal("waiting for you");
    await progress.seal("waiting for you");

    // Back-to-back approvals are ordinary; the second must find nothing to seal rather than open a
    // bubble just to close it.
    expect(sent).toHaveLength(1);
  });
});

describe("the agent's own words interrupt the bubble (0.8.5)", () => {
  test("the bubble closes on what it covered, done, and the steps after the words start one below", async () => {
    // A coding CLI writes between its steps, and each message goes to the chat as it is written (`preamble.ts`). Left
    // open, the bubble went on being edited above them, where nobody was looking.
    const { gateway, sent, edits } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 0, agentLabel: "nix" });
    progress.step("exec git status");
    progress.step("exec git diff");
    await settle();
    await progress.seal();
    expect(edits.at(-1)).toMatch(/^\[nix\] ✓ 2 steps · \d+s$/);

    progress.step("exec bun test");
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toBe("[nix] ⏳ 💻 exec bun test");
  });

  test("a bubble still on its way when the words come is closed then, not a message later", async () => {
    // Codex on the live box: its next words came milliseconds after a step, while the bubble's post waited its turn; taken
    // for no bubble, it was closed only at the words after, as `✓ 2 steps`, above the wrong message.
    const { gateway, sent, edits, held, release } = pacedGateway();
    const progress = progressOn(gateway);
    progress.step("exec pwd");
    await settle();
    expect(held).toHaveLength(1);
    const sealing = progress.seal();
    await settle();
    release();
    await sealing;
    expect(sent.map((m) => m.text)).toEqual(["⏳ 💻 exec pwd"]);
    expect(edits.at(-1)).toMatch(/^✓ 1 step · \d+s$/);
  });

  test("steps the throttle has not posted when the answer comes are not posted after it", async () => {
    // Left to the timer, the bubble went out after the answer — and stayed `⏳ 💻 date` under it for good.
    const { gateway, sent } = fakeGateway();
    const progress = progressOn(gateway);
    progress.step("exec ls");
    await settle();
    await progress.seal();
    // Its timer due at once: the answer goes out before it fires.
    progress.step("exec date");
    await progress.beforeAnswer("ok");
    await gateway.send({ gatewayId: gateway.id, chatId: "chat-1", text: "the answer" });
    await settle();
    await progress.finish("ok");
    expect(sent.map((m) => m.text)).toEqual(["⏳ 💻 exec ls", "the answer"]);
  });

  test("a bubble still on its way when the turn ends is closed, not left saying ⏳", async () => {
    const { gateway, edits, held, release } = pacedGateway();
    const progress = progressOn(gateway);
    progress.step("exec date");
    await settle();
    expect(held).toHaveLength(1);
    const finishing = progress.finish("ok");
    release();
    await finishing;
    expect(edits.at(-1)).toMatch(/^✓ 1 step · \d+s$/);
  });
});

describe("agent label", () => {
  test("every line is prefixed with the agent name when set", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 0, agentLabel: "nix" });

    progress.step("exec kubectl get pods");
    await settle();
    expect(sent[0]?.text).toMatch(/^\[nix\] ⏳ 💻/);

    progress.step("read output.txt");
    await settle();
    expect(edits.at(-1)).toMatch(/^\[nix\] ⏳ 📖/);

    await progress.finish("ok");
    expect(edits.at(-1)).toMatch(/^\[nix\] ✓/);
  });

  test("seal also carries the label", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 0, agentLabel: "nox" });

    progress.step("read a.txt");
    await settle();
    await progress.seal("waiting for you");

    expect(edits.at(-1)).toMatch(/^\[nox\] ⏸/);
  });

  test("no label means no prefix — existing behaviour unchanged", async () => {
    const { gateway, sent } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "chat-1", minIntervalMs: 0 });

    progress.step("exec ls");
    await settle();
    expect(sent[0]?.text).toMatch(/^⏳ 💻/);
  });
});

/**
 * WhatsApp asked for the quiet version.
 *
 * Not a preference about verbosity — a fact about where the conversation is. On a personal messenger a
 * bubble reading `⏳ 💻 exec sh -c node -v && npm -v` arriving between two sentences is the machinery
 * talking over the conversation, and WhatsApp is the one platform of the three with no bot-channel
 * convention to absorb it. What is kept is the closing line: the work still shows, it just does not
 * narrate itself while it happens.
 */
describe("a platform that only wants the summary", () => {
  test("says nothing at all while the turn runs", async () => {
    const { gateway, sent, edits } = summaryRecorder();
    const progress = progressOn(gateway);

    progress.step("exec sh -c node -v && npm -v");
    progress.step("read /etc/hosts");
    progress.step("exec bun run build");
    await settle();

    // Not one message, and nothing to edit — the person's phone stays silent until there is an answer.
    expect(sent).toEqual([]);
    expect(edits).toEqual([]);
  });

  test("and leaves one line at the end, with the steps it counted", async () => {
    const { gateway, sent, edits } = summaryRecorder();
    const progress = progressOn(gateway);

    progress.step("exec one");
    progress.step("read two");
    await settle();
    await progress.finish("ok");

    // Sent, not edited: there was never a bubble to edit, and `flush` already handles that case.
    expect(edits).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("✓ 2 steps");
    expect(sent[0]?.text).toMatch(/· \d+s/);
  });

  test("a turn that ran no tools still leaves nothing", async () => {
    // The same rule as the live style: a plain question that the model simply answers has no progress
    // to report, and a bare "✓ 0 steps" under an answer is noise with a tick on it.
    const { gateway, sent } = summaryRecorder();
    await progressOn(gateway).finish("ok");
    expect(sent).toEqual([]);
  });

  test("an approval in the middle does not split the count", async () => {
    /**
     * `seal` exists because an approval prompt pushes a live bubble out of view, so the bubble is
     * closed and the next one starts from zero. There is no bubble here to be pushed anywhere, and one
     * line covering the whole turn is the entire point — a turn that paused for an approval is still
     * one turn.
     */
    const { gateway, sent } = summaryRecorder();
    const progress = progressOn(gateway);

    progress.step("exec rm -rf /tmp/x");
    await progress.seal("waiting for you");
    progress.step("exec bun test");
    await settle();
    await progress.finish("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("✓ 2 steps");
  });

  test("a failed turn is marked failed, not hidden", async () => {
    const { gateway, sent } = summaryRecorder();
    const progress = progressOn(gateway);

    progress.step("exec bun test");
    await progress.finish("failed");

    expect(sent[0]?.text).toContain("✕ 1 step");
  });

  test("the closing line is posted before the answer, not after it", async () => {
    /**
     * It landed under the reply the first time, reading as a footnote to an answer that had already
     * finished — the summary is meant to introduce the work, not annotate it afterwards.
     *
     * The cause was position, not timing: `finish` runs in a `finally` block, and in live style that
     * is harmless because the bubble was created on the first tool and already sits above. With
     * nothing posted until the end, wherever `finish` runs is where the line goes.
     */
    const { gateway, sent } = summaryRecorder();
    const progress = progressOn(gateway);

    progress.step("exec bun test");
    await progress.beforeAnswer("ok");

    // Posted by the time the caller is ready to answer, which is the whole point.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("✓ 1 step");

    // And the `finally` call that follows does not post a second one.
    await progress.finish("ok");
    expect(sent).toHaveLength(1);
  });

  test("a live platform is not made to wait for its own status line", async () => {
    /**
     * `beforeAnswer` is a no-op in live style once the bubble is posted, deliberately. It is already above the answer, so
     * there is nothing to reposition — and awaiting an edit here would put a round-trip to a chat
     * platform in front of every reply, which is exactly why the call in `turn.ts` is not awaited.
     */
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("exec bun test");
    await settle();
    const before = sent.length + edits.length;
    await progress.beforeAnswer("ok");

    expect(sent.length + edits.length).toBe(before);
  });

  test("the platforms that did not ask for it are untouched", async () => {
    // Telegram and Discord keep the live bubble. This is the assertion that would fail if the change
    // had been made globally rather than per platform.
    const { gateway, sent, edits } = fakeGateway();
    const progress = progressOn(gateway);

    progress.step("exec one");
    await settle();
    progress.step("read two");
    await settle();

    expect(sent).toHaveLength(1);
    expect(edits).not.toEqual([]);
  });
});

/**
 * A peer that answered without touching a tool.
 *
 * The ordinary rule — a turn with no tools leaves no trace — is right for an agent talking to a
 * person: its answer *is* the trace. A peer's answer never reaches the conversation as its own
 * message; it goes back to the agent that asked, which folds it into a reply of its own. So this
 * line is the only sign the peer ran.
 *
 * Found by asking two agents in parallel. One checked a load average and appeared; the other
 * answered from its own prompt and vanished — which reads as "the second one was never asked", and
 * looked like the parallel call had silently run one.
 */
describe("announcing a turn that did nothing", () => {
  test("a peer with no steps still reports, in summary style", async () => {
    const { gateway, sent } = summaryRecorder();
    const progress = new ChatProgress({ gateway, chatId: "c1", agentLabel: "nexa", announceEmpty: true });

    await progress.finish("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("[nexa]");
    expect(sent[0]?.text).toContain("0 steps");
  });

  test("a peer with no steps still reports, in live style", async () => {
    const { gateway, sent } = fakeGateway();
    const progress = new ChatProgress({ gateway, chatId: "c1", agentLabel: "nexa", announceEmpty: true });

    await progress.finish("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("0 steps");
  });

  test("and an ordinary turn still says nothing", async () => {
    // The default, unchanged: a `✓ 0 steps` above an answer that already explains itself is noise.
    const { gateway, sent } = summaryRecorder();
    const plain = new ChatProgress({ gateway, chatId: "c1" });
    await plain.finish("ok");
    expect(sent).toEqual([]);

    const live = fakeGateway();
    const alsoPlain = new ChatProgress({ gateway: live.gateway, chatId: "c1" });
    await alsoPlain.finish("ok");
    expect(live.sent).toEqual([]);
  });

  test("a failed peer says so rather than disappearing", async () => {
    // The case that matters most: a peer that failed before its first tool is exactly the one a
    // person needs told about, and it was the quietest.
    const { gateway, sent } = summaryRecorder();
    const progress = new ChatProgress({ gateway, chatId: "c1", agentLabel: "nero", announceEmpty: true });
    await progress.finish("failed");
    expect(sent[0]?.text).toContain("✕");
  });
});

describe("calls running at the same time", () => {
  /** The newest thing the bubble says, whether it was the first send or an edit. */
  const shown = (it: ReturnType<typeof fakeGateway>) => it.edits.at(-1) ?? it.sent.at(-1)?.text ?? "";

  test("a batch is one line naming every call, and the calls after it do not replace it", async () => {
    // The bubble shows one line at a time. Announced one by one, a batch of three showed only the
    // third, and read as one call.
    const it = fakeGateway();
    const progress = progressOn(it.gateway);
    const lines = ["read a.ts", "grep TODO", "web_fetch 2 pages: example.com, example.org"];

    progress.batch(lines);
    for (const line of lines) progress.step(line);
    await settle();

    expect(shown(it)).toContain("⚡ 3 at once");
    expect(shown(it)).toContain("read a.ts");
    expect(shown(it)).toContain("example.org");
  });

  test("each call in the batch still counts as a step", async () => {
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.batch(["read a.ts", "read b.ts"]);
    progress.step("read a.ts");
    progress.step("read b.ts");
    progress.step("exec make");
    await settle();
    await progress.finish("ok");

    expect(shown(it)).toContain("3 steps");
  });

  test("the call after the batch is drawn again", async () => {
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.batch(["read a.ts", "read b.ts"]);
    progress.step("read a.ts");
    progress.step("read b.ts");
    progress.step("exec make test");
    await settle();

    expect(shown(it)).toContain("exec make test");
  });
});

describe("notes", () => {
  const shown = (it: ReturnType<typeof fakeGateway>) => it.edits.at(-1) ?? it.sent.at(-1)?.text ?? "";

  test("compaction is shown with its own mark while it runs", async () => {
    // A turn summarizing a long conversation used to look exactly like a turn that had hung.
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.note("compacting the conversation — summarizing 12 earlier turn(s), ~130.0k tokens");
    await settle();

    expect(shown(it)).toContain("🗜️ compacting the conversation");
  });

  test("context upkeep is not shown in the chat; a provider retry still is", async () => {
    // Owner (2026-10-21): compaction, cleared tool results and spilled outputs are the daemon's business. They still
    // run and the turn record keeps them; the person waiting is not told.
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.step("read a.ts");
    progress.show("compact", "compacting the conversation — summarizing 12 earlier turn(s), ~130.0k tokens");
    progress.show("compact", "context full — cleared 4 earlier tool result(s) to make room");
    progress.show("note", "exec output was 16KB — kept an excerpt, wrote the rest to a file");
    progress.show("retry", "the model's context overflowed — retrying without 3 earlier message(s)");
    await settle();
    expect(shown(it)).not.toContain("🗜️");
    expect(shown(it)).not.toContain("context full");
    expect(shown(it)).not.toContain("kept an excerpt");
    expect(shown(it)).not.toContain("overflowed");

    progress.show("retry", "the provider is rate-limiting — asking again in 2s (attempt 2 of 6)");
    await settle();
    expect(shown(it)).toContain("asking again in 2s");
  });

  test("a nudge the turn read is the record's, not the chat's (0.7.26)", async () => {
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.step("read a.ts");
    progress.show("note", nudgeRead("[harness] This reply has run 5 min. Send the person a one-line status."));
    await settle();
    expect(shown(it)).not.toContain("nudge");
    expect(shown(it)).toContain("read a.ts");
  });

  test("a note is not a step", async () => {
    const it = fakeGateway();
    const progress = progressOn(it.gateway);

    progress.step("read a.ts");
    progress.note("compacted: 12 earlier turn(s) summarized, now ~8.0k tokens");
    await settle();
    await progress.finish("ok");

    expect(shown(it)).toContain("1 step ");
  });
});

describe("a gateway that fails", () => {
  /**
   * The write runs on the throttle's timer. Out of a timer a throw is an uncaught exception, and the daemon shuts down
   * on one — over a status line; a rejection nothing caught is the other half. Bun fails the running test on either.
   */
  test("a send that throws costs that line only: the next step is still posted", async () => {
    const { gateway, sent } = fakeGateway();
    let refusals = 1;
    const flaky = {
      ...gateway,
      send: (msg: OutboundMessage) => {
        if (refusals > 0) {
          refusals -= 1;
          throw new Error("Telegram answered 502");
        }
        return gateway.send(msg);
      },
    } as unknown as Gateway;
    const progress = progressOn(flaky);

    progress.step("read a.md");
    await settle();
    progress.step("read b.md");
    await settle();

    expect(refusals).toBe(0);
    expect(sent.map((msg) => msg.text)).toEqual(["⏳ 📖 read b.md"]);
  });
});

describe("the model at work after its steps (0.8.7)", () => {
  // A person's bubble read `✓ 1 step · 166s` for a turn whose one step took 18 s: the other 148 s the model wrote a long
  // reply, and nothing showed it — to a person waiting, a hang.
  const quietOn = (gateway: Gateway) => new ChatProgress({ gateway, chatId: "chat-1", agentLabel: "nix", minIntervalMs: 0, quietTickMs: 40 });
  const lastIs = (edits: string[], line: RegExp) => eventually(() => line.test(edits.at(-1) ?? ""), 2_000, `the bubble to read ${line}`);
  /** The same, while the reply keeps arriving: a piece of it each time the bubble is looked at. */
  const whileWriting = (progress: ChatProgress, edits: string[], line: RegExp) =>
    eventually(() => (progress.wrote(), line.test(edits.at(-1) ?? "")), 2_000, `the bubble to read ${line} while the reply is written`);

  test("is said on the bubble once it has gone on for a tick, thinking and then writing, with how long", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "ask_agent nouva", { like: "ask_agent" });
    await settle();
    progress.show("tool_done", "ask_agent ok · 18000ms");
    await lastIs(edits, /^\[nix\] ⏳ 💭 thinking… \d+s$/);
    await whileWriting(progress, edits, /^\[nix\] ⏳ ✍️ writing a reply… \d+s$/);
    await progress.finish("ok");
    expect(sent).toHaveLength(1);
    expect(edits.at(-1)).toMatch(/^\[nix\] ✓ 1 step · \d+s$/);
  });

  test("once what the model writes is a call, it is preparing the next step, whatever words came first", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "exec gh api repos", { like: "exec" });
    await settle();
    progress.show("tool_done", "exec ok · 3000ms");
    // A line of its own first, which reads as a reply being written.
    await whileWriting(progress, edits, /^\[nix\] ⏳ ✍️ writing a reply… \d+s$/);
    // Then a long command to run: no reply is being written, and the bubble stops saying one is.
    progress.calling();
    await lastIs(edits, /^\[nix\] ⏳ 🛠️ preparing the next step… \d+s$/);
    progress.wrote();
    await lastIs(edits, /preparing the next step/);
    // The step runs and ends: the model at work again starts from thinking, not from the call before.
    progress.show("tool", "exec python3 chart.py", { like: "exec" });
    await settle();
    progress.show("tool_done", "exec ok · 3000ms");
    await lastIs(edits, /^\[nix\] ⏳ 💭 thinking… \d+s$/);
    await progress.finish("ok");
    expect(edits.at(-1)).toMatch(/^\[nix\] ✓ 2 steps · \d+s$/);
  });

  test("a few words and then silence is thinking again: no reply is being written", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "exec gh api repos", { like: "exec" });
    await settle();
    progress.show("tool_done", "exec ok · 3000ms");
    await whileWriting(progress, edits, /writing a reply/);
    // Nothing more arrives: the model composes a call it will send whole. The bubble stops saying a reply is written.
    await lastIs(edits, /^\[nix\] ⏳ 💭 thinking… \d+s$/);
    await progress.finish("ok");
  });

  test("says nothing more once the answer is going out, and the bubble closes on its count", async () => {
    const { gateway, sent, edits } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "exec ls", { like: "exec" });
    await settle();
    progress.show("tool_done", "exec ok · 10ms");
    await lastIs(edits, /thinking/);
    await progress.beforeAnswer("ok");
    // A last piece of it, written as it goes out: the bubble above the answer is not edited for it.
    progress.wrote();
    const answering = edits.length;
    // Fixed: what is shown is that no tick drew a line — a couple of ticks' time, and no state to wait on.
    await sleep(100);
    expect(edits).toHaveLength(answering);
    await progress.finish("ok");
    expect(sent).toHaveLength(1);
    expect(edits.at(-1)).toMatch(/^\[nix\] ✓ 1 step · \d+s$/);
  });

  test("is not said between steps that follow within a tick, nor while a call still runs", async () => {
    const { gateway, edits } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "exec npm test", { like: "exec" });
    progress.show("tool", "read a.md", { like: "read" });
    progress.show("tool_done", "exec ok · 10ms");
    // Fixed, both: a tick's time passing with no line drawn is the thing shown.
    await sleep(70);
    progress.show("tool_done", "read ok · 10ms");
    progress.show("tool", "read b.md", { like: "read" });
    await sleep(70);
    expect(edits.some((text) => text.includes("thinking") || text.includes("writing"))).toBe(false);
    await progress.finish("ok");
  });

  test("is never a bubble of its own: after a wait sealed the steps' bubble, nothing is posted until the next step", async () => {
    const { gateway, sent } = fakeGateway();
    const progress = quietOn(gateway);
    progress.show("tool", "exec git push", { like: "exec" });
    await progress.seal("waiting for you");
    // Approved: the call runs below the question and ends, and the model writes on.
    progress.show("tool_done", "exec ok · 10ms");
    progress.wrote();
    // Fixed: a couple of ticks, and nothing posted.
    await sleep(100);
    expect(sent.map((msg) => msg.text.replace(/ · \d+s/, ""))).toEqual(["[nix] ⏸ 1 step (waiting for you)"]);
    await progress.finish("ok");
  });

  test("is not said where a platform asked for one closing line", async () => {
    const { gateway, sent } = summaryRecorder();
    const progress = quietOn(gateway);
    progress.show("tool", "exec ls", { like: "exec" });
    progress.show("tool_done", "exec ok · 10ms");
    // Fixed: a couple of ticks, and nothing posted.
    await sleep(100);
    expect(sent).toEqual([]);
    await progress.finish("ok");
    expect(sent.map((msg) => msg.text.replace(/ · \d+s$/, ""))).toEqual(["[nix] ✓ 1 step"]);
  });
});
