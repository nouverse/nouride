/**
 * Speech to text through a service the operator chose — for a model that cannot hear.
 *
 * The fallback, not the path: a model that hears gets the sound itself, which carries who is speaking,
 * the tone, and the words a transcript gets wrong. This runs only when that is not possible, and only
 * when `[media] transcribe_provider` names a profile — sending somebody's voice to a service is the
 * operator's decision to make, never a default.
 *
 * One wire format, OpenAI's `/audio/transcriptions`, because it is the one the options share: OpenAI
 * itself, Groq, and the Whisper servers people run on a machine at home (whisper.cpp's server,
 * faster-whisper-server). A profile pointed at the last kind keeps the voice inside the house and the
 * speech model off this box.
 */

import { basename, readFileBytes } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { Meter } from "@/modules/llm/metered.ts";

const log = createLogger("attachments.transcribe");

/** A long voice note on a slow home server. Past this the sender has waited long enough. */
const TIMEOUT_MS = 120_000;

export interface TranscribeDeps {
  providers: Pick<ProviderRegistry, "endpointFor">;
  media: { transcribeProvider: string; transcribeModel: string };
  fetchImpl?: typeof fetch;
  /**
   * Where a clip transcribed is metered — billed by the minute, so its row carries the clip's length and no tokens
   * (`purpose: "transcription"`). It was recorded nowhere, and capped by nothing.
   */
  record?: Meter;
}

export type Transcript = { ok: true; text: string; by: string } | { ok: false };

/** Whether a transcription service is configured at all. */
export function canTranscribe(media: TranscribeDeps["media"]): boolean {
  return media.transcribeProvider.trim() !== "";
}

export async function transcribe(localPath: string, deps: TranscribeDeps): Promise<Transcript> {
  const profile = deps.media.transcribeProvider.trim();
  if (!profile) return { ok: false };

  try {
    const endpoint = deps.providers.endpointFor(profile);
    const form = new FormData();
    form.append("file", new Blob([await readFileBytes(localPath)]), basename(localPath));
    form.append("model", deps.media.transcribeModel);

    const response = await (deps.fetchImpl ?? fetch)(`${endpoint.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { ...endpoint.headers, authorization: `Bearer ${endpoint.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body is the provider's, and may echo the request: logged by status only.
      log.warn("transcription failed", { profile, status: response.status });
      return { ok: false };
    }
    // Answered, so billed — whatever the body turns out to hold.
    deps.record?.({ inputTokens: 0, outputTokens: 0 }, deps.media.transcribeModel);
    const text = ((await response.json()) as { text?: unknown }).text;
    if (typeof text !== "string") return { ok: false };
    return { ok: true, text: text.trim(), by: `${profile}:${deps.media.transcribeModel}` };
  } catch (err) {
    log.warn("transcription failed", { profile, error: String(err) });
    return { ok: false };
  }
}
