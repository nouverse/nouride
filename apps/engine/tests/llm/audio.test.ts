/**
 * Voice notes at the wire, and a model that refuses one.
 *
 * Two properties. Only the current turn's clips are sent — a minute of speech is thousands of tokens,
 * and re-sending last Tuesday's voice note on every later turn would be the base64-in-the-transcript
 * mistake `images.ts` exists to avoid, paid in tokens instead of disk. And a refusal is survived:
 * the turn is answered, without the clip, saying it could not be heard.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMError, type AudioRefPart, type ChatMessage, type ChatParams, type ContentPart, type LLMProvider } from "@nouride/shared";
import { resolveAudio, withoutAudio } from "@/modules/llm/audio.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function clip(ref: string): AudioRefPart {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "audio-"));
  const localPath = join(dir, `${ref}.ogg`);
  writeFileSync(localPath, new Uint8Array([79, 103, 103, 83]));
  return { type: "audio_ref", ref, localPath, format: "ogg", durationSec: 3 };
}

const said = (text: string, audio: AudioRefPart): ChatMessage => ({
  role: "user",
  content: [{ type: "text", text }, audio],
});
const parts = (message: ChatMessage): ContentPart[] => (typeof message.content === "string" ? [] : message.content);

describe("resolveAudio", () => {
  test("this turn's clip is sent as sound; an answered one becomes a line naming its ref", async () => {
    const history: ChatMessage[] = [
      said("earlier", clip("old")),
      { role: "assistant", content: "I heard you." },
      said("now", clip("new")),
    ];
    const out = await resolveAudio(history);

    expect(parts(out[2]!).some((part) => part.type === "audio")).toBe(true);
    const earlier = parts(out[0]!);
    expect(earlier.some((part) => part.type === "audio")).toBe(false);
    expect(earlier.some((part) => part.type === "text" && part.text.includes("ref old"))).toBe(true);
    // The session's own messages are never rewritten in place: that would put base64 in the database.
    expect(parts(history[2]!).some((part) => part.type === "audio_ref")).toBe(true);
  });

  test("a clip opened again by a tool, mid-turn, is still this turn's", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "what did I say yesterday?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "attachment_read", arguments: {} }] },
      { role: "tool", content: "Opened it.", toolCallId: "c1" },
      said("[opened]", clip("reopened")),
    ];
    const out = await resolveAudio(history);
    expect(parts(out[3]!).some((part) => part.type === "audio")).toBe(true);
  });

  test("a clip whose file is gone becomes a line saying it was not heard", async () => {
    const gone: AudioRefPart = { type: "audio_ref", ref: "gone", localPath: "/nowhere/gone.ogg", format: "ogg" };
    const out = await resolveAudio([said("now", gone)]);
    const line = parts(out[0]!).find((part) => part.type === "text" && part.text.includes("could not be read back"));
    expect(line).toBeDefined();
  });

  test("one request carries three clips at most — the newest — and the rest are named, not dropped", async () => {
    // Nothing tested the cap: raising it, or deleting it, left this file green.
    const out = await resolveAudio([said("one", clip("c1")), said("two", clip("c2")), said("three", clip("c3")), said("four", clip("c4"))]);
    const sound = out.map((message) => parts(message).some((part) => part.type === "audio"));
    expect(sound).toEqual([false, true, true, true]);
    expect(parts(out[0]!).some((part) => part.type === "text" && part.text.includes("ref c1"))).toBe(true);
  });

  test("a clip that would take the request past its audio budget is not sent, and says it was not heard", async () => {
    // 20 MB of base64 per request: two 9 MB notes are 24 MB as base64, so the older one does not fit.
    // Sparse files — the size is read from the directory entry before any byte is.
    const big = (ref: string) => {
      const part = clip(ref);
      truncateSync(part.localPath, 9 * 1024 * 1024);
      return part;
    };
    const out = await resolveAudio([said("first", big("b1")), said("second", big("b2"))]);
    expect(parts(out[1]!).some((part) => part.type === "audio")).toBe(true);
    expect(parts(out[0]!).some((part) => part.type === "audio")).toBe(false);
    expect(parts(out[0]!).some((part) => part.type === "text" && part.text.includes("could not be read back"))).toBe(true);
  });

  test("withoutAudio leaves an instruction where the clip was, not a silence", () => {
    const out = withoutAudio([said("now", clip("x"))]);
    const texts = parts(out[0]!).filter((part) => part.type === "text").map((part) => (part as { text: string }).text);
    expect(texts.some((text) => text.includes("you have not heard it") && text.includes("Do not guess"))).toBe(true);
    expect(parts(out[0]!).some((part) => part.type === "audio" || part.type === "audio_ref")).toBe(false);
  });
});

describe("a model that refuses a voice note", () => {
  function refusing() {
    const seen: ChatParams[] = [];
    const provider = {
      async chat(params: ChatParams) {
        seen.push(params);
        const hasAudio = params.messages.some((m) => typeof m.content !== "string" && m.content.some((p) => p.type === "audio"));
        if (hasAudio) {
          throw new LLMError("input_audio is not supported by the claudecode provider", 400, {
            failure: { class: "media_unsupported", action: "degrade", alertOperator: false, operatorHint: "" },
          });
        }
        return { text: "I could not listen to that — could you type it?", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" };
      },
    } as unknown as LLMProvider;
    return { provider, seen };
  }

  const run = (provider: LLMProvider, onAudioRefused: () => void, content: ChatMessage["content"]) =>
    new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
      onAudioRefused,
    }).run({
      agent: fakeAgent(),
      provider,
      toolset: { definitions: [], tools: new Map() } as never,
      history: [],
      userMessage: { role: "user", content, timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

  test("the turn is answered once more without the clip, and the route is recorded", async () => {
    const { provider, seen } = refusing();
    let refused = 0;
    const result = await run(provider, () => (refused += 1), [{ type: "text", text: "listen" }, clip("n")]);

    expect(result.text).toContain("could not listen");
    expect(refused).toBe(1);
    expect(seen).toHaveLength(2);
    const retried = seen[1]!.messages.at(-1)!;
    expect(parts(retried).some((part) => part.type === "audio")).toBe(false);
    expect(parts(retried).some((part) => part.type === "text" && part.text.includes("not sent"))).toBe(true);
  });

  test("the same refusal on a request with no audio is not retried", async () => {
    const provider = {
      async chat() {
        throw new LLMError("unsupported_content_part", 400, {
          failure: { class: "media_unsupported", action: "degrade", alertOperator: false, operatorHint: "" },
        });
      },
    } as unknown as LLMProvider;
    let refused = 0;
    await expect(run(provider, () => (refused += 1), "no audio here")).rejects.toThrow("unsupported_content_part");
    expect(refused).toBe(0);
  });
});
