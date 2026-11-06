# The event stream

What a turn does — its start and end, each step, the answer as it is written, each tool call as audited and each
model call as metered — reaches anything watching as one append-only stream of rows. The dashboard follows it, `nouride
events` prints it, and an editor can drive a conversation on it. This page is its contract: what a row is, what each
kind carries, what a reader can rely on, and how it may change. The source of truth is `EVENT_CONTRACT` in
`packages/shared/src/types/events.ts`; `apps/engine/tests/contracts/events-contract.test.ts` holds this page, the
daemon's writers and the dashboard to it.

**Protocol 1.5** (Nouride 0.8.0; 1.4 from 0.7.26, 1.3 from 0.7.14, 1.2 from 0.7.11, 1.1 from 0.7.10, 1.0 from 0.7.6).
`GET /events` answers `version`, `/health` answers `eventProtocol`, and both routes send `x-event-protocol: 1.5`. A reader compares
the major.

## Reading it

| | |
|---|---|
| `GET /api/control/events` | A page, oldest first: `{version, oldest, latest, events, next}`. `next` is the cursor to ask from; `oldest` and `latest` are the first and newest `seq` there are. `newest=1` answers the newest page instead, still oldest first. |
| `GET /api/control/events/stream` | `text/event-stream`: the rows after the cursor, then each as it is written. |
| `nouride events [-f]` | The same, printed; `-f` follows from now — or from `--since` — and resumes where it was when the connection drops. |

Filters, on both routes: `since` (the cursor), `turn` (one turn), `chat` with `gateway` (one conversation — a chat on
one connection; `chat` alone is that chat on any; `gateway` alone names nothing and is not read), `kinds`
(comma-separated), `limit` (a page, at most 1,000). `tail=1` starts a stream at the newest row; `frames=1` asks for
the control frames below.

The stream's framing: it opens with `retry: 3000` — then, to a reader that asked for frames, `hello` and any `reset` or
`gap` — then an id-only block: `id: <cursor>`, the cursor the stream starts from, which sets a browser's `Last-Event-ID` without an event, so
a drop before the first row resumes there.
Each row is one unnamed event, `id: <seq>` and `data: <row as JSON>`; a comment line, `: keep-alive`, every fifteen
seconds. A reconnect sends the last id as `Last-Event-ID` and gets what came after it.

The stream goes at the reader's pace: the replay is read a page at a time as the reader takes it, and stops at 5,000
rows — the stream goes on from the newest row, and a page of `GET /events` from the cursor has the rest. A reader that
lets 2,000 new rows pile up unread is closed; its last id brings it back with nothing missed.

### Control frames (1.1)

Named events, sent only when a stream is asked for with `frames=1`. A reader that skips named events — a browser's
`onmessage`, `nouride events` before 0.7.10 — never sees one.

| Frame | When | `data` |
|---|---|---|
| `hello` | First, before any row | `version` `oldest` `latest` `epoch` |
| `reset` | The cursor is past the newest row: the database went back to an older state. Start over from `latest` | `latest` |
| `gap` | Rows after `since`, up to and including `until`, this stream will not send: `swept` with their turns' retention, or `capped` — page `GET /events` from `since` | `since` `until` `reason` |
| `bye` | The daemon is ending the stream: `shutdown` — reconnect once it is back; `slow` — reconnect now | `reason` |
| `thinking` (1.2) | A model call of a turn the stream follows is under way — `thinking`, `generating · 4.1 KB` — at most one every three seconds of generation. Not a row: no `id`, never written, never replayed | `turnId` `text` |

`epoch` names the life of the database the cursors belong to. It changes when the database is restored to an older
state — `nouride db restore`, an update's rollback — whose next rows reuse numbers a reader already holds: a reader
that kept the epoch it last saw drops what it holds when `hello` brings another.

## A row

| Key | |
|---|---|
| `seq` | The cursor. Only increases, never reused, not contiguous. |
| `at` | When it was written, milliseconds since the epoch — wall-clock time, not an order. |
| `turnId` | The turn it belongs to. |
| `agentId`, `gatewayId`, `chatId` | Whose turn, on which connection, in which chat. |
| `kind` | One of the kinds below. |
| `data` | What the kind carries. |

## The kinds

Steps are the kinds with a `step`: numbered within their turn from 1 — a different counter from `seq` — and read back
as the turn's step log. A key marked `?` may be absent.

| Kind | When | `data` |
|---|---|---|
| `reasoning` | The model's own account of what it is working out | `step` `text` `via?` `by?` |
| `tool` | A tool call started — a coding CLI's says the tool of Nouride's it is `like` | `step` `text` `callId` `name` `like?` `via?` `by?` |
| `tool_done` | A tool call ended: how it went, how long it took | `step` `text` `callId` `name` `error` `outcome?` `via?` `by?` |
| `note` | The daemon remarking — calls at once, output kept in a file; `capped` marks the step log reaching 500 | `step` `text` `capped?` `via?` `by?` |
| `waiting` | Parked on a person, an approval | `step` `text` `callId?` `name?` `approvalId?` `via?` `by?` |
| `steer` | A message sent while the turn worked, once read; `editOf`, the sender's edit of the message it names | `step` `text` `editOf?` |
| `steer_reply` | What its sender was told back at once | `step` `text` |
| `retry` | A model call asked again, said while the wait happens | `step` `text` `reason` `from?` `to?` `failure?` `attempt?` `maxAttempts?` `delayMs?` `status?` `dropped?` `via?` `by?` |
| `compact` | The conversation made to fit | `step` `text` `phase` `turns?` `tokens?` `pruned?` `dropped?` `via?` `by?` |
| `turn` | A turn's start, a command's answer, or its end; `editOf` on a start, a turn answering a person's edit; `via` and `by` on a start, a delegate's own turn | `phase` `sessionId?` `prompt?` `messageId?` `senderId?` `editOf?` `status?` `reply?` `replyChars?` `error?` `model?` `toolCalls?` `inputTokens?` `outputTokens?` `via?` `by?` |
| `context` | What one model request of the turn carried (1.4) — not a step | `request` `estimatedTokens` `cleared` `keptAt?` `summary` `notes` `via?` `by?` |
| `unstep` | Steps taken back off the turn | `steps` |
| `reply` | The answer's new text since the last row | `from` `text` |
| `audit` | A tool call as the audit log keeps it | `callId?` `tool` `args` `error?` `threw?` `ms` `secrets?` |
| `usage` | A model call made on the turn's behalf, as metered | `model` `provider` `inputTokens` `outputTokens` `usd?` `estimated?` `cachedInputTokens?` `cacheCreationInputTokens?` `latencyMs?` `attempts?` `upstream?` `purpose?` `basis?` `priceAsOf?` `durationMs?` `stopReason?` |

Values that are one of a few: `retry.reason` is `provider` (refused or failed, asked again after `delayMs`; `failure`
is the class — `rate_limit`, `overloaded`, `transient`, `timeout`, `network` — never what the provider said),
`context_overflow` (asked again with `dropped` earlier messages left out), `audio_refused` (asked again without a
voice note) or `fallback` (1.7: the model failed with `failure` and the next of the agent's chain answers — `from` the
model that failed, `to` the one asked). `compact.phase` is `start`, then `done` or `failed`, around a summary of `turns` earlier turns of about
`tokens`; or `trimmed` (`dropped` messages left out of the request) or `pruned` (`pruned` old tool results cleared).
`turn.phase` is `start`, `note` (a command's answer, written whole) or `end`, with `status` one of `done`, `failed`,
`cancelled`, `interrupted`. `tool_done.outcome` (1.1) is how a call ended: `ok`; `exit`, a command that ran and
answered with a non-zero exit — `which` saying no; or `failed`, `timed_out`, `killed`, the call not doing its job.
`error` is true for all but `ok`; a reader deciding what is a fault reads `outcome`, never the line's words.
`usage.purpose` (1.1) is what the call was for: `turn` — the turn's own — `helper`, `peer`, `steer_reply`, and the
work the turn set off, `compaction` and `reflection`; `memory`, `embedding`, `vision` and `transcription` name the
rest a turn may have caused; `second_look` (1.5) is the check on what work nobody watches sends out; `side_question` (1.8) a `/btw` answered beside the turn, in a session of its own. `usage.basis` (1.1) is how it is billed: `list`, priced from the vendor's page as of
`priceAsOf`; `included`, a subscription (`billing = "included"` on the profile) — `usd` 0, outside the dollar cap;
`unpriced`, a model the price book does not list — no `usd` at all; or `cli` (1.6), a coding CLI's prompt as it
reported it over ACP, on the CLI's own account — `usd` 0, outside both daily caps. A clip transcribed carries `durationMs` and
no tokens. `usage.stopReason` (1.4) is why the provider says the call ended: `stop`, `tool_calls`, `max_tokens` — a
reply cut at the output limit, said even when it carried tool calls — or `error`, the provider saying generation
failed. Absent when the provider gave no reason, and on a call that is no generation: never a guessed `stop`.
`context` (1.4) is written before each model request of a turn — each round, each wrap-up — and says what the request
carried, never the request itself: `estimatedTokens`, the daemon's estimate of its size at the scale the provider
last measured (the provider's own count for the call is its `usage` row); `cleared`, how many earlier tool results in
it were cleared to make room, and `keptAt`, the files those cleared since the line before were kept at (at most 20);
`summary`, whether a compaction's summary of earlier turns was in it; `notes`, whether the agent's notes were.
`request` counts the turn's requests from 1 and is no step number. A waited-on helper's or peer's are written into the
turn that waits on it, marked `via` and `by`, as its steps are.

## What a reader can rely on

- **A row is announced only once it is committed,** and a row that is rolled back is never announced. The rows of one
  tool result — its `audit` row, then its `tool_done` — commit together, in that order.
- **`callId` pairs** a `tool`, its `tool_done` and its `audit` row, and a `waiting` for that call. It is unique within a
  turn: the daemon makes one up when a provider gives none, or gives one twice. Never pair by order. Rows written
  before 0.7.6 carry no `callId` or `name` — nor do the steps of turns recorded before 0.7.4, copied into the stream
  by 0.7.10 with their own times and `{step, text}` alone: a reader shows those unpaired.
- **A wait names its approval** (1.2): `waiting.approvalId` is the request the turn waits on — answer it with
  `POST /approvals/:id/allow-once`, `allow-always` or `deny`. The row is written once the request exists and before it
  is shown in the chat. A call that takes an answer already given waits on nobody and writes no `waiting`.
- **Work a turn hands off is the turn's** (1.2): a helper started with `delegate` and an agent asked with `ask_agent`
  write their steps into the turn that started them — numbered on in its log, in its conversation, their calls'
  `audit` rows under it — marked `via` (`delegate` or `ask_agent`) and `by` (the agent that took the step: the turn's
  own for a helper, which runs as it; the peer for `ask_agent`). Their lines say it too, `↳ ` for a helper and
  `[nox] ` for a peer. A reader that knows neither key shows them as the turn's steps. Their `callId`s are the turn's
  like any other: unique within it. A helper started with `background: true` (0.7.15) is not: the turn that started
  it has ended before it works, so its steps are its job's log (`nouride jobs log`), and what it hands back arrives
  as a turn of its own — a job's wake-up, headed by its cause. Nor is an ask once it moves to the background (0.7.19):
  its steps up to then are the asking turn's rows, and from then on its job's log; its answer arrives as the asking
  agent's wake-up.
- **Work in the background is a turn of its own** (1.4): a helper started with `background: true`, and an ask from the
  moment it moves there, is also recorded as a turn — in the chat it works for, its start marked `via` (`delegate` or
  `ask_agent`) and `by` (whose turn it is), its steps rows of it, unmarked, and its end carrying the report it handed
  back as `reply`. It is no turn of the conversation: a reader drawing the conversation leaves out a turn whose start
  has `via`, and every row of it — `nouride chat` does. Its model calls' `usage` rows and its calls' `audit` rows
  stay the turn's that started it.
- **A scheduled run is a turn of its own** (1.2): a `cron` job's turn has its `turn` start and end and its steps, in
  the conversation it runs in — the job's target chat for a job kept in that chat's history, `cron:<job>` otherwise.
- **An edit says so** (1.3): a person editing a message they sent reaches the agent, and the rows name the message
  edited, `editOf`. A turn's start carries it when the turn answers an edit — `messageId` the same message when it was
  edited while it waited and is answered as corrected, a turn of its own when it was edited after it was answered. A
  `steer` carries it when the turn read the edit as it worked, and its line starts `✎ `.
- **`unstep` takes back** steps already written. Nothing is deleted; leave those numbers out.
- **The answer:** `reply.from` is a splice offset — the answer so far is `text.slice(0, from) + data.text`. A `reply`
  row holds at most 2,000 characters and is never cut: a longer chunk comes as several rows, each with its own `from`,
  and the rows add up to everything streamed, the last few characters before the end included (1.1). The end's
  `reply` (cut at 4,000 characters) and `replyChars` are the authority on what was sent; a command's answer (`note`)
  carries `replyChars` too.
- **The end:** every turn ends — `turn` with `phase` `end`, or `note` for a command's answer, closes the turn and any
  tool still open in it. A turn a restart cut off ends `interrupted` when the daemon comes back; one taken up again
  after it is a new turn. `compact` and `usage` rows of a turn may come after its end — the daemon compacts and meters
  after replying.
- **Too large to keep:** a row over 8,000 characters of JSON has its strings cut, never its identity keys (`step`,
  `callId`, `name`, `approvalId`, `phase`, `status`, `from`, `reason`, `request`); each value keeps its type, and the row says `truncated: true`
  with the keys cut in `cut`. A step's `text` and a turn's `prompt` are cut at 2,000 characters, and say so the same way.
- **The audit log keeps its own row** of each call, beside the `audit` event, on purpose: it is the security record,
  kept `[retention] audit_days` with what no turn does (sign-ins, config and access changes), while the event is the
  turn's history and goes with the turn — a conversation deleted takes its events, never the audit trail.
- **Retention:** rows are kept as long as the turns they belong to, `[retention] session_days`. Deleting a
  conversation deletes its rows. A cursor older than what is kept resumes at the oldest row there is — with a `gap`
  saying what was swept, to a reader that asked for frames.
- **Loss is said:** a row the daemon could not write — a full disk — is counted and named in `/health`'s issues.

## Beside the stream

Two read routes still serve a turn's progress, and stay — decided for 0.7.11:

- **`GET /sessions/:id/live` and `GET /rooms/:chatId/live`** answer the dashboard's live view: the newest turn (or
  every running one, in a room) with its steps, each step's duration on the daemon's clock, and the background jobs
  behind it. The dashboard draws from them; the stream only tells it when to ask (`use-event-stream.ts`). They are a
  computed view the stream does not carry — durations, running jobs, the newest turn even once it ended — and a
  0.7.10 tab left open across an update polls them, so they are **kept**, not merged into the stream: merging would
  move turn assembly into the browser, a change nothing planned asks for. They read the same rows the stream
  writes (`turns.stepsSince`), so the two cannot disagree on a step.
- **`GET /activity`** is gone since 0.8.0: 404. `nouride chat` follows the stream since 0.7.11; through 0.7.x the
  route answered an older CLI from the stream in its old shape. A `nouride chat` from before 0.7.11 pointed at a
  0.8.0 daemon (`NOURIDE_URL`) gets the 404, which it reads as a daemon older than itself.

## How it changes

- **Additive only within a major version.** A kind or a key is never removed, renamed, retyped or given a second
  meaning, and an identity key is never cut. A new key is optional; a new kind is allowed. Either is a minor version
  (1.0 → 1.1) and a line in [contracts/EVENTS_CHANGELOG.md](./contracts/EVENTS_CHANGELOG.md).
- **A reader ignores a kind, a key and a value it does not know** — and a writer never relies on a reader knowing a
  new one.
- **A breaking change is a new major version**, announced a release ahead, with a new frozen baseline beside
  [contracts/events.v1.json](./contracts/events.v1.json). Within 1.x, `contracts/events.lock.json` may only add to it.
