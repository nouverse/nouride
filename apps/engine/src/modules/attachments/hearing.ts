/**
 * Can the model this turn goes to hear a voice note — and in what encoding?
 *
 * ## Why this is asked before anything is sent
 *
 * A clip that does not reach the model is not a failure anyone sees. Nougate's mappers dropped
 * `input_audio` without a word on almost every route, so the model
 * got the text around the voice note and answered it fluently — about a message it never heard. An
 * instruction saying "if there is no audio, say so" does not survive that: it arrives without the
 * audio it is about, and a model that has been told there is a voice note tends to describe one.
 *
 * So audio goes only where hearing has been **declared**, and everywhere else the agent is told,
 * before it answers, that it cannot listen. Declared by whom, first answer wins:
 *
 * 1. `read_audio = false` — nobody.
 * 2. The wire format. Anthropic's Messages API has no audio block at all.
 * 3. A refusal this daemon already met for this profile and model, for a week — so a turn is not
 *    sent into the same wall again.
 * 4. The gateway's `/models` listing, when it says anything about modalities — Nougate does, per
 *    route, because the mapper that serves a model is what decides whether audio survives.
 * 5. `audio_input = "always"` — the operator vouches for a provider that hears and does not say.
 * 6. Otherwise: cannot. A gateway that says nothing is indistinguishable from one that drops audio.
 *
 * A listing that explicitly leaves `audio` out wins over `always`: the gateway knows its own mappers,
 * and the operator setting is for providers that are silent, not for overruling one that answered.
 */

import { wireCapabilities, type ListedModel as LlmListedModel } from "@nouride/llm";
import { createLogger, type AudioFormat } from "@nouride/shared";
import { ModelCatalog } from "@/modules/llm/catalog.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";

const log = createLogger("attachments.hearing");

/** How long a refusal is remembered. A week, then the route is given another chance. */
const REJECTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The two formats every `input_audio` endpoint takes. What `always` sends. */
const UNIVERSAL_FORMATS: AudioFormat[] = ["mp3", "wav"];
const KNOWN_FORMATS = new Set<AudioFormat>(["mp3", "wav", "ogg"]);

/**
 * Why a model will not be sent audio. Each is a different fix, and the operator alert names it.
 *
 * - `off` — `read_audio = false`.
 * - `wire_no_audio` — an Anthropic-format profile.
 * - `declared_deaf` — the gateway listed this model and audio was not among its inputs.
 * - `not_advertised` — nothing said it hears.
 * - `rejected` — it was sent audio before and refused it.
 * - `listing_unavailable` — the gateway's listing could not be read just now.
 */
export type DeafReason =
  | "off"
  | "wire_no_audio"
  | "declared_deaf"
  | "not_advertised"
  | "rejected"
  | "listing_unavailable";

export type Hearing =
  | { hears: true; formats: AudioFormat[] }
  | { hears: false; reason: DeafReason };

/** One model's entry in a listing, reduced to what hearing needs. `null` fields were not stated. */
interface ListedModel {
  modalities: string[] | null;
  formats: AudioFormat[] | null;
}

export interface HearingDeps {
  providers: Pick<ProviderRegistry, "endpointFor">;
  media: { readAudio: boolean; audioInput: "auto" | "always" };
  /** The daemon's listings (`ProviderRegistry.catalog`), shared with the context window. One of its own when absent. */
  catalog?: Pick<ModelCatalog, "listing">;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class HearingCheck {
  private readonly rejections = new Map<string, number>();
  private readonly catalog: Pick<ModelCatalog, "listing">;

  constructor(private readonly deps: HearingDeps) {
    this.catalog =
      deps.catalog ??
      new ModelCatalog({
        endpointFor: (profile) => deps.providers.endpointFor(profile),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
  }

  async check(profile: string, model: string): Promise<Hearing> {
    if (!this.deps.media.readAudio) return { hears: false, reason: "off" };

    const endpoint = this.endpoint(profile);
    if (!endpoint) return { hears: false, reason: "not_advertised" };
    // The format itself has no audio part — what it can carry is `@nouride/llm`'s to say, not a kind compared here.
    if (!wireCapabilities(endpoint.kind).audioInput) return { hears: false, reason: "wire_no_audio" };

    const rejectedAt = this.rejections.get(key(profile, model));
    if (rejectedAt !== undefined && this.now() - rejectedAt < REJECTION_TTL_MS) {
      return { hears: false, reason: "rejected" };
    }

    const vouched = this.deps.media.audioInput === "always";
    const listed = await this.catalog.listing(profile);
    const listing = listed ? reduce(listed) : null;
    if (listing === null) {
      return vouched ? { hears: true, formats: UNIVERSAL_FORMATS } : { hears: false, reason: "listing_unavailable" };
    }

    const entry = entryFor(listing, model);
    if (entry?.modalities) {
      if (!entry.modalities.includes("audio")) return { hears: false, reason: "declared_deaf" };
      return { hears: true, formats: entry.formats?.length ? entry.formats : UNIVERSAL_FORMATS };
    }
    return vouched ? { hears: true, formats: UNIVERSAL_FORMATS } : { hears: false, reason: "not_advertised" };
  }

  /** A route refused audio. Remembered so the next voice note is not sent into the same wall. */
  recordRejection(profile: string, model: string): void {
    this.rejections.set(key(profile, model), this.now());
    log.warn("a model refused audio; treating it as unable to hear for a week", { profile, model });
  }

  private endpoint(profile: string): ReturnType<HearingDeps["providers"]["endpointFor"]> | null {
    try {
      return this.deps.providers.endpointFor(profile);
    } catch {
      // A missing profile or credential fails the turn elsewhere, with a better message than this
      // path could give. Here it only means nothing can vouch for hearing.
      return null;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

/**
 * The listing's answer for the model an agent names — which may be unprefixed.
 *
 * Nougate lists `antigravity:gemini-3.8-flash`, and an agent config may say `gemini-3.8-flash`: the
 * gateway accepts a bare id and routes it to whichever provider serves it. Seen live — the exact-match
 * lookup found nothing for the bare name, so a model that hears was reported as one that says nothing.
 *
 * A bare id can reach more than one provider, and which one answers is the gateway's choice, not ours.
 * So it hears only if **every** route it could take hears, in the formats they all take — one route
 * that cannot carry audio is a voice note that may be dropped or refused, depending on the day.
 */
function entryFor(listing: Map<string, ListedModel>, model: string): ListedModel | undefined {
  const exact = listing.get(model);
  if (exact || model.includes(":")) return exact;

  const routes = [...new Set([...listing.entries()].filter(([id]) => id.endsWith(`:${model}`)).map(([, entry]) => entry))];
  if (routes.length === 0) return undefined;
  if (routes.some((route) => route.modalities === null)) return { modalities: null, formats: null };
  if (routes.some((route) => !route.modalities!.includes("audio"))) return { modalities: ["text"], formats: null };
  const formats = routes
    .map((route) => route.formats ?? UNIVERSAL_FORMATS)
    .reduce((shared, next) => shared.filter((format) => next.includes(format)));
  return { modalities: ["text", "audio"], formats };
}

function key(profile: string, model: string): string {
  return `${profile}\u0000${model}`;
}

/**
 * The listing, reduced to what hearing needs.
 *
 * A field that is absent stays `null`, which is different from an empty list: absent is a gateway that says nothing,
 * empty is one that said "no".
 */
function reduce(models: ReadonlyMap<string, LlmListedModel>): Map<string, ListedModel> {
  const out = new Map<string, ListedModel>();
  for (const [name, model] of models) {
    out.set(name, {
      modalities: model.inputModalities ?? null,
      formats: model.inputAudioFormats ? model.inputAudioFormats.filter((f): f is AudioFormat => KNOWN_FORMATS.has(f as AudioFormat)) : null,
    });
  }
  return out;
}
