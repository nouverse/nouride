/**
 * What a turn asks its model: the tools it holds, the question it composes — the words, the files that came with
 * them, what the room said meanwhile — and the request that carries both with everything the prompt is built from.
 * Phases of `TurnRunner.runTurn` (`turn.ts`), in the order it runs them.
 */

import { newId, type ChatMessage, type LLMProvider } from "@nouride/shared";
import type { ModelOverrides } from "@/modules/hooks/registry.ts";
import type { TurnRequest, Unattended } from "@/modules/llm/executor/types.ts";
import type { Recall } from "@/modules/memory/index.ts";
import { notesOf } from "@/modules/notes/tail.ts";
import { speakerName } from "@/modules/people/match.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { isSystemEvent } from "./deps.ts";
import { editedQuestionNote, isEdit } from "./edit-rules.ts";
import { arrivingQuestion, composeContent, composeQuestion, outsideOf, secretsNote, threadOpenerNote, turnReminders } from "./messages.ts";
import { missionQuestions } from "./mission-questions.ts";
import { OWN_WORDS } from "./own-words-wake.ts";
import { scheduledInChat } from "./job-turns.ts";
import type { AttachmentIntake } from "./attachments.ts";
import type { RoomMemory } from "./room-memory.ts";
import type { TurnContext } from "./turn-context.ts";
import type { TurnState } from "./turn-state.ts";

/** What the turn holds to answer with: its provider, its tools, and the chat's `/model` when it has one. */
export interface TurnKit {
  provider: LLMProvider;
  toolset: ReturnType<typeof resolveToolset>;
  override: string | undefined;
}

/** The provider, the toolset and the model — read when the turn starts its work, so a `/model` sent before counts. */
export function equip(ctx: TurnContext, turn: TurnState, modelOverrides: Pick<ModelOverrides, "get">): TurnKit {
  const { agent, shape } = turn;
  const provider = ctx.deps.providers.get(agent.config.llm.provider);
  // `mission` as this turn holds it: `start` in a chat, the mission's own actions in a mission's turn (0.8.0).
  const missionTool = shape ? ctx.deps.missionTools?.inside : ctx.deps.missionTools?.chat;
  // `schedule` in a chat's turn only: a mission's conversation is read by nobody, and its card would go nowhere.
  const scheduleTool = shape ? undefined : ctx.deps.scheduleTool;
  const workTool = ctx.deps.missionTools?.work;
  const toolset = resolveToolset(agent, ctx.tools, ctx.deps.config.security, { ...ctx.toolsetDeps(), ...(missionTool ? { missionTool } : {}), ...(workTool ? { workTool } : {}), ...(scheduleTool ? { scheduleTool } : {}), ...(shape?.helperWorktrees ? { helperWorktrees: true } : {}) });
  const override = modelOverrides.get(turn.session.id);
  return { provider, toolset, override };
}

/**
 * The question, composed and kept: the journal opened with the words alone, the files downloaded, what the room said
 * since this agent was last spoken to, and the message the model is asked — on the state as soon as it exists, so the
 * failure path can save it.
 */
export async function compose(
  ctx: TurnContext,
  turn: TurnState,
  with_: {
    rooms: Pick<RoomMemory, "filesBefore" | "overheardBefore" | "eventsBefore">;
    attachments: Pick<AttachmentIntake, "store" | "pictures" | "quotedFiles">;
  },
  override: string | undefined,
): Promise<{ asked: ChatMessage; workspace: ReturnType<TurnContext["workspaceFor"]> }> {
  const { agent, envelope, text, session, history, record } = turn;
  const { rooms, attachments } = with_;
  /**
   * The turn's journal — `modules/turns/journal.store.ts` — opened before anything slow (P6).
   *
   * With the words alone, because the files that came with them download first, up to thirty seconds a file. A
   * crash in that window used to leave a record and no journal: at the next boot the person was told the turn
   * was gone, and it was taken up again in the same breath. Opened here, it is closed like any turn a crash cut
   * off, and the composed question takes this one's place once it exists. From here nothing the turn does is lost
   * to a crash: the executor commits every message as it happens, and however the turn ends, what it did is
   * folded into the conversation.
   */
  const head = { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId, kind: "chat" as const, startedAt: Date.now() };
  turn.journal = ctx.deps.journal?.open(record?.id ?? newId("turn"), head, { role: "user", content: arrivingQuestion(text, envelope.attachments), timestamp: envelope.timestamp });

  // Show typing indicator immediately while downloading attachments and analyzing images
  if (ctx.deps.config.llm.streaming.typingIndicator) void turn.voiceGateway?.setTyping(envelope.chatId);

  // Downloaded before the turn starts, so the agent can open the file within the same reply
  // rather than telling the user to send it again. A failure here is a note in the prompt, never
  // an aborted turn: a message whose image did not download still has its text.
  // The model this turn will actually run on — a `/model` override hears or not on its own terms.
  const target = { agentId: agent.config.id, profile: agent.config.llm.provider, model: override ?? agent.config.llm.model };
  const intake = await attachments.store(agent.config.id, envelope, target);
  /**
   * Plus the pictures that reached this conversation without being attached to this message.
   *
   * Two ways that happens and both were losing them. A reply brings the quoted *text* and nothing
   * else, so the image somebody was pointing at never arrived. And a picture posted while nobody
   * was talking to this agent was replayed as a line of chatter with its file left behind — the
   * shape of "here is a screenshot" followed by "@agent look at this" in the next message.
   *
   * Both are the same fix and both are bounded: the quoted message, and the window
   * `overheardBefore` already replays. Empty for an ordinary turn.
   */
  const carried = await attachments.pictures(agent.config.id, envelope, [
    ...(await attachments.quotedFiles(envelope)),
    ...rooms.filesBefore(envelope, history, session.startedAt),
  ]);
  const attachmentNotice = carried.length > 0
    ? `${intake.notice}\n[${carried.length} image(s) from earlier in this conversation are in` +
      ` your context as pictures: the message you are replying to, or what was posted here` +
      ` while nobody was talking to you. Read what you need from them.]`.trim()
    : intake.notice;
  /**
   * The record points at the durable copies, not the browser upload.
   *
   * `TurnRecorder.begin` wrote the upload paths, which live in `data/uploads` for a day. These are
   * the files in the agent's own attachment directory, which is what the retention sweep governs
   * and what the dashboard can still serve a week later.
   */
  if (intake.stored.length > 0) {
    record?.attachments(
      intake.stored.map((stored) => ({
        name: stored.filename ?? "file",
        mimeType: stored.mimeType,
        kind: stored.type,
        ...(stored.size === undefined ? {} : { bytes: stored.size }),
        direction: "in" as const,
        path: stored.localPath,
      })),
    );
  }

  /**
   * What the room said since this agent was last spoken to.
   *
   * Composed into the user message and *stored with it*, which is what keeps this from repeating
   * itself: the block is replayed once, becomes part of the conversation like anything else, and
   * the next turn's window starts after the message that carried it. So the history grows by the
   * chatter that actually happened and never by the same line twice.
   */
  const overheard = rooms.overheardBefore(agent, envelope, history, session.startedAt);
  // The same window, read from the events table. Stored with the message for the same reason, so
  // an event reaches this agent once and then belongs to its conversation.
  const events = rooms.eventsBefore(agent, envelope, history, session.startedAt);
  const question = composeQuestion({
    text,
    overheard,
    events,
    hasAttachments: Boolean(attachmentNotice),
    ...(envelope.chatType === "dm" ? {} : { speaker: speakerName(ctx.deps.config.people, envelope) }),
    // A thread's first question carries what the thread was started from; after that it is in the history (0.7.24).
    ...(envelope.threadOpener && history.length === 0
      ? { opener: threadOpenerNote({ name: speakerName(ctx.deps.config.people, { gatewayId: envelope.gatewayId, ...envelope.threadOpener }), ...envelope.threadOpener }) }
      : {}),
    // An edit of a message already answered is asked as one, so the agent can say what changes (`edit-rules.ts`).
    ...(isEdit(envelope) ? { edit: editedQuestionNote(envelope) } : {}),
    // What its handles stand for, in the model's copy only: the turn's record keeps what the person wrote. A coding
    // CLI's own shell never has a handle (0.8.11), and is told so.
    ...(envelope.secrets?.length ? { secrets: secretsNote(envelope.secrets, { ownShell: agent.config.external !== undefined }) } : {}),
  });

  const workspace = ctx.workspaceFor(agent.config.id);

  /**
   * Kept on the state, so the failure path can still save it.
   *
   * A turn that throws never reaches `sessions.save`, and that is where the question went: stop an
   * agent mid-answer and the message you had just sent was gone from the conversation with it, so
   * `/start` resumed an agent that had never heard it. Reported as "kalo stop beneran hilang
   * konteks di atasnya ya?", and it was — for every failed turn, not only a stopped one.
   */
  const asked: ChatMessage = (turn.asked = {
    role: "user",
    /**
     * Parts when a picture came with the message, a plain string otherwise.
     *
     * Text first and images after, which is the order that reads correctly to every provider
     * this talks to: the question, then the thing it is about. The refs are pointers — the
     * executor turns them into bytes for the request and the transcript keeps the pointers,
     * so the session row stays a few hundred bytes rather than a megabyte per screenshot.
     */
    content: composeContent(
      attachmentNotice ? `${question}\n\n${attachmentNotice}`.trim() : question,
      // The message's own first: `resolveImages` reads newest-first within a budget, and what
      // somebody just sent beats what they are pointing back at.
      [...intake.media, ...carried.filter((part) => !intake.media.some((own) => own.ref === part.ref))],
    ),
    timestamp: envelope.timestamp,
  });

  turn.journal?.question(asked);
  return { asked, workspace };
}

/** The request the turn's brain is run with: the question, the history, the tools, and what the prompt is built from. */
export function turnRequest(
  ctx: TurnContext,
  turn: TurnState,
  ask: {
    kit: TurnKit;
    asked: ChatMessage;
    workspace: ReturnType<TurnContext["workspaceFor"]>;
    recall: Recall | undefined;
    modelOverrides: Pick<ModelOverrides, "effortOf">;
  },
): TurnRequest {
  const { agent, envelope, session, record, shape, cause, journal, nudges, person, asPerson, turnKey } = turn;
  const { provider, toolset, override } = ask.kit;
  const { recall, modelOverrides, workspace } = ask;
  return {
    signal: turn.controller.signal,
    agent,
    provider,
    ...fallbacksFor(agent, ctx.deps.providers),
    toolset,
    history: turn.history,
    // Already stripped of the address prefix by the caller: left in, the model sees its own
    // name as the first token of every message and starts echoing the pattern back.
    //
    // Attachments are *described*, never silently dropped. Before this, a photo with a caption
    // sent the caption alone and the model answered confidently about a screenshot it had never
    // seen — worse than an error, because nothing in the reply shows it happened.
    userMessage: ask.asked,
    reminders: [
      ...turnReminders(turn.text, toolset.definitions, { running: ctx.helpersRunning(agent.config.id, envelope), now: Date.now() }),
      // What its own missions in this chat wait for the person to answer (`mission-questions.ts`).
      ...missionQuestions(ctx.deps.missionCommands?.forChat(envelope.gatewayId, envelope.chatId) ?? [], agent.config.id, toolset.definitions),
    ],
    workspaceDir: workspace.shared,
    privateDir: workspace.own,
    ...(modelOverrides.effortOf(session.id) ? { effort: modelOverrides.effortOf(session.id)! } : {}),
    // Set only on a synthesized wake-up. Forwarded rather than re-derived: the executor has no
    // business knowing what a background job is, and the envelope already knows.
    ...(envelope.owedReport ? { owedReport: envelope.owedReport } : {}),
    // Only the agents that could actually be reached from here. Naming one that is disabled, or
    // that no gateway would deliver to, teaches the model to address somebody who never answers.
    //
    // And *how* they are reached, which is not the same question in every chat. In a room every
    // bot present sees what is said, so a tag is delivered and the exchange is visible to the
    // people in it. A DM is one person and one bot: nothing written there reaches another agent,
    // whether or not it has a connection of its own, so the handover goes over the bus instead
    // and the agent the person is talking to stays the only voice in the conversation.
    /**
     * Narrowed to the room's members where the room has any.
     *
     * `registry.enabled()` is every live agent on the daemon, which is the right answer for a
     * platform chat — the operator decides who is in a Discord channel and we cannot see it — and
     * the wrong one for a room somebody built out of three agents. There it told Nero it could
     * tag Nexa and Nestor, who are not in the conversation: the tag goes out, the router delivers
     * it to nobody, and it reads as a routing bug rather than as a prompt that named the wrong
     * people. `roomAgents` returns null when nothing knows, and this falls back to the old list.
     */
    ...(() => {
      const otherAgents = ctx.otherAgentsFor(agent.config.id, envelope);
      return otherAgents ? { otherAgents } : {};
    })(),
    // `exec` hands back `Live log: <dataDir>/jobs/<id>.log` when it starts something in the
    // background, and `read` used to refuse that path — the tool named a file its own sandbox
    // would not open. Read-only, because the job is still writing to it.
    readOnlyRoots: ctx.readOnlyRoots(agent, session.id),
    // Scoped to THIS conversation, not the agent's whole attachment tree: a file posted in a
    // Discord channel must not be readable from a Telegram DM.
    ...(ctx.deps.attachments
      ? {
          attachmentRoot: ctx.deps.attachments.rootFor({
            agentId: agent.config.id,
            gatewayId: envelope.gatewayId,
            chatId: envelope.chatId,
          }),
        }
      : {}),
    gateway: envelope.gateway,
    ...ctx.formattingFor(envelope.gatewayId),
    gatewayId: envelope.gatewayId,
    chatId: envelope.chatId,
    // The signal says the turn will end; this says when. Anything deciding how long to block —
    // the approval gate, today — needs the second to leave room for the model to react.
    deadlineAt: turn.deadlineAt,
    chatType: envelope.chatType,
    ...ctx.roomNameOf(envelope),
    sessionId: session.id,
    // With the call ids its helpers and peers draw from too: their steps are rows of this turn (`stepsInto`).
    ...(record ? { turnId: record.id, callIds: ctx.callIdsOf(record.id) } : {}),
    senderId: person.senderId,
    // A mission's call that needs a person is parked, not waited on (MISSIONS §7).
    ...(shape ? { parkApprovalsMs: shape.parkApprovalsMs, workdir: shape.workdir, ...(shape.parked > 0 ? { parkedCalls: shape.parked } : {}) } : {}),
    // Work nobody watches (0.8.0): a mission's turn, or a scheduled job's turn put into its own chat.
    ...((): { unattended?: Unattended } => {
      const unattended = shape?.unattended ?? scheduledInChat(envelope);
      return unattended ? { unattended } : {};
    })(),
    // A schedule's, a job's or a resume's turn says so, rather than reading as a stranger's (#13).
    ...(isSystemEvent(envelope) ? { systemEvent: true } : {}),
    ...(cause?.via === OWN_WORDS ? { ownWords: true } : {}),
    /**
     * An *unverified* display name stays group-only: in a DM there is nobody else in the room, so
     * a name the sender chose for themselves adds nothing but a chance to be misread as
     * identification.
     *
     * A verified one is the opposite. It means this daemon authenticated the account the message
     * came from — the dashboard — and withholding it left the agent knowing nothing about who it
     * was talking to in the one surface where the operator actually sits.
     */
    ...(envelope.chatType !== "dm" || envelope.senderVerified
      ? { senderName: envelope.senderName }
      : {}),
    ...(envelope.senderVerified ? { senderVerified: true } : {}),
    // The *matched* person goes everywhere, DMs included. That is the whole point — a household
    // talks to its agent in DMs, and this is the surface that told the agent nothing.
    ...(() => {
      const known = ctx.personFor(asPerson);
      return known ? { person: known } : {};
    })(),
    ...(recall ? { recall } : {}),
    // Told even when nobody matched, because that is when it changes what the model should do.
    ...(ctx.deps.config.people.length > 0 ? { peopleConfigured: true } : {}),
    ...(override ? { model: override } : {}),
    ...(journal ? { journal } : {}),
    // A forwarded message, a webhook's payload — or what a mission read in an earlier turn: read as outside content
    // from the first step (S13).
    ...outsideOf({ ...envelope, outsideContent: [...(envelope.outsideContent ?? []), ...(shape?.outsideContent ?? [])] }),
    // A shutdown ends a turn between steps rather than in the middle of one; a person's new message is read there.
    // A shutdown, or the agent put to sleep (0.8.0): either stops the turn at its next step, never mid-call.
    pause: () => ctx.paused || ctx.deps.registry.isPaused(agent.config.id), steer: () => ctx.takeSteers(turnKey),
    steerListen: (poke) => {
      const active = ctx.activeTurns.get(turnKey);
      if (!active) return () => {};
      active.onSteer = poke;
      return () => {
        if (active.onSteer === poke) active.onSteer = undefined;
      };
    },
    steerReplying: () => ctx.activeTurns.get(turnKey)?.replying === true,
    ...(nudges ? { harnessNote: nudges.take } : {}),
    // The conversation's work notes, read at every request and sent after everything else (`modules/notes/`).
    ...notesOf(ctx.deps.notes, { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId }),
  };
}
