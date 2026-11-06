/**
 * Asking a vision model what an image contains.
 *
 * One resolution of *which* model and *whether at all*, shared by the two things that look at an
 * image: the intake, which reads a file that came with the message it is answering, and
 * `attachment_read`, which reads one somebody asked about later. They were the same six lines twice
 * — and the copy would have drifted at the first config change, so a screenshot would have been
 * readable in one path and refused in the other with no way to tell why.
 *
 * A separate request whose output is text, which then enters the conversation as text — openclaw's
 * shape, and the reason `ChatMessage.content` can stay a plain string.
 */

import { createLogger, helperModel, looksLikeHtml, sniffImageMime, type InstallTiers, type MediaSection } from "@nouride/shared";
import { describeImage, isSupportedImageType } from "@nouride/llm";
import type { AgentRegistry } from "@nouride/persona";
import { toBase64 } from "@/modules/llm/images.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";

const log = createLogger("attachments.vision");

/**
 * Shaped so the pipeline's own deps satisfy it structurally — `config` rather than a lifted `media`.
 *
 * Deliberate: both callers already hold the whole config object and lifting one section out at each
 * call site is three places to get it wrong for no gain in what this function can reach.
 */
export interface VisionDeps {
  /** `llm.defaults`, for an `image_model` that names a tier — absent, a tier is the agent's own (a test's config). */
  config: { media: MediaSection; llm?: { defaults: InstallTiers } };
  registry: AgentRegistry;
  providers: ProviderRegistry;
  /** Where each look is metered, `purpose: "vision"` — up to 8,192 tokens of description, metered by nobody before. */
  usage?: Pick<UsagePort, "record">;
}

/**
 * Either a description or a reason there is none — never a throw, and never an empty string.
 *
 * Every failure is phrased for the model, because "I could not read your screenshot" is useful and
 * silence is not. The `error` wording is what an agent repeats to the person who sent the file, so it
 * has to be true and specific: the usual cause is a model that is not multimodal, and naming it
 * turns a mystery into a config change.
 */
export type VisionResult = { description: string } | { error: string };

/**
 * Why this image cannot be looked at, or null when it can.
 *
 * Split out rather than inlined so the three refusals read as one list — they are the same question
 * asked three ways, and the wording of each is what an agent repeats to the person who sent the file.
 */
function visionRefusal(
  deps: VisionDeps,
  input: { mimeType: string; size?: number },
): string | null {
  if (!deps.config.media.readImages) return "image reading is switched off in this daemon's config";
  if (!isSupportedImageType(input.mimeType)) return `${input.mimeType} is not a readable image type`;
  if ((input.size ?? 0) > deps.config.media.maxImageBytes) return "too large to send to a vision model";
  return null;
}

/**
 * Look at one image on one agent's behalf.
 *
 * `prompt` is the question, when there is one. Left empty by the intake — which has no question yet,
 * only a file — and set by `attachment_read`, where somebody asked something specific and a general
 * description would be a worse answer than the one they wanted.
 */
export async function readImage(
  deps: VisionDeps,
  input: {
    agentId: string;
    bytes: Uint8Array;
    mimeType: string;
    size?: number;
    prompt?: string;
    /** The turn that asked, when one did — `attachment_read`. */
    turnId?: string;
  },
): Promise<VisionResult> {
  /**
   * What the bytes are, not what the file claims to be.
   *
   * The claim comes from a filename extension or a `content-type` header, and both can be wrong in
   * the same direction: an agent asked for a photo fetched a URL ending in `.jpg`, got a Cloudflare
   * "Just a moment..." page, and sent 5KB of HTML as `image/jpeg`. The provider answered
   * `400 Unable to process input image`, and the agent reported that *its vision model* could not see
   * the picture — the one explanation that was not true, and the one that sent everybody looking at
   * the model instead of at the file.
   *
   * So the HTML case is named outright, and a real image whose extension lies is silently corrected:
   * a PNG called `.jpg` is a working image and only the label is wrong.
   */
  if (looksLikeHtml(input.bytes)) {
    return {
      error:
        `this file is an HTML page (${input.bytes.byteLength} bytes), not an image. Whatever ` +
        `downloaded it saved a web page instead of a picture, which is what a Cloudflare check or a ` +
        `login wall returns. Say so, and try a different source rather than blaming the vision model`,
    };
  }
  const mimeType = sniffImageMime(input.bytes) ?? input.mimeType;

  const refusal = visionRefusal(deps, { mimeType, size: input.size ?? input.bytes.byteLength });
  if (refusal) return { error: refusal };

  const agent = deps.registry.get(input.agentId);
  if (!agent) return { error: "this agent is no longer loaded" };

  // Empty `image_model` means the agent's own model, which is the point of the default: a multimodal
  // conversation model reads images with no configuration at all, and an operator who wants a cheaper
  // one for this job names it — or names a tier, `small`, which is each agent's own cheaper model (0.8.0).
  const model = helperModel(deps.config.media.imageModel, agent.config.llm, deps.config.llm?.defaults ?? { provider: "" }) || agent.config.llm.model;

  try {
    const profile = agent.config.llm.provider;
    const described = await describeImage({
      provider: metered(deps.providers.get(profile), meter(deps.usage, { agentId: input.agentId, provider: profile, purpose: "vision", ...(input.turnId ? { turnId: input.turnId } : {}) })),
      model,
      // The sniffed type, so a JPEG named `.png` reaches the provider labelled as what it is.
      image: { type: "image", mimeType, data: toBase64(input.bytes) },
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
    });
    log.info("image described", { agent_id: input.agentId, model, chars: described.text.length });
    return { description: described.text };
  } catch (err) {
    log.warn("image could not be read", { agent_id: input.agentId, model, error: String(err) });
    return { error: `could not be read by ${model}` };
  }
}
