/**
 * Inbound attachments: fetch them, store them, and say what arrived.
 *
 * Nothing here throws. A photo that failed to download still has a caption worth answering, so every
 * failure becomes a sentence in the prompt instead — the alternative is a turn that dies on a file
 * nobody asked the agent to open.
 */

import {
  imageMode,
  nativeVision,
  type AudioRefPart,
  type ImageRefPart,
  type MessageEnvelope,
} from "@nouride/shared";
import { agentCommandsHaveOwnUsers, readFileBytes } from "@nouride/runtime";
import {
  describeStoredAttachments,
  isStored,
  type AttachmentOutcome,
  type StoredAttachment,
} from "@/modules/attachments/store.ts";
import { messageAttachmentRefs, ownAttachmentRefs } from "@/modules/attachments/chat-attachments.store.ts";
import { HearingCheck, type Hearing } from "@/modules/attachments/hearing.ts";
import { canTranscribe, transcribe } from "@/modules/attachments/transcribe.ts";
import { splitVideo } from "@/modules/attachments/video.ts";
import { prepareClip, type ClipDeps, type PreparedClip, type UnheardReason } from "@/modules/attachments/voice-clip.ts";
import {
  DeafAlerts,
  deafAlertText,
  videoNoticeLines,
  voiceNoticeLines,
  type NoticeClip,
} from "@/modules/attachments/voice-notice.ts";
import { readImage as askVisionModel } from "@/modules/attachments/vision.ts";
import { meter } from "@/modules/llm/metered.ts";
import type { PipelineDeps } from "./deps.ts";

/**
 * Who a voice note in this turn would be sent to — the agent's profile and the model it runs on, which
 * is what hearing is decided for. The model is the session's override when there is one.
 */
export interface AudioTarget {
  agentId: string;
  profile: string;
  model: string;
}

/**
 * What the intake produces: what to tell the model, and where the files actually went.
 *
 * The paths were dropped before this — `store` returned only the notice — and that was fine while
 * nothing but the prompt cared. The dashboard cares: a chat that shows the *name* of the screenshot
 * you sent and cannot show the screenshot is a monitor that has the file on disk and no way to reach
 * it. These are the durable copies in the agent's own attachment directory, not the browser upload,
 * which is swept the next day.
 */
export interface IntakeResult {
  /** The block composed into the user message. Empty when nothing was attached. */
  notice: string;
  stored: StoredAttachment[];
  /**
   * Images and voice notes to hand the conversation model directly, as refs the turn resolves into
   * bytes.
   *
   * No image here when this daemon reads images through a separate model (`[media] image_model`), or
   * not at all — there the description in `notice` is the whole of what the agent gets, as before.
   * No audio here unless the model is known to hear; see `HearingCheck`.
   */
  media: (ImageRefPart | AudioRefPart)[];
}

/**
 * How many pictures one turn may carry in from outside the message it is answering.
 *
 * Four, the same ceiling `resolveImages` puts on a request: past that the budget decides anyway, and
 * a reply is a gesture at *a* message rather than a request to re-send an album. Anything beyond it
 * is still reachable with `attachment_read`, which hands back the picture too.
 */
const MAX_CARRIED_IMAGES = 4;

/** The parts of an indexed file this needs. Narrower than `ChatAttachment`, so a test can state one. */
export interface CarriedFile {
  ref: string;
  gatewayId: string;
  /** When it was posted, for the line that tells the model this picture is an earlier one. */
  at?: number;
  name?: string;
  mimeType: string;
  kind: string;
  localPath?: string;
  handle?: unknown;
}

export class AttachmentIntake {
  /** Whether a model can hear, per profile and model. One per daemon, so its caches are shared. */
  readonly hearing: HearingCheck;
  private readonly deafAlerts = new DeafAlerts();

  constructor(
    private readonly deps: PipelineDeps,
    /** ffmpeg and the network, replaceable in tests. */
    private readonly clipDeps: ClipDeps & { fetchImpl?: typeof fetch } = {},
  ) {
    this.hearing = new HearingCheck({
      providers: deps.providers,
      media: deps.config.media,
      // The daemon's listings, which the context window reads too — unless a test hands this its own network.
      ...(clipDeps.fetchImpl ? { fetchImpl: clipDeps.fetchImpl } : deps.providers?.catalog ? { catalog: deps.providers.catalog } : {}),
    });
  }

  /**
   * The pictures on the message this one is replying to.
   *
   * Replying is how a person points at an image — and it was the one gesture that did not work. A
   * reply carries `quotedText` and nothing else: the gateways fetch the quoted message and take its
   * `content`, so the picture the person was pointing at never reached the agent at all. What the
   * agent could do about it was ask for a written description, which for anything about layout or
   * colour is not an answer.
   *
   * Found by ref rather than by a column, because that is how the index is keyed: a file's ref is
   * derived from its message id, its conversation and its position (`messageAttachmentRefs`), so the
   * quoted message's files are computable from its id without storing the id twice. Looked up in this
   * conversation only: in a DM, another of our bots' DM with the same person is not this one (#12).
   *
   * Nothing here throws and nothing here is required. A quoted message with no files, a file with no
   * durable copy and no way to fetch one, a daemon that reads images through a separate model — each
   * returns nothing and the turn proceeds exactly as it did before.
   */
  quotedFiles(envelope: MessageEnvelope): CarriedFile[] {
    const replyTo = envelope.replyTo;
    const index = this.deps.attachmentIndex;
    if (!replyTo || !index) return [];
    return messageAttachmentRefs(envelope, replyTo, MAX_CARRIED_IMAGES)
      .map((ref) => index.find(ref, envelope))
      .filter((file) => file !== null);
  }

  /**
   * Turn indexed files into pictures the turn can carry.
   *
   * Shared by the two ways a file reaches an agent without being attached to the message it is
   * answering — the message it replies to, and the ones that arrived in the room while nobody was
   * talking to it. Both end up in the same place for the same reason, so both go through one
   * function rather than two that will drift.
   *
   * Non-images are dropped rather than described. A log or a PDF is something the agent opens with
   * its own file tools, and always could; only pictures are lost by being turned into prose.
   */
  async pictures(
    agentId: string,
    envelope: MessageEnvelope,
    files: readonly CarriedFile[],
  ): Promise<ImageRefPart[]> {
    if (files.length === 0) return [];
    if (!(await this.shown(agentId)).pictures) return [];

    const parts: ImageRefPart[] = [];
    for (const file of files.filter((candidate) => candidate.kind === "image")) {
      if (parts.length >= MAX_CARRIED_IMAGES) break;
      const localPath = await this.durableCopy(agentId, envelope, file);
      if (!localPath) continue;
      parts.push({
        type: "image_ref",
        ref: file.ref,
        localPath,
        mimeType: file.mimeType,
        ...(file.name ? { filename: file.name } : {}),
        ...(file.at === undefined ? {} : { sentAt: file.at }),
      });
    }
    return parts;
  }

  /**
   * A path the turn can read bytes back from, fetching once if nobody has yet.
   *
   * The path in the index is a hint and is verified, never trusted: the index and the bytes have
   * different retention windows, so a row can outlive the file it points at. A miss is not a failure
   * — it is a reason to go back to the platform, on the connection that *saw* the file, because a
   * Telegram `file_id` is scoped to the bot it was issued to.
   */
  private async durableCopy(
    agentId: string,
    envelope: MessageEnvelope,
    file: CarriedFile,
  ): Promise<string | null> {
    const store = this.deps.attachments;
    if (file.localPath && (await readFileBytes(file.localPath).catch(() => null))) {
      // Another agent's copy is one this agent's commands cannot open where each is its own user: it gets its own.
      if (!store || !agentCommandsHaveOwnUsers() || store.holds(agentId, file.localPath)) return file.localPath;
      return store.copyFor({ agentId, gatewayId: envelope.gatewayId, chatId: envelope.chatId }, file.ref, file.localPath);
    }

    if (!store || !file.handle) return null;
    const gateway =
      this.deps.gateways.get(file.gatewayId) ?? this.deps.gateways.get(envelope.gatewayId);
    const fetcher = gateway?.fetchAttachment?.bind(gateway);
    if (!fetcher) return null;

    const outcome = await store.store(
      { agentId, gatewayId: envelope.gatewayId, chatId: envelope.chatId },
      file.handle as Parameters<typeof store.store>[1],
      fetcher,
      0,
    );
    if (!isStored(outcome)) return null;
    // So the next reader — this agent or another in the room — finds it on disk.
    this.deps.attachmentIndex?.markStored(file.ref, outcome.localPath);
    return outcome.localPath;
  }

  /**
   * Fetch and store inbound attachments, returning what to tell the model.
   *
   * Empty string when there is nothing attached, so an ordinary message is not decorated — the
   * notice on every turn would burn tokens and train the model to talk about files nobody sent.
   */
  async store(agentId: string, envelope: MessageEnvelope, audioTarget?: AudioTarget): Promise<IntakeResult> {
    const scope = {
      agentId,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
    };
    const attachments = envelope.attachments;
    if (!attachments || attachments.length === 0) return { notice: "", stored: [], media: [] };

    // No store configured is *not* a reason to go quiet. Returning "" here was the original bug
    // relocated: the sender's file would vanish with no reply and no error.
    if (!this.deps.attachments) {
      return {
        notice: describeStoredAttachments(
          attachments.map((attachment) => ({
            ...attachment,
            unavailable: "attachment storage is not configured on this daemon",
          })),
        ),
        stored: [],
        media: [],
      };
    }

    const gateway = this.deps.gateways.get(envelope.gatewayId);
    const fetcher = gateway?.fetchAttachment?.bind(gateway);
    if (!fetcher) {
      return {
        notice: describeStoredAttachments(
          attachments.map((attachment) => ({
            ...attachment,
            unavailable: "this gateway cannot retrieve files",
          })),
        ),
        stored: [],
        media: [],
      };
    }

    const outcomes = await Promise.all(
      attachments.map((attachment, index) =>
        this.deps.attachments!.store(scope, attachment, fetcher, index),
      ),
    );

    /**
     * Tell the conversation's index that these files exist, and that a durable copy now does too.
     *
     * The row itself was written before routing (`pipeline/index.ts`) with no path, because at that
     * point nothing had fetched anything. This is the other half: the bytes are on disk now, so
     * anybody else in the room asked about this file later can open the copy instead of going back
     * to a platform handle that may have expired. The message's own files only — a video's frames are
     * derived from it, and the index is keyed by position in the message.
     */
    // Recomputed rather than passed through: the registration happened in another module when each message arrived,
    // and a ref is a pure function of the message and the position — so every agent in the room names a file alike.
    const refs = ownAttachmentRefs(envelope);
    outcomes.forEach((outcome, index) => {
      if (!isStored(outcome)) return;
      this.deps.attachmentIndex?.markStored(refs[index]!, outcome.localPath);
    });

    // A video becomes frames, which join the pictures, and a sound track, which joins the voice notes.
    const videos = await this.videoParts(outcomes, refs, envelope);
    const all = [...outcomes, ...videos.frames.map((frame) => frame.outcome)];
    const allRefs = [...refs, ...videos.frames.map((frame) => frame.ref)];

    /**
     * Whether the conversation model is the one that will look at these.
     *
     * When it is, the description step is skipped entirely — not deferred, skipped. It was a model
     * call per image that produced prose the agent then had to reason about *instead of* the image,
     * and prose has no coordinates. See `nativeVision`.
     */
    const { pictures: native, takes } = await this.shown(agentId);
    // A coding CLI opens a picture it is not shown at its path: a description would be a model call for what it reads.
    const described = native || takes ? all : await Promise.all(all.map((o) => this.readImage(o, agentId)));
    const images = native ? imageRefs(described, allRefs, this.deps.config.media.maxImageBytes, envelope.timestamp) : [];
    const audio = await this.clips(described, allRefs, envelope, audioTarget ?? { agentId, profile: "", model: "" }, videos.tracks, takes);
    return {
      notice: describeStoredAttachments(described, allRefs, {
        native: images.length > 0,
        ownTools: takes !== null,
        extra: [...videos.lines, ...audio.lines],
      }),
      // What arrived, for the turn record and the dashboard — not the frames made from it.
      stored: described.slice(0, outcomes.length).filter(isStored),
      media: [...images, ...audio.parts],
    };
  }

  /**
   * Every video in the message, split into frames and a sound track (`splitVideo`).
   *
   * The frames are image outcomes with refs of their own — `<video ref>.f1` — so the image path, the
   * notice and the budget treat them like the pictures they are. `attachment_read` on one opens the
   * whole video again.
   */
  private async videoParts(
    outcomes: readonly AttachmentOutcome[],
    refs: readonly string[],
    envelope: MessageEnvelope,
  ): Promise<{ frames: { outcome: StoredAttachment; ref: string }[]; tracks: Track[]; lines: string[] }> {
    const frames: { outcome: StoredAttachment; ref: string }[] = [];
    const tracks: Track[] = [];
    const notices: Parameters<typeof videoNoticeLines>[0][number][] = [];

    for (const [index, outcome] of outcomes.entries()) {
      const ref = refs[index];
      if (!isStored(outcome) || outcome.type !== "video" || !ref) continue;
      const split = await splitVideo(
        { localPath: outcome.localPath, ...(outcome.duration === undefined ? {} : { durationSec: outcome.duration }) },
        this.clipDeps,
      );
      const durationSec = outcome.duration;
      if (!split.ok) {
        notices.push({ ...(durationSec === undefined ? {} : { durationSec }), unopened: split.reason });
        continue;
      }
      const length = split.parts.durationSec ?? undefined;
      split.parts.frames.forEach((frame, n) => {
        frames.push({
          ref: `${ref}.f${n + 1}`,
          outcome: {
            type: "image",
            mimeType: "image/jpeg",
            filename: `${outcome.filename ?? "video"} frame ${n + 1}.jpg`,
            localPath: frame.localPath,
            ref: `${outcome.ref}#frame-${n + 1}`,
          },
        });
      });
      notices.push({ ...(length === undefined ? {} : { durationSec: length }), framesAt: split.parts.frames.map((frame) => frame.atSec) });
      if (split.parts.track) {
        tracks.push({
          ref: `${ref}.sound`,
          outcome: {
            type: "audio",
            mimeType: "audio/mpeg",
            filename: `${outcome.filename ?? "video"} sound.mp3`,
            localPath: split.parts.track,
            ref: `${outcome.ref}#sound`,
            ...(length === undefined ? {} : { duration: length }),
            ...(outcome.forwarded ? { forwarded: true } : {}),
          },
          recordedBySender: outcome.recordedBySender === true,
        });
      }
    }

    const ownerChat = this.isOwnerChat(envelope);
    if (!ownerChat && notices.some((notice) => "unopened" in notice && notice.unopened === "no_ffmpeg") && this.deafAlerts.due("video", "no_ffmpeg")) {
      void this.deps.notifier?.alert("video_no_ffmpeg", "A video arrived and could not be opened: ffmpeg is not installed on this machine. Install it to let agents see videos and hear their sound.");
    }
    return { frames, tracks, lines: videoNoticeLines(notices, { ownerChat }) };
  }

  /**
   * The voice notes, audio files and video sound in this message: sent as sound, transcribed, or a
   * line saying why neither.
   *
   * Hearing is asked once per message, and only when there is audio in it: most messages have none,
   * and the question can cost a request to the gateway's listing.
   *
   * No target means a caller that does not know which model will answer. That is treated as a model
   * that cannot hear, which is wrong in the safe direction — an honest "I could not listen" rather than
   * a clip sent to a model that may drop it.
   */
  private async clips(
    outcomes: readonly AttachmentOutcome[],
    refs: readonly string[],
    envelope: MessageEnvelope,
    target: AudioTarget,
    tracks: readonly Track[],
    /** What the agent's coding CLI takes, where one answers it: it hears what it said it does, not what its model does. */
    takes: CliTakes | null = null,
  ): Promise<{ parts: AudioRefPart[]; lines: string[] }> {
    const own: Track[] = outcomes
      .map((outcome, index) => ({ outcome, ref: refs[index] }))
      .filter((entry): entry is Track => isStored(entry.outcome) && isAudio(entry.outcome.type) && entry.ref !== undefined);
    const audio = [...own, ...tracks];
    if (audio.length === 0) return { parts: [], lines: [] };

    // ACP names no formats with `audio`: a clip goes to a CLI as it came, its type said beside it.
    const hearing: Hearing = takes
      ? takes.audio && this.deps.config.media.readAudio ? { hears: true, formats: ["mp3", "wav", "ogg"] } : { hears: false, reason: takes.audio ? "off" : "not_advertised" }
      : target.profile
        ? await this.hearing.check(target.profile, target.model)
        : { hears: false, reason: "not_advertised" };

    const parts: AudioRefPart[] = [];
    const notices: NoticeClip[] = [];
    for (const entry of audio) {
      const { outcome } = entry;
      const file = { localPath: outcome.localPath, mimeType: outcome.mimeType, ...(outcome.duration === undefined ? {} : { durationSec: outcome.duration }) };
      const prepared = await prepareClip(file, hearing, this.limits(), this.clipDeps);
      const clip = prepared.ok ? ({ heard: true } as const) : await this.fallback(file, prepared.reason, target.agentId);
      notices.push({
        kind: entry.recordedBySender !== undefined ? "video" : outcome.type === "voice" ? "voice" : "audio",
        ...(entry.recordedBySender ? { recordedBySender: true } : {}),
        ...(outcome.duration === undefined ? {} : { durationSec: outcome.duration }),
        ...(outcome.forwarded ? { forwarded: true } : {}),
        clip,
      });
      if (prepared.ok) {
        parts.push({
          type: "audio_ref",
          ref: entry.ref,
          localPath: prepared.localPath,
          format: prepared.format,
          ...(outcome.duration === undefined ? {} : { durationSec: outcome.duration }),
          ...(outcome.filename ? { filename: outcome.filename } : {}),
        });
      } else if ("reason" in clip && !takes) {
        // Not for a CLI: what it takes is the CLI's, and no model setting the alert would name changes it.
        this.alertDeaf(target, envelope, clip.reason);
      }
    }

    return { parts, lines: voiceNoticeLines(notices, { ownerChat: this.isOwnerChat(envelope) }) };
  }

  /**
   * A clip the model cannot hear: transcribed, when the operator named a service — or the reason.
   *
   * Not for every reason. `off` is the operator saying audio is not to be processed, and a clip over
   * the length or size limit is over it for the transcription service too.
   */
  private async fallback(
    file: { localPath: string; durationSec?: number },
    reason: UnheardReason,
    agentId: string,
  ): Promise<{ heard: false; reason: UnheardReason } | { heard: false; transcript: string; by: string }> {
    const media = this.deps.config.media;
    if (reason === "off" || reason === "too_long" || reason === "too_large" || !canTranscribe(media)) {
      return { heard: false, reason };
    }
    const result = await transcribe(file.localPath, {
      providers: this.deps.providers,
      media,
      ...(this.clipDeps.fetchImpl ? { fetchImpl: this.clipDeps.fetchImpl } : {}),
      record: meter(this.deps.usage, {
        agentId,
        provider: media.transcribeProvider.trim(),
        purpose: "transcription",
        ...(file.durationSec ? { durationMs: Math.round(file.durationSec * 1000) } : {}),
      }),
    });
    return result.ok ? { heard: false, transcript: result.text, by: result.by } : { heard: false, reason: "transcribe_failed" };
  }

  /**
   * Whether the agent is shown pictures, and what its coding CLI takes where one answers it (0.8.7): the CLI's own word
   * at its handshake, not the media config, which is about models. The note said a CLI's pictures were in its context
   * while each reached it as `[image_ref attached]`.
   */
  private async shown(agentId: string): Promise<{ pictures: boolean; takes: CliTakes | null }> {
    const agent = this.deps.externalAgents?.takes ? this.deps.registry.get(agentId) : undefined;
    const takes = agent ? ((await this.deps.externalAgents?.takes?.(agent)) ?? null) : null;
    const media = this.deps.config.media;
    return { takes, pictures: takes ? media.readImages && takes.image : nativeVision(media) };
  }

  private limits(): { maxSeconds: number; maxBytes: number } {
    return { maxSeconds: this.deps.config.media.maxAudioSeconds, maxBytes: this.deps.config.media.maxAudioBytes };
  }

  private isOwnerChat(envelope: MessageEnvelope): boolean {
    return this.deps.notifier?.isOwnerChat({ gatewayId: envelope.gatewayId, chatId: envelope.chatId }) ?? false;
  }

  /**
   * One clip from earlier in the conversation, ready to hear or with the reason it cannot be.
   *
   * What `attachment_read` asks when the model wants to listen to a voice note again. The same check
   * and the same preparation as a clip arriving with a message, so a file cannot be audible one way
   * and not the other.
   */
  async listen(
    target: { profile: string; model: string },
    file: { localPath: string; mimeType: string; durationSec?: number },
  ): Promise<PreparedClip> {
    const hearing = await this.hearing.check(target.profile, target.model);
    return prepareClip(file, hearing, this.limits(), this.clipDeps);
  }

  /**
   * A video from earlier in the conversation, opened again: its frames and its sound.
   *
   * What `attachment_read` returns for a video — the same split and the same hearing decision as a
   * video arriving with a message. Frames go back as pictures only where the conversation model looks
   * at pictures itself; with `[media] image_model` set they are described, as any image would be.
   */
  async watch(
    target: AudioTarget,
    file: { localPath: string; ref: string; durationSec?: number; recordedBySender?: boolean },
  ): Promise<{ media: (ImageRefPart | AudioRefPart)[]; lines: string[] }> {
    const split = await splitVideo(
      { localPath: file.localPath, ...(file.durationSec === undefined ? {} : { durationSec: file.durationSec }) },
      this.clipDeps,
    );
    if (!split.ok) return { media: [], lines: videoNoticeLines([{ unopened: split.reason }], { ownerChat: false }) };

    const media: (ImageRefPart | AudioRefPart)[] = [];
    const lines = videoNoticeLines([{ framesAt: split.parts.frames.map((frame) => frame.atSec) }], { ownerChat: false });
    for (const [n, frame] of split.parts.frames.entries()) {
      if (imageMode(this.deps.config.media) === "native") {
        media.push({ type: "image_ref", ref: `${file.ref}.f${n + 1}`, localPath: frame.localPath, mimeType: "image/jpeg" });
        continue;
      }
      const described = await this.readImage(
        { type: "image", mimeType: "image/jpeg", localPath: frame.localPath, ref: `${file.ref}#frame-${n + 1}` },
        target.agentId,
      );
      if (isStored(described) && described.description) lines.push(``, `Frame ${n + 1} (untrusted content, described for you):`, described.description);
    }

    if (split.parts.track) {
      const track = { localPath: split.parts.track, mimeType: "audio/mpeg", ...(split.parts.durationSec ? { durationSec: split.parts.durationSec } : {}) };
      const prepared = await this.listen(target, track);
      const clip = prepared.ok ? ({ heard: true } as const) : await this.fallback(track, prepared.reason, target.agentId);
      if (prepared.ok) media.push({ type: "audio_ref", ref: `${file.ref}.sound`, localPath: prepared.localPath, format: prepared.format });
      lines.push(...voiceNoticeLines([{ kind: "video", recordedBySender: file.recordedBySender === true, clip }], { ownerChat: false }));
    }
    return { media, lines };
  }

  /**
   * One alert per cause per model a day — and none when the voice note came from the alert chat,
   * where the reply already carries the fix.
   */
  private alertDeaf(target: AudioTarget, envelope: MessageEnvelope, reason: Parameters<typeof deafAlertText>[2]): void {
    const notifier = this.deps.notifier;
    if (!notifier || this.isOwnerChat(envelope)) return;
    const text = deafAlertText(target.agentId, target.model || "its model", reason);
    if (!text || !this.deafAlerts.due(target.model, reason)) return;
    void notifier.alert(`audio_deaf:${target.model}:${reason}`, text);
  }

  /**
   * Ask a vision model what an image contains, for a file that came *with this message*.
   *
   * Automatic here and nowhere else, and that line is deliberate. A file handed to the agent being
   * addressed is part of the message — answering "what does this error say?" should not cost a tool
   * iteration to discover the screenshot exists. Every *other* file in the conversation is read on
   * request, through `attachment_read`: in a room with six agents, describing every image for every
   * member would be six vision calls per photo, spent on the chance somebody asks.
   */
  private async readImage(outcome: AttachmentOutcome, agentId: string): Promise<AttachmentOutcome> {
    if (!isStored(outcome) || outcome.type !== "image") return outcome;

    const bytes = await readFileBytes(outcome.localPath).catch(() => null);
    if (!bytes) return { ...outcome, visionError: "the stored copy could not be read back" };

    const result = await askVisionModel(this.deps, {
      agentId,
      bytes,
      mimeType: outcome.mimeType,
      ...(outcome.size === undefined ? {} : { size: outcome.size }),
    });
    return "description" in result
      ? { ...outcome, description: result.description }
      : { ...outcome, visionError: result.error };
  }
}

/**
 * The images that will travel with the message, as pointers.
 *
 * Pointers rather than bytes, and the distinction is the whole storage design: this list is written
 * into the session transcript, and a transcript holding base64 grows by every picture forever. The
 * turn reads the file back; see `modules/llm/images.ts`.
 *
 * One thing is filtered here and nowhere else: an image over `max_image_bytes` is left out, so the
 * agent meets the size limit as a sentence in the notice rather than as a provider rejecting the
 * whole request.
 */
function imageRefs(
  outcomes: readonly AttachmentOutcome[],
  refs: readonly string[],
  maxBytes: number,
  /** The message's time: these pictures came with it. */
  sentAt: number,
): ImageRefPart[] {
  const parts: ImageRefPart[] = [];
  outcomes.forEach((outcome, index) => {
    if (!isStored(outcome) || outcome.type !== "image") return;
    if ((outcome.size ?? 0) > maxBytes) return;
    const ref = refs[index];
    if (!ref) return;
    parts.push({
      type: "image_ref",
      ref,
      localPath: outcome.localPath,
      mimeType: outcome.mimeType,
      ...(outcome.filename ? { filename: outcome.filename } : {}),
      sentAt,
    });
  });
  return parts;
}

/** What a coding CLI takes in a prompt besides text, as it said (`ExternalBrains.takes`). */
type CliTakes = { image: boolean; audio: boolean };

/**
 * One piece of sound to send: a stored voice note or audio file, or a video's extracted track.
 * `recordedBySender` is set only for a track, and says whether the video was a video note.
 */
interface Track {
  outcome: StoredAttachment;
  ref: string;
  recordedBySender?: boolean;
}

/** A voice note or an audio file — the two kinds that can go to a model as sound. */
function isAudio(type: StoredAttachment["type"]): boolean {
  return type === "voice" || type === "audio";
}
