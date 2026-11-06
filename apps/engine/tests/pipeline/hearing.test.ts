/**
 * Who gets sent a voice note.
 *
 * The rule under test is the conservative one: audio goes only where hearing was *declared*. A
 * gateway that says nothing looks exactly like one that drops audio silently — Nougate did, on almost
 * every route — and the price of guessing wrong is an invented answer to a message nobody heard.
 */

import { describe, expect, test } from "bun:test";
import { HearingCheck } from "@/modules/attachments/hearing.ts";

type Listing = { id: string; input_modalities?: string[]; input_audio_formats?: string[] }[];

function check(options: {
  kind?: "openai" | "anthropic";
  listing?: Listing | "down";
  audioInput?: "auto" | "always";
  readAudio?: boolean;
  now?: () => number;
}) {
  const calls = { listing: 0 };
  const hearing = new HearingCheck({
    providers: {
      endpointFor: () => ({ kind: options.kind ?? "openai", baseUrl: "https://gw.invalid/v1/", apiKey: "k" }),
    },
    media: { readAudio: options.readAudio ?? true, audioInput: options.audioInput ?? "auto" },
    fetchImpl: (async (url: string) => {
      calls.listing += 1;
      expect(url).toBe("https://gw.invalid/v1/models");
      if (options.listing === "down" || options.listing === undefined) return new Response("no", { status: 502 });
      return new Response(JSON.stringify({ data: options.listing }), { status: 200 });
    }) as unknown as typeof fetch,
    ...(options.now ? { now: options.now } : {}),
  });
  return { hearing, calls };
}

const gemini = { id: "antigravity:gemini-flash", input_modalities: ["text", "image", "audio"], input_audio_formats: ["mp3", "wav", "ogg"] };

describe("hearing", () => {
  test("a model the gateway lists as hearing hears, in the formats it lists", async () => {
    const { hearing } = check({ listing: [gemini] });
    expect(await hearing.check("nougate", "antigravity:gemini-flash")).toEqual({
      hears: true,
      formats: ["mp3", "wav", "ogg"],
    });
  });

  test("a model the gateway says nothing about does not — even though it might", async () => {
    const { hearing } = check({ listing: [{ id: "custom:whatever" }] });
    expect(await hearing.check("p", "custom:whatever")).toEqual({ hears: false, reason: "not_advertised" });
  });

  test("the operator can vouch for a silent provider, and it gets the formats every endpoint takes", async () => {
    const { hearing } = check({ listing: [{ id: "custom:whatever" }], audioInput: "always" });
    expect(await hearing.check("p", "custom:whatever")).toEqual({ hears: true, formats: ["mp3", "wav"] });
  });

  test("vouching does not overrule a gateway that listed the model and left audio out", async () => {
    // The gateway knows its own mappers. `always` is for providers that are silent, not for arguing
    // with one that answered.
    const { hearing } = check({
      listing: [{ id: "claudecode:sonnet", input_modalities: ["text", "image"] }],
      audioInput: "always",
    });
    expect(await hearing.check("p", "claudecode:sonnet")).toEqual({ hears: false, reason: "declared_deaf" });
  });

  test("an Anthropic-format profile never hears, and the gateway is not even asked", async () => {
    const { hearing, calls } = check({ kind: "anthropic", listing: [gemini], audioInput: "always" });
    expect(await hearing.check("p", "antigravity:gemini-flash")).toEqual({ hears: false, reason: "wire_no_audio" });
    expect(calls.listing).toBe(0);
  });

  test("read_audio = false wins over everything", async () => {
    const { hearing } = check({ listing: [gemini], readAudio: false });
    expect(await hearing.check("p", "antigravity:gemini-flash")).toEqual({ hears: false, reason: "off" });
  });

  test("a listing that cannot be read is not a yes — unless the operator vouched", async () => {
    const { hearing } = check({ listing: "down" });
    expect(await hearing.check("p", "antigravity:gemini-flash")).toEqual({ hears: false, reason: "listing_unavailable" });
    // A provider with no listing at all is the silent provider `always` exists for.
    const vouched = check({ listing: "down", audioInput: "always" });
    expect(await vouched.hearing.check("p", "antigravity:gemini-flash")).toEqual({ hears: true, formats: ["mp3", "wav"] });
  });

  test("the listing is read once, not per voice note", async () => {
    const { hearing, calls } = check({ listing: [gemini] });
    await hearing.check("p", "antigravity:gemini-flash");
    await hearing.check("p", "antigravity:gemini-flash");
    await hearing.check("p", "antigravity:gemini-flash");
    expect(calls.listing).toBe(1);
  });

  test("a refusal sticks for a week, then the route is tried again", async () => {
    let now = 0;
    const { hearing } = check({ listing: [gemini], now: () => now });
    hearing.recordRejection("p", "antigravity:gemini-flash");
    expect(await hearing.check("p", "antigravity:gemini-flash")).toEqual({ hears: false, reason: "rejected" });
    // Only that model: another one on the same profile is unaffected.
    now = 8 * 24 * 60 * 60 * 1000;
    expect((await hearing.check("p", "antigravity:gemini-flash")).hears).toBe(true);
  });

  test("a bare model name is matched to the gateway's prefixed one", async () => {
    // Seen live: the agent says `gemini-3.8-flash`, Nougate lists `antigravity:gemini-3.8-flash`.
    const { hearing } = check({ listing: [{ ...gemini, id: "antigravity:gemini-3.8-flash" }] });
    expect(await hearing.check("p", "gemini-3.8-flash")).toEqual({ hears: true, formats: ["mp3", "wav", "ogg"] });
  });

  test("a bare name that more than one provider serves hears only if they all do", async () => {
    const hears = { id: "antigravity:gemini-x", input_modalities: ["text", "audio"], input_audio_formats: ["mp3", "ogg"] };
    const alsoHears = { id: "custom:gemini-x", input_modalities: ["audio"], input_audio_formats: ["mp3"] };
    const deaf = { id: "copilot:gemini-x", input_modalities: ["text"] };
    const silent = { id: "other:gemini-x" };
    expect(await check({ listing: [hears, alsoHears] }).hearing.check("p", "gemini-x")).toEqual({ hears: true, formats: ["mp3"] });
    expect(await check({ listing: [hears, deaf] }).hearing.check("p", "gemini-x")).toEqual({ hears: false, reason: "declared_deaf" });
    expect(await check({ listing: [hears, silent] }).hearing.check("p", "gemini-x")).toEqual({ hears: false, reason: "not_advertised" });
  });

  test("a prefixed name is never widened to another provider's model", async () => {
    const { hearing } = check({ listing: [{ ...gemini, id: "antigravity:gemini-x" }] });
    expect(await hearing.check("p", "custom:gemini-x")).toEqual({ hears: false, reason: "not_advertised" });
  });
});
