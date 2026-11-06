/**
 * How long an Ogg Opus file is, read from the file itself.
 *
 * Needed because a voice message is not just an audio file with a flag on it. Discord requires
 * `duration_secs` on the upload, and without a real number the player shows a scrub bar that does not
 * match the audio — which is worse than sending it as a plain attachment, because the message claims
 * to be something it cannot do properly.
 *
 * ## Why parse rather than decode
 *
 * An Ogg stream already carries the answer. Each page header holds a granule position, and for Opus
 * that granule is a sample count at a fixed 48 kHz regardless of the input rate — so the final page's
 * granule, minus the encoder's pre-skip, *is* the length. No codec, no dependency, no decode.
 *
 * ## What it deliberately does not do
 *
 * Anything that is not Ogg Opus returns `null`. Vorbis granules are in the stream's own rate, which
 * means reading the identification header as well; MP3 needs frame counting or a VBR tag; MP4 needs an
 * atom walk. Each is a different parser with its own failure modes, and the caller's answer to `null`
 * is already correct and cheap: send the file as an ordinary attachment. Guessing a duration here
 * would put an invented number on a message somebody is about to scrub through.
 */

/** Opus granule positions are always at this rate, whatever the source audio was. */
const OPUS_GRANULE_HZ = 48_000;

/** `OggS`. Every page starts with it, which is what makes a backwards scan possible. */
const PAGE_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const;

/** A page header is 27 bytes before the segment table. */
const HEADER_BYTES = 27;

/**
 * Seconds of audio, or null when this is not something we can measure.
 *
 * Fractional on purpose — Discord takes a float, and rounding a 3.4 second clip to 3 makes the last
 * word fall off the end of the scrub bar.
 */
export function oggOpusDurationSeconds(bytes: Uint8Array): number | null {
  if (!looksLikeOggOpus(bytes)) return null;

  const preSkip = readPreSkip(bytes);
  const granule = readFinalGranule(bytes);
  if (granule === null) return null;

  const samples = granule - preSkip;
  if (samples <= 0) return null;

  const seconds = samples / OPUS_GRANULE_HZ;
  // A file claiming more than a day of audio is a file we have misread, not a long recording.
  return Number.isFinite(seconds) && seconds < 86_400 ? seconds : null;
}

/** Ogg container with an Opus stream in it — `OggS` at the front, `OpusHead` in the first packet. */
export function looksLikeOggOpus(bytes: Uint8Array): boolean {
  if (bytes.byteLength < HEADER_BYTES + 19) return false;
  if (!matches(bytes, 0, PAGE_MAGIC)) return false;
  // `OpusHead` sits at the start of the first page's payload. Searched in the first page rather than
  // assumed at a fixed offset, because the segment table's length varies.
  const window = bytes.subarray(0, Math.min(bytes.byteLength, 512));
  return indexOfAscii(window, "OpusHead") >= 0;
}

/**
 * The encoder's pre-skip, in 48 kHz samples.
 *
 * Opus encoders prepend padding the decoder is meant to discard, and it is counted in the granule —
 * so a file's duration is short by exactly this much if it is ignored. Typically 312 samples (6.5ms),
 * which is small enough to look like rounding and large enough to be wrong.
 */
function readPreSkip(bytes: Uint8Array): number {
  const head = indexOfAscii(bytes.subarray(0, Math.min(bytes.byteLength, 512)), "OpusHead");
  if (head < 0) return 0;
  // `OpusHead` layout: 8 bytes magic, 1 version, 1 channel count, then pre-skip as uint16 LE.
  const at = head + 10;
  if (at + 1 >= bytes.byteLength) return 0;
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/**
 * The granule position of the last page, scanning backwards.
 *
 * Backwards because the last page is the one that knows the total, and walking forwards through every
 * page of a ten-minute recording to reach it is work with no purpose. Bounded: a file that ends in
 * something other than a page header is either truncated or not what it says it is, and both answers
 * are `null`.
 */
function readFinalGranule(bytes: Uint8Array): number | null {
  for (let at = bytes.byteLength - HEADER_BYTES; at >= 0; at -= 1) {
    if (!matches(bytes, at, PAGE_MAGIC)) continue;

    // Granule position: 64-bit little-endian at offset 6. Read as two 32-bit halves, because a
    // number is what the caller wants and `BigInt` arithmetic here would buy nothing — an audio file
    // long enough to overflow 53 bits of 48 kHz samples is 5,000 years.
    const low =
      (bytes[at + 6] ?? 0) |
      ((bytes[at + 7] ?? 0) << 8) |
      ((bytes[at + 8] ?? 0) << 16) |
      ((bytes[at + 9] ?? 0) << 24);
    const high =
      (bytes[at + 10] ?? 0) |
      ((bytes[at + 11] ?? 0) << 8) |
      ((bytes[at + 12] ?? 0) << 16) |
      ((bytes[at + 13] ?? 0) << 24);

    // `>>> 0` on the low half: the shifts above produce a signed 32-bit value, and a granule with the
    // top bit set would otherwise come back negative.
    const granule = (low >>> 0) + (high >>> 0) * 2 ** 32;
    // -1 is the "no packet finishes on this page" marker. Keep looking further back.
    if (granule > 0 && granule !== 2 ** 64 - 1) return granule;
  }
  return null;
}

function matches(bytes: Uint8Array, at: number, pattern: readonly number[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[at + i] !== pattern[i]) return false;
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, needle: string): number {
  const target = [...needle].map((char) => char.charCodeAt(0));
  for (let at = 0; at + target.length <= bytes.byteLength; at += 1) {
    if (matches(bytes, at, target)) return at;
  }
  return -1;
}
