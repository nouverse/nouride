/**
 * Who said each line the model reads in a group (`speakerName`): the `[[people]]` name for a known person, on every
 * account they write from, and the platform's name for anyone else — the room's lines and the question alike.
 *
 * Live: a second account showing as `~` asked "ini kenapa?" right under the operator's line, unnamed, and the agent
 * answered the operator by name.
 */

import { afterEach, expect, test } from "bun:test";
import { conversationOf, envelope as envelopeAt } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const AT = Date.now() - 60_000;
const said = (id: string, text: string, at: number, extra: Parameters<typeof envelopeAt>[0] = {}) =>
  envelopeAt({ id, text, chatType: "group", chatId: "group-1", timestamp: at, ...extra });

test("a known person is called by their [[people]] name on every account, in the question and the room alike", async () => {
  const b = await pipelineBench({
    turns: [{ text: "ok" }, { text: "ok" }],
    config: {
      agents: { groups_require_mention: true },
      people: [
        { key: "mira", name: "Kak Mira", ids: ["telegram:mira-1", "telegram:mira-2"] },
        { key: "gading", name: "Gading", ids: ["telegram:gading-1"] },
      ],
    },
  });
  cleanup.push(b.dispose);
  b.pipeline.attach();
  const question = (index: number) => (conversationOf(b.requests[index]?.messages ?? []).at(-1)?.content as string) ?? "";

  b.gateway.receive(said("c1", "jemput yaaa", AT + 1_000, { senderId: "mira-1", senderName: "mira" }));
  b.gateway.receive(said("c2", "https://example.com/invite", AT + 2_000, { senderId: "gading-1", senderName: "Gading Nasution" }));
  b.gateway.receive(said("c3", "siapa ya", AT + 2_500, { senderId: "stranger", senderName: "Jordan" }));
  await b.pipeline.idle();
  b.gateway.receive(said("t1", "ini kenapa?", AT + 3_000, { senderId: "mira-2", senderName: "~", mentions: ["nouva"] }));
  await b.pipeline.idle();

  const sent = question(0);
  expect(sent).toContain("Kak Mira: jemput yaaa");
  expect(sent).toContain("Gading: https://example.com/invite");
  // Not in `[[people]]`: what the platform calls them.
  expect(sent).toContain("Jordan: siapa ya");
  expect(sent).toMatch(/\n\nKak Mira: ini kenapa\?/);
  expect(sent).not.toContain("~:");
  expect(sent).not.toContain("Gading Nasution");

  // A DM has one person in it: their words as they wrote them.
  b.gateway.receive(envelopeAt({ id: "d1", text: "halo", timestamp: Date.now(), senderId: "mira-2", senderName: "~" }));
  await b.pipeline.idle();
  expect(question(1)).toMatch(/^halo\n\n\(Sent [^)]+\)$/);
});
