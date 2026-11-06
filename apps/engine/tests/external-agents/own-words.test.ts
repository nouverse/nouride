/**
 * What a coding CLI says by itself, between turns (0.8.6): kept by session, its chat woken once a stretch, and followed
 * by the turn woken for it until the CLI has been quiet with no step open.
 */

import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@nouride/acp";
import { OwnWords, type OwnChat } from "@/modules/external-agents/own-words.ts";
import { UpdateReader } from "@/modules/external-agents/updates.ts";
import { sleep } from "../wait.ts";

const chat: OwnChat = { agentId: "nix", gatewayId: "telegram:nix", chatId: "555" };
const words = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const step = (id: string, status: "in_progress" | "completed"): SessionUpdate =>
  status === "in_progress" ? { sessionUpdate: "tool_call", toolCallId: id, title: "npm test", kind: "execute", status } : { sessionUpdate: "tool_call_update", toolCallId: id, status };
const reader = () => new UpdateReader({ text: () => {}, activity: () => {}, preamble: async () => false, plan: () => {} });

describe("what a CLI says by itself", () => {
  test("wakes its chat once a stretch, keeps it all in order, and a stretch after it is taken wakes again", () => {
    const woken: OwnChat[] = [];
    const own = new OwnWords((to) => void woken.push(to));
    own.answers("s1", chat);
    // What it sends that says nothing — its context's size, its commands — starts nothing.
    own.heard("s1", { sessionUpdate: "usage_update", used: 1, size: 10 });
    expect(woken).toEqual([]);
    own.heard("s1", step("t1", "in_progress"));
    own.heard("s1", step("t1", "completed"));
    own.heard("s1", words("Tests pass."));
    expect(woken).toEqual([chat]);
    expect(own.take("s1")).toEqual([step("t1", "in_progress"), step("t1", "completed"), words("Tests pass.")]);
    expect(own.take("s1")).toEqual([]);
    own.heard("s1", words("And the build."));
    expect(woken).toEqual([chat, chat]);
  });

  test("a session answering no chat of its agent's keeps its words, and wakes nothing", () => {
    const woken: OwnChat[] = [];
    const own = new OwnWords((to) => void woken.push(to));
    own.answers("s1", chat);
    own.answers("s1", null);
    own.heard("s1", words("Done."));
    expect(woken).toEqual([]);
    expect(own.take("s1")).toEqual([words("Done.")]);
  });

  test("is followed while a step is open, however quiet, and to the end of the quiet after it", async () => {
    const own = new OwnWords(() => {}, 40);
    own.answers("s1", chat);
    own.heard("s1", step("t1", "in_progress"));
    const read = reader();
    let ended = false;
    const following = own.follow("s1", read, { gone: () => false }).then(() => void (ended = true));
    // That it did not end is said only by waiting: past three of its quiet spells, with the step still open.
    await sleep(150);
    expect(ended).toBe(false);
    own.heard("s1", step("t1", "completed"));
    own.heard("s1", words("All green."));
    await following;
    expect(read.text).toBe("All green.");
    expect(read.steps).toEqual([{ name: "execute", ok: true }]);
  });

  test("ends at once on a stop, or once the CLI is gone, and is nothing where nothing was kept", async () => {
    const own = new OwnWords(() => {}, 40);
    own.answers("s1", chat);
    own.heard("s1", step("t1", "in_progress"));
    const stop = new AbortController();
    const stopped = own.follow("s1", reader(), { signal: stop.signal, gone: () => false });
    stop.abort();
    await stopped;
    own.heard("s1", step("t2", "in_progress"));
    let gone = false;
    const leaving = own.follow("s1", reader(), { gone: () => gone });
    gone = true;
    await leaving;
    const started = Date.now();
    await own.follow("s1", reader(), { gone: () => false });
    expect(Date.now() - started).toBeLessThan(30);
  });

  test("a session let go takes what it kept with it", () => {
    const woken: OwnChat[] = [];
    const own = new OwnWords((to) => void woken.push(to));
    own.answers("s1", chat);
    own.heard("s1", words("Done."));
    own.forget("s1");
    expect(own.take("s1")).toEqual([]);
    own.heard("s1", words("Again."));
    expect(woken).toHaveLength(1);
  });
});
