/**
 * One conversation, as the daemon sees it.
 *
 * Everything that used to live in the page's own state — the steps, the clock, the reply, whether
 * anything is running — is read from the daemon here. That inversion is the fix for all three bugs
 * this rewrite is about: a refresh mid-turn reattaches instead of re-sending, a reload keeps the step
 * breakdown and the real duration, and a turn started in another tab (or by a background job
 * reporting in) shows up without anybody pressing anything.
 *
 * ## Why the live feed is a hand-rolled loop
 *
 * The steps arrive incrementally, keyed by a cursor that belongs to a specific turn, and have to be
 * merged onto what is already on screen. A cache keyed by URL is the wrong tool for that — it wants to
 * *replace* an answer, not extend one — so the polling is a plain loop with two refs, and the cached
 * queries are kept for the two things that genuinely are snapshots: the transcript and the session
 * list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { splitForDisplay } from "@/commons/lib/turn-display";
import { useEventStream } from "@/commons/hooks/use-event-stream";
import { useRevealing } from "@/commons/hooks/use-revealing";
import { usePageVisible } from "@/commons/hooks/use-page-visible";
import { notesKey } from "@/commons/hooks/use-notes";
import { api, ApiError } from "@/commons/lib/api";
import type { ChatEvent, ChatSession, ChatTurn, LiveTurn, OpenPage, RoomMessage, RunningJob } from "@nouride/wire";

/**
 * How often to ask while something is happening.
 *
 * Half a second, because the steps are the thing being watched: a tool that starts and finishes inside
 * one poll interval arrives as a pair of lines at once, and at 700ms that happened often enough to
 * read as "nothing, nothing, then everything". One indexed query per poll on the daemon's side.
 */
const LIVE_MS = 500;
/**
 * …and while the conversation's event stream is open, which polls the moment anything is written: the timer is
 * only the net under it then, for an event the stream did not carry.
 */
const STREAMED_LIVE_MS = 2_000;
/** …and while nothing is. Still polled, so an agent that speaks first is not invisible. */
const IDLE_MS = 4_000;
/** …and while the tab is hidden: a net, not a feed — nobody is looking. */
const HIDDEN_MS = 30_000;
/**
 * How long a sent message waits for a turn to exist before the page says something.
 *
 * A dispatch that produces no turn is possible — a message the router dropped, an agent paused in the
 * moment between the check and the queue — and the failure mode without this is a spinner that never
 * resolves, which is the exact thing the daemon's own timeout rule exists to avoid.
 */
const START_GRACE_MS = 30_000;

/**
 * What was just sent, so the route change that follows it does not lose the message.
 *
 * A new conversation has no URL until the daemon names it, so sending navigates — which unmounts this
 * hook. Without this the person's own message vanishes for the half second before the first poll
 * answers. Module scope, keyed by session, cleared on read.
 */
const justSent = new Map<string, { text: string; at: number }>();

export interface Conversation {
  session: ChatSession | null;
  /** Exchanges recorded as turns: prompt, reply, steps, timings. */
  turns: ChatTurn[];
  /** Exchanges older than the oldest kept turn, from the agent's session. Text only. */
  earlier: { role: "user" | "assistant"; content: string; timestamp?: number }[];
  /**
   * Things that happened *to* this conversation, oldest first.
   *
   * Room-scoped, so a chat with two agents in it shows the same notices under both. Reordered here
   * rather than in the daemon, which sends them newest-first because that is the page a transcript
   * opens on.
   */
  events: ChatEvent[];
  /**
   * What people said in this room, whether or not anybody answered.
   *
   * Empty for a one-to-one conversation, where a turn already carries the question. In a room the
   * bubble comes from here, which is the only reason an untagged message is visible at all.
   */
  messages: RoomMessage[];
  /**
   * The turns happening now — plural, because a room can have several.
   *
   * A DM contributes its single turn, so the page renders a list either way rather than branching on
   * the mode.
   *
   * A message naming two agents runs both, so a single slot would draw one worker and imply the other
   * had finished. A one-to-one conversation puts its single turn in here too, so the page has one
   * shape to render rather than a branch.
   */
  liveTurns: LiveTurn[];
  /**
   * A live turn that is over says whether its answer is still being written out (`LiveTurnView`). A turn this page
   * saw at work stays in `liveTurns` until its view says it is not: an answer that came whole at the turn's end is
   * written out like any other, not handed to the history a moment later with every word at once.
   */
  reveals: (turnId: string, on: boolean) => void;
  /**
   * Background work still running in this conversation.
   *
   * Not part of any turn: `exec background: true` returns immediately, so the turn that started a
   * ten-minute build is long over while the build runs. This is what fills that silence — and it is
   * why a job finishing does not arrive as a surprise.
   */
  jobs: RunningJob[];
  /** A message sent whose turn has not appeared yet. */
  pending: string | null;
  /**
   * This conversation opened on a message the page sent a moment before, from a new chat: what it then holds is what
   * arrives in it, not what it was opened on.
   */
  startedHere: boolean;
  /** Something is running: this client sent it, or somebody else did. */
  busy: boolean;
  loading: boolean;
  /** The conversation's event stream is open — the page's polls are a net under it. */
  streaming: boolean;
  /** A send that was refused, or a turn that never started. */
  error: Error | null;
  /** `page`: the dashboard page it is written from, which the agent is then told (the floating chat's alone). */
  send: (text: string, attachments?: { path: string; mimeType: string; filename: string }[], page?: OpenPage) => void;
  /** Everything in the chat, or one agent when a card names it. */
  stop: (agent?: string) => void;
  clearError: () => void;
}

export function useConversation(input: {
  sessionId?: string;
  /**
   * A room, addressed by its chat id.
   *
   * Mutually exclusive with `sessionId` in practice: a room has no session until somebody has spoken
   * in it, and a one-to-one conversation is always addressed by the session. Both present means the
   * room wins, because that is the more specific statement about what this conversation is.
   */
  roomChatId?: string;
  agentId: string;
  /** Called with the daemon's session id once a new conversation has one, and the agent the daemon says it is with. */
  onSession: (sessionId: string, agentId: string) => void;
}): Conversation {
  const { sessionId, roomChatId, agentId, onSession } = input;
  const queryClient = useQueryClient();

  const [live, setLive] = useState<LiveTurn | null>(null);
  const { turnId: revealing, read: readForReveal, say: reveals, reset: resetReveal } = useRevealing();
  /** A room's running turns. Plural — see `Conversation.liveTurns`. */
  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  /** Which turns were running at the last poll, so one leaving the list can settle the transcript. */
  const seenRunning = useRef(new Set<string>());
  const [jobs, setJobs] = useState<RunningJob[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const [startError, setStartError] = useState<Error | null>(null);
  const pendingSince = useRef(0);

  const transcript = useQuery({
    /**
     * Keyed on which kind of conversation this is, not on the id alone.
     *
     * A room and a session are different addresses for different scopes — the room reads every
     * agent's turns, the session reads one agent's — so sharing a key would serve one from the
     * other's cache. Structurally distinct, the same fix the sessions list needed.
     */
    queryKey: roomChatId ? ["transcript", "room", roomChatId] : ["transcript", sessionId],
    queryFn: () => (roomChatId ? api.roomTurns(roomChatId) : api.transcript(sessionId!)),
    enabled: Boolean(roomChatId ?? sessionId),
    // Read on load and when a turn ends, never on a timer — the live loop below is the thing that
    // polls, and it is small.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  /**
   * The placeholder goes the moment the real message is on screen.
   *
   * In a room the daemon records a person's message *before* routing decides anything, so the
   * transcript refetch that follows the send already contains it — while `pending` was still waiting
   * for a *turn* to appear. Between those two moments the same message was drawn twice: once as the
   * optimistic bubble and once as the real one, collapsing back to one a second later when a turn
   * finally started.
   *
   * Matched on the text because that is all the client knows about its own message until the daemon
   * answers; the message id it gets back is the envelope's, and the bubble is keyed on the row.
   */
  useEffect(() => {
    if (!roomChatId || !pending) return;
    const said = transcript.data?.messages ?? [];
    if (said.some((message) => message.text.trim() === pending.trim())) setPending(null);
  }, [roomChatId, pending, transcript.data]);

  /** Read inside the loop, which closes over the first render's state. */
  const pendingRef = useRef<string | null>(null);
  pendingRef.current = pending;
  /** Set by the polling effect, called by `send`. Replaced by a no-op while nothing is polling. */
  const wake = useRef<() => void>(() => {});

  /**
   * The conversation's events (`use-event-stream.ts`): each polls now instead of on the timer, which waits longer
   * while they arrive. A room's stream names its gateway, as a one-to-one conversation's does: a chat id alone is that
   * chat on every connection.
   */
  const streamChat = roomChatId ?? transcript.data?.session?.chatId;
  const streamGateway = roomChatId ? transcript.data?.room?.gatewayId : transcript.data?.session?.gatewayId;
  const { streaming } = useEventStream({ chatId: streamChat, gatewayId: streamGateway, wake: () => wake.current() });
  /** Read inside the loops, which close over the first render's state. */
  const streamed = useRef(false);
  streamed.current = streaming;
  /** A hidden tab polls only as a slow net; looked at again, the stream's hook wakes the loop at once. */
  const visible = useRef(true);
  visible.current = usePageVisible();

  /** The cursor, and which turn it counts. Sent together, because one is meaningless without the other. */
  const cursor = useRef({ turnId: "", seq: 0 });
  /** Turns whose completion has already been folded into the transcript, so it is refetched once. */
  const settled = useRef(new Set<string>());

  useEffect(() => {
    // A different conversation is a different feed. Everything derived from the last one goes.
    cursor.current = { turnId: "", seq: 0 };
    settled.current = new Set();
    setLive(null);
    resetReveal();
    setLiveTurns([]);
    seenRunning.current = new Set();
    setJobs([]);
    setStartError(null);

    /**
     * A room polls its own feed, and it has to: a room has no session id until an agent has taken a
     * turn in it, so the per-session loop below would return early and the first message in a new
     * room showed no sign of anything happening until the page was reloaded.
     */
    if (roomChatId) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let inFlight = false;
      /** A wake that came mid-request — see the one-to-one loop below. */
      let nudged = false;
      const settledHere = new Set<string>();

      const schedule = (ms: number) => {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, ms);
      };
      wake.current = () => schedule(0);

      const tick = async () => {
        if (inFlight) {
          nudged = true;
          return;
        }
        inFlight = true;
        nudged = false;
        let wait = IDLE_MS;
        try {
          const { turns, jobs: running } = await api.roomLive(roomChatId);
          if (stopped) {
            inFlight = false;
            return;
          }
          setJobs(running ?? []);
          // Replaced whole rather than extended: every poll carries each turn's steps in full, so
          // merging would double them. A room's turns come with no cursor, since nothing is asked "since": none is kept.
          setLiveTurns(turns.map((turn) => ({ ...turn, cursor: 0 })));

          if (turns.length > 0 || pendingRef.current) wait = streamed.current ? STREAMED_LIVE_MS : LIVE_MS;

          /**
           * The placeholder goes as soon as a turn is running — the transcript refetch below is what
           * puts the real bubble on screen, and it comes from the room's messages rather than from a
           * turn.
           */
          if (pendingRef.current && turns.length > 0) setPending(null);

          /**
           * A turn that has just left the running list has finished, so the transcript is refetched
           * — once per turn, because the transcript is what a finished turn is drawn from and a
           * refetch per poll would reload the room every second for as long as the tab is open.
           */
          const runningIds = new Set(turns.map((turn) => turn.id));
          for (const id of seenRunning.current) {
            if (!runningIds.has(id) && !settledHere.has(id)) {
              settledHere.add(id);
              void queryClient.invalidateQueries({ queryKey: ["transcript", "room", roomChatId] });
              void queryClient.invalidateQueries({ queryKey: ["sessions"] });
            }
          }
          seenRunning.current = runningIds;

          /**
           * Nothing running and nothing to wait for. That is **not** an error in a room.
           *
           * A message that addresses nobody is answered by nobody, which is how a group chat works
           * and is most of what gets typed in one. The old behaviour treated it as a failure: the
           * placeholder sat there, the send button stayed a stop button, and thirty seconds later the
           * client announced that no turn had started — for a message that was never meant to start
           * one.
           *
           * So the placeholder is simply dropped once the message itself is on screen, and the
           * transcript is refetched to put it there.
           */
          if (pendingRef.current && turns.length === 0 && Date.now() - pendingSince.current > 1_500) {
            setPending(null);
            void queryClient.invalidateQueries({ queryKey: ["transcript", "room", roomChatId] });
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            inFlight = false;
            return;
          }
        }
        inFlight = false;
        schedule(nudged ? 0 : visible.current ? wait : Math.max(wait, HIDDEN_MS));
      };

      void tick();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        wake.current = () => {};
      };
    }

    if (!sessionId) {
      setPending(null);
      setStartedHere(false);
      return;
    }

    // Anything sent a moment ago, before this mount existed.
    const carried = justSent.get(sessionId);
    justSent.delete(sessionId);
    const fresh = carried !== undefined && Date.now() - carried.at < 60_000;
    setStartedHere(fresh);
    if (carried && fresh) {
      setPending(carried.text);
      pendingSince.current = carried.at;
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, ms);
    };
    /**
     * Poll now.
     *
     * Sending into a conversation that already has a URL does not restart this effect, so without a
     * nudge the first sign of the turn would arrive on the idle schedule — four seconds of a message
     * sitting there with nothing happening, which is exactly the impression the old chat gave.
     */
    wake.current = () => schedule(0);

    /**
     * One tick at a time: a nudge that arrived mid-request would otherwise fork the loop in two.
     *
     * Kept rather than dropped, though. It asks about something newer than the request in flight — a send that
     * has just landed — and dropped, the answer waited a whole interval behind a request that went out too soon.
     */
    let inFlight = false;
    let nudged = false;

    const tick = async () => {
      if (inFlight) {
        nudged = true;
        return;
      }
      inFlight = true;
      nudged = false;
      let wait = IDLE_MS;
      try {
        const { turn, jobs: running } = await api.live(
          sessionId,
          cursor.current.seq,
          cursor.current.turnId || undefined,
        );
        if (stopped) {
          inFlight = false;
          return;
        }
        setJobs(running ?? []);

        if (!turn) {
          setLive(null);
        } else if (turn.id !== cursor.current.turnId) {
          /**
           * A turn this client has not been following: take it whole — and the one it was following is over,
           * whether or not a poll caught it finished. A message the turn never read starts the next one the
           * moment it ends, so this can come between two polls; without a refetch the answer just written was in
           * neither the history nor the live slot until the tab was focused again.
           */
          const followed = cursor.current.turnId;
          if (followed && !settled.current.has(followed)) {
            settled.current.add(followed);
            void queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] });
            void queryClient.invalidateQueries({ queryKey: notesKey(sessionId) });
          }
          cursor.current = { turnId: turn.id, seq: turn.cursor };
          setLive(turn);
        } else {
          cursor.current = { turnId: turn.id, seq: turn.cursor };
          // Extend, never replace: the steps in this response are only the ones since the cursor.
          setLive((previous) =>
            previous && previous.id === turn.id
              ? { ...turn, steps: [...previous.steps, ...turn.steps] }
              : turn,
          );
        }

        // The agent rewrote its plan: the strip above the composer reads it again now, not when the turn ends (0.8.0).
        if (turn?.steps.some((step) => step.kind === "tool_done" && step.name === "plan")) {
          void queryClient.invalidateQueries({ queryKey: notesKey(sessionId) });
        }

        // Fast while something is happening, and fast while waiting for something to start.
        if (turn?.status === "running" || pendingRef.current) wait = streamed.current ? STREAMED_LIVE_MS : LIVE_MS;

        // The person's own message has arrived as a real turn; the placeholder can go.
        if (turn && pendingRef.current && turn.prompt.trim() === pendingRef.current.trim()) {
          setPending(null);
        }

        /**
         * A turn that has just ended, folded into the history exactly once.
         *
         * Once, because the transcript is what the finished turn is then rendered from, and a refetch
         * per poll would reload the whole conversation every second for as long as the tab is open.
         */
        // Before the history is asked for it: an ended turn's answer still to write out is held live (`useRevealing`).
        readForReveal(turn);
        if (turn && turn.status !== "running" && !settled.current.has(turn.id)) {
          settled.current.add(turn.id);
          void queryClient.invalidateQueries({ queryKey: ["transcript", sessionId] });
          void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          // The turn is where the agent writes its work notes, so the Notes panel is read again with the transcript.
          void queryClient.invalidateQueries({ queryKey: notesKey(sessionId) });
          // And where it starts a mission, which the strip above the composer lists while it works.
          void queryClient.invalidateQueries({ queryKey: ["missions", "chat"] });
        }

        // Sent, but nothing is running and nothing was recorded. Say so rather than spin.
        if (
          pendingRef.current &&
          turn?.status !== "running" &&
          Date.now() - pendingSince.current > START_GRACE_MS
        ) {
          setPending(null);
          setStartError(
            new Error(
              "Nouride took the message, but no agent started on it: check which agent answers this chat on the Agents page",
            ),
          );
        }
      } catch (err) {
        // A poll that fails is not an error worth showing: the next one is 700ms away, and a daemon
        // being restarted under a tab that is open would otherwise fill the screen with notices. A
        // 404 is different — the conversation is gone — and stops the loop.
        if (err instanceof ApiError && err.status === 404) {
          inFlight = false;
          return;
        }
      }
      inFlight = false;
      schedule(nudged ? 0 : visible.current ? wait : Math.max(wait, HIDDEN_MS));
    };

    void tick();
    return () => {
      stopped = true;
      wake.current = () => {};
      if (timer) clearTimeout(timer);
    };
    /**
     * `roomChatId` is in here, and leaving it out was a real bug.
     *
     * A room has no session id until an agent has taken a turn in it, so moving from one room to
     * another leaves `sessionId` `undefined` at both ends — the effect never re-ran, and the live
     * loop went on polling the room it was started for. The symptom was exact: the first message in
     * a room showed the bubble and nothing else, no working card, no steps, until the page was
     * reloaded. The daemon was reporting the running turn within two seconds the whole time.
     */
  }, [sessionId, roomChatId, queryClient, readForReveal, resetReveal]);

  const sendMutation = useMutation({
    mutationFn: (input: {
      text: string;
      attachments?: { path: string; mimeType: string; filename: string }[];
      page?: OpenPage;
    }) =>
      /**
       * No sender in the payload, deliberately.
       *
       * The daemon reads it from the login instead. A name a client asserts is a name a client can
       * make up, and this one reaches the agent's prompt — so it is the one thing about this request
       * that must not come from here.
       */
      api.chatSend({
        text: input.text,
        /**
         * A room is addressed by its chat and names no agent.
         *
         * Naming one would pin it: the daemon turns `agent` into a mention the message's own text
         * cannot override, which is right for a conversation with one agent in it and the opposite
         * of what a tag is for in a room.
         */
        ...(roomChatId
          ? { chatId: roomChatId }
          : {
              ...(sessionId ? { sessionId } : {}),
              ...(agentId ? { agent: agentId } : {}),
            }),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.page ? { page: input.page } : {}),
      }),
    onSuccess: (result, { text }) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      // A room stays where it is: it is already addressed by its chat id, and there is no session to
      // navigate to — a member's session appears only once that member has taken a turn.
      if (roomChatId) {
        void queryClient.invalidateQueries({ queryKey: ["transcript", "room", roomChatId] });
        wake.current();
        return;
      }
      /**
       * Polled again now that the daemon has it. A message read into the turn at work is on that turn's record
       * by the time the send returns (`steer-accept.ts` in the engine), and the poll `send` woke went out before
       * it was — so without this the person's own message appeared a beat after the box had already emptied.
       */
      if (result.sessionId === sessionId) {
        wake.current();
        return;
      }
      // A new conversation, or the same chat with a different agent. Carry the message across the
      // route change so it does not blink out of existence.
      justSent.set(result.sessionId, { text, at: Date.now() });
      onSession(result.sessionId, result.agentId);
    },
  });

  const send = useCallback(
    (text: string, attachments?: { path: string; mimeType: string; filename: string }[], page?: OpenPage) => {
      const trimmed = text.trim();
      // A message may be nothing but files — the same rule the daemon applies.
      if (!trimmed && !attachments?.length) return;
      setStartError(null);
      /**
       * Sent while this one-to-one chat's turn runs: the daemon reads it into that turn at its next step
       * (`pipeline/steering.ts` in the engine), so no turn of its own appears to clear a placeholder — one
       * set here would end as "no turn started". It is drawn from the running turn's record instead, with
       * what the agent said back. Words only, the daemon's rule: files and commands still start their own.
       */
      const steering = !roomChatId && live?.status === "running" && Boolean(trimmed) && !attachments?.length && !trimmed.startsWith("/");
      if (!steering) {
        setPending(trimmed || `${attachments!.length} file(s)`);
        pendingSince.current = Date.now();
      }
      sendMutation.mutate({ text: trimmed, ...(attachments?.length ? { attachments } : {}), ...(page ? { page } : {}) });
      wake.current();
    },
    [sendMutation, roomChatId, live?.status],
  );

  const stopMutation = useMutation({
    mutationFn: (input: { chatId: string; agent?: string }) =>
      api.stop(input.chatId, input.agent),
  });

  /**
   * The chat to stop in.
   *
   * A room is addressed by its own id and may have no session at all yet, so the room id comes
   * first — without it the stop button on the first turn of a new room had nothing to send.
   */
  const chatId = roomChatId ?? transcript.data?.session?.chatId ?? live?.chatId;
  const stop = useCallback(
    (agent?: string) => {
      if (chatId) stopMutation.mutate({ chatId, ...(agent ? { agent } : {}) });
    },
    [chatId, stopMutation],
  );

  // One decision, in one place — see `lib/display.ts` for what splitting it in two cost.
  const { history, live: liveShown } = splitForDisplay(transcript.data?.turns ?? [], live, revealing);

  return {
    session: transcript.data?.session ?? null,
    turns: history,
    earlier: transcript.data?.earlier ?? [],
    events: [...(transcript.data?.events ?? [])].sort((a, b) => a.at - b.at),
    messages: transcript.data?.messages ?? [],
    liveTurns: roomChatId ? liveTurns : liveShown ? [liveShown] : [],
    reveals,
    jobs,
    pending,
    startedHere,
    /**
     * Something is running here.
     *
     * A room's answer comes from its own feed, not from `live` — which the room loop never sets, so
     * the composer's stop button and the "busy" styling were dead in a room and the send button
     * stayed enabled while two agents worked.
     */
    busy:
      (roomChatId
        ? liveTurns.some((turn) => turn.status === "running")
        : live?.status === "running") ||
      sendMutation.isPending ||
      Boolean(pending),
    loading: transcript.isLoading,
    streaming,
    error: startError ?? (sendMutation.error as Error | null),
    send,
    stop,
    clearError: () => {
      setStartError(null);
      sendMutation.reset();
    },
  };
}
