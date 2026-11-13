/**
 * A long call in the list of a turn's steps.
 *
 * Beside its result a shell line of six hundred characters was a column forty letters wide and a dozen lines tall,
 * broken in the middle of every word, with the result cut short in the half it had taken (measured: a row 233 px
 * high, its call 259 px wide). A long call has the row's whole width now, its result on the line above it, and one
 * past a few lines shows three of them until it is asked for. A short call is the one line it was.
 *
 * The widths and heights are a browser's to say and were measured there with the built stylesheet; this holds the
 * classes that measurement was taken with, and what the press does.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const LONG = `ssh mac 'export PATH=$PATH:$HOME/.local/bin; herdr pane run wB:p6 "clear; nginx -t 2>&1 | tail -3; journalctl -u certbot.timer --no-pager -n 5 2>&1 | cut -c1-150; certbot renew --dry-run > /tmp/nix-dry.log 2>&1; echo FIN_END; tail -n 25 /tmp/nix-dry.log | cut -c1-160"; for i in $(seq 1 40); do herdr pane read wB:p6 --lines 60; sleep 3; done' 2>&1 | tail -50`;
const MIDDLING = "git -C /opt/projects/nouride log --oneline -5 --format='%h %s' | cut -c1-90";
const SHORT = "read src/index.ts";

const call = (seq: number, text: string) => [
  { seq, at: 0, kind: "tool", text, callId: `c${seq}`, name: "exec", ms: 7_000 },
  { seq: seq + 1, at: 0, kind: "tool_done", text: "Bash ok: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", callId: `c${seq}`, name: "exec", ms: 40 },
];

async function rowsOf(press: boolean) {
  const live = WIRE["/sessions/ses_1/live"] as { turn: { steps: Record<string, unknown>[] } } & Record<string, unknown>;
  answer({ "/sessions/ses_1/live": { status: 200, body: { ...live, turn: { ...live.turn, steps: [...call(10, SHORT), ...call(20, MIDDLING), ...call(30, LONG)], cursor: 31 } } } });
  const seen: Record<string, { row: string; call: string; text: string; result: string; button: string | null; expanded: string | null }> = {};
  await renderPage("/chat/ses_1", async (host) => {
    const line = () => host.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
    const list = () => host.ownerDocument.getElementById(line()!.getAttribute("aria-controls")!)!;
    await eventually(() => line()?.textContent?.includes("3 steps") === true, 3_000, "the step line");
    line()!.click();
    await eventually(() => list().textContent?.includes(SHORT) === true, 2_000, "opened");
    const rowOf = (said: string) => [...list().querySelectorAll<HTMLElement>("div.rounded-lg")].find((row) => row.textContent?.includes(said.slice(0, 30)))!;
    const more = () => rowOf(LONG).querySelector<HTMLButtonElement>("button");
    if (press) {
      more()!.click();
      await eventually(() => more()?.getAttribute("aria-expanded") === "true", 2_000, "the whole call");
    }
    for (const [name, said] of [["short", SHORT], ["middling", MIDDLING], ["long", LONG]] as const) {
      const row = rowOf(said);
      const [, words, result] = [...row.children] as HTMLElement[];
      const button = row.querySelector("button");
      seen[name] = { row: row.className, call: words!.className, text: (words!.firstElementChild as HTMLElement | null)?.className ?? "", result: result!.className, button: button?.textContent ?? null, expanded: button?.getAttribute("aria-expanded") ?? null };
    }
  });
  return seen;
}

describe("a call in the list of steps", () => {
  test("a short one is one line with its result beside it, as it was: nothing to press", async () => {
    const { short } = await rowsOf(false);
    expect(short!.row).toContain("sm:flex-nowrap");
    expect(short!.call).toContain("break-all");
    expect(short!.call).not.toContain(" order-last");
    expect(short!.result).toContain("sm:max-w-[45%]");
    expect(short!.button).toBeNull();
  });

  test("a long one has the whole row under its result, at every width, and breaks at its spaces", async () => {
    const { middling, long } = await rowsOf(false);
    for (const row of [middling!, long!]) {
      expect(row.row).not.toContain("sm:flex-nowrap");
      expect(row.call).toContain(" order-last basis-full");
      expect(row.call).toContain("[overflow-wrap:anywhere]");
      expect(row.call).not.toContain("break-all");
      // The result has the line the call left, no longer a share of it.
      expect(row.result).toContain("flex-1");
      expect(row.result).not.toContain("max-w-[45%]");
    }
    // Long, and still short enough to show whole.
    expect(middling!.button).toBeNull();
    expect(middling!.text).not.toContain("line-clamp-3");
  });

  test("a very long one shows three lines and a press shows it whole; another folds it", async () => {
    const folded = (await rowsOf(false)).long!;
    expect(folded.text).toContain("line-clamp-3");
    expect(folded).toMatchObject({ button: "Show all", expanded: "false" });
    const opened = (await rowsOf(true)).long!;
    expect(opened.text).not.toContain("line-clamp-3");
    expect(opened).toMatchObject({ button: "Show less", expanded: "true" });
  });
});
