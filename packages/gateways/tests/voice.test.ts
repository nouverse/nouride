/**
 * Sending a voice note, and knowing when we cannot.
 *
 * A voice message is a distinct message type on both platforms that have one — a player, a scrub bar,
 * a duration — and both want proof the file really is one. The interesting cases here are all the same
 * question: **when the proof is missing, what happens?** The answer has to be "an ordinary audio
 * attachment", because a voice message with a duration we guessed is a scrub bar that lies about the
 * audio somebody is dragging through.
 */

import { describe, expect, test } from "bun:test";
import { looksLikeOggOpus, oggOpusDurationSeconds } from "../src/commons/ogg.ts";
import { voiceMessageUpload, VOICE_WAVEFORM_BYTES } from "../src/commons/voice.ts";

/**
 * A minimal Ogg Opus file: an ID header page, then a data page carrying the granule.
 *
 * Built rather than fixtured so the expected duration is arithmetic and not a magic number — the
 * granule is a sample count at 48 kHz, so 48,000 minus the pre-skip is one second of audio.
 */
function oggOpus(options: { granule: number; preSkip?: number }): Uint8Array {
  const preSkip = options.preSkip ?? 312;

  const page = (granule: number, payload: number[]): number[] => {
    const header = [
      0x4f, 0x67, 0x67, 0x53, // "OggS"
      0x00, // version
      0x00, // header type
    ];
    // granule position, 64-bit little-endian
    for (let byte = 0; byte < 8; byte += 1) {
      header.push(Math.floor(granule / 2 ** (8 * byte)) & 0xff);
    }
    header.push(0x01, 0x00, 0x00, 0x00); // serial
    header.push(0x00, 0x00, 0x00, 0x00); // sequence
    header.push(0x00, 0x00, 0x00, 0x00); // checksum, not verified by the parser
    header.push(0x01); // one segment
    header.push(payload.length & 0xff);
    return [...header, ...payload];
  };

  const opusHead = [
    0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // "OpusHead"
    0x01, // version
    0x01, // channels
    preSkip & 0xff,
    (preSkip >> 8) & 0xff,
    0x80, 0xbb, 0x00, 0x00, // 48000 Hz
    0x00, 0x00, // output gain
    0x00, // channel mapping
  ];

  return new Uint8Array([...page(0, opusHead), ...page(options.granule, [0x00])]);
}

describe("reading a duration out of the file", () => {
  test("a clip no longer than its pre-skip has no length to give", () => {
    // Only padding, or a granule smaller than the padding it should contain: a misread, not a zero- or
    // negative-second voice note.
    expect(oggOpusDurationSeconds(oggOpus({ granule: 312 }))).toBeNull();
    expect(oggOpusDurationSeconds(oggOpus({ granule: 100 }))).toBeNull();
    expect(oggOpusDurationSeconds(oggOpus({ granule: 313 }))).toBeCloseTo(1 / 48_000, 9);
  });

  test("more than a day is a file misread, not a long recording", () => {
    expect(oggOpusDurationSeconds(oggOpus({ granule: 48_000 * 86_400 + 312 }))).toBeNull();
    expect(oggOpusDurationSeconds(oggOpus({ granule: 48_000 * 86_399 + 312 }))).toBeCloseTo(86_399, 3);
  });

  test("the pre-skip is subtracted, not ignored", () => {
    /**
     * An Opus encoder prepends padding the decoder discards, and it is counted in the granule. 312
     * samples is 6.5ms — small enough to look like rounding, large enough to be wrong, and it is the
     * kind of detail that makes a scrub bar drift on a long recording.
     */
    const withSkip = oggOpusDurationSeconds(oggOpus({ granule: 96_000, preSkip: 48_000 }));
    expect(withSkip).toBeCloseTo(1, 5);
  });

  test("a fractional length stays fractional", () => {
    // Rounding a 3.4 second clip to 3 makes the last word fall off the end of the bar.
    const seconds = oggOpusDurationSeconds(oggOpus({ granule: 48_000 * 3.4 + 312 }));
    expect(seconds).toBeCloseTo(3.4, 3);
  });

  test("a granule of zero is not a zero-second clip", () => {
    // The marker for "no packet finishes on this page", not a measurement.
    expect(oggOpusDurationSeconds(oggOpus({ granule: 0 }))).toBeNull();
  });
});

describe("what is not an Ogg Opus file", () => {
  test("an mp3 is not measured, and does not pretend to be", () => {
    // ID3 header. The parser answers null, and the caller's answer to null is "send it as audio".
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...new Array(64).fill(0)]);
    expect(looksLikeOggOpus(mp3)).toBe(false);
    expect(oggOpusDurationSeconds(mp3)).toBeNull();
  });

  test("an Ogg container with no Opus stream in it", () => {
    // Vorbis granules are in the stream's own sample rate, which needs the identification header to
    // interpret. A different parser, so: not this one's business.
    const vorbis = new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new Array(80).fill(0)]);
    expect(looksLikeOggOpus(vorbis)).toBe(false);
  });

  test("empty and truncated input", () => {
    expect(oggOpusDurationSeconds(new Uint8Array())).toBeNull();
    expect(oggOpusDurationSeconds(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBeNull();
  });
});

describe("the upload a voice message needs", () => {
  test("carries the real duration and a placeholder envelope", () => {
    const upload = voiceMessageUpload(oggOpus({ granule: 48_000 * 2 + 312 }));

    expect(upload?.durationSecs).toBeCloseTo(2, 5);

    /**
     * The waveform is uniform, deliberately.
     *
     * A real amplitude envelope needs an Opus decoder this daemon does not carry. A flat bar reads to
     * a person as "no waveform data", which is true; a plausible-looking synthetic one would be a
     * picture of speech that is not in the file, invented here and presented as measured.
     */
    const waveform = Buffer.from(upload!.waveform, "base64");
    expect(waveform.byteLength).toBe(VOICE_WAVEFORM_BYTES);
    expect(new Set(waveform)).toEqual(new Set([128]));
  });

  test("refuses a file whose length it cannot read", () => {
    // The whole point. `null` means "send it as an ordinary audio attachment" — which every platform
    // renders with a player anyway. What is avoided is a voice message with an invented duration.
    expect(voiceMessageUpload(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(voiceMessageUpload(undefined)).toBeNull();
    expect(voiceMessageUpload(new Uint8Array())).toBeNull();
  });
});
