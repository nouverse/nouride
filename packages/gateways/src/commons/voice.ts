/**
 * Turning an audio file into a voice message, where the platform has one.
 *
 * A voice message is not an audio attachment with a flag on it. It is a distinct message type with a
 * player, a scrub bar and a duration, and every platform wants slightly different proof that the file
 * really is one. This decides — from the bytes — whether we can honestly make that claim.
 *
 * ## The waveform, and why it is flat
 *
 * Discord takes an amplitude envelope: up to 256 bytes, one per sample point, base64. Computing a real
 * one means decoding Opus, which needs a codec this daemon does not carry and will not grow for a
 * progress bar.
 *
 * So the envelope is **uniform**, deliberately. A flat bar reads to a person as "no waveform data",
 * which is true. The alternative — a plausible-looking synthetic envelope — would be a picture of
 * speech that is not in the file, invented by us and presented as measured. The duration next to it is
 * real, parsed from the stream, so the part somebody actually uses (how long is this, where am I in
 * it) is honest and the part we cannot know says nothing.
 */

import { oggOpusDurationSeconds } from "./ogg.ts";

/**
 * Length of the placeholder envelope.
 *
 * Short on purpose: a 256-byte flat waveform is 256 bytes of the same number, and the shorter one
 * renders identically. Discord accepts anything from 1 to 256.
 */
export const VOICE_WAVEFORM_BYTES = 32;

/** Half scale. Renders as an even bar rather than as silence or as clipping. */
const FLAT_LEVEL = 128;

export interface VoiceUpload {
  /** Seconds, fractional, parsed from the file. */
  durationSecs: number;
  /** Base64 placeholder envelope — see the note at the top of this file. */
  waveform: string;
}

/**
 * What a platform needs to accept this as a voice message, or null.
 *
 * `null` is a complete answer, not a failure: the caller sends the file as an ordinary audio
 * attachment, which every platform renders with a player anyway. The only thing lost is the voice
 * bubble, and the thing avoided is a voice message whose scrub bar lies.
 */
export function voiceMessageUpload(bytes: Uint8Array | undefined): VoiceUpload | null {
  if (!bytes || bytes.byteLength === 0) return null;

  const durationSecs = oggOpusDurationSeconds(bytes);
  // Only Ogg Opus, which is also the format both platforms record their own voice notes in. Anything
  // else has no duration we can read, and a voice message without one is not worth sending.
  if (durationSecs === null) return null;

  return { durationSecs, waveform: flatWaveform() };
}

function flatWaveform(): string {
  const bytes = new Uint8Array(VOICE_WAVEFORM_BYTES).fill(FLAT_LEVEL);
  return Buffer.from(bytes).toString("base64");
}
