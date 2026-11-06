# The event stream's contract — changes

Every change to [events.lock.json](./events.lock.json) is a line here, under the version that made it. The rules are
in [../EVENTS.md](../EVENTS.md); `apps/engine/tests/contracts/events-contract.test.ts` refuses a version with no
heading here.

## 1.8 — Nouride 0.8.17

- `usage.purpose` may be `side_question`: a `/btw` answered beside the turn, read-only and kept out of the
  conversation, metered in a session of its own (`<conversation>:btw`), never in the running turn's record. A reader
  that knows no such purpose counts it as a call.

## 1.7 — Nouride 0.8.12

- `retry.reason` may be `fallback`, with `from` and `to`: the model failed with `failure`, and the next model of the
  agent's chain answers instead — `from` the model that failed, `to` the one asked. Written since fallback chains
  shipped and missing here, so every such row logged "an event row the contract does not describe". A reader that
  knows no such reason reads the row by its `text`.

## 1.6 — Nouride 0.8.8

- `tool` may carry `like`: a coding CLI's step, the tool of Nouride's its kind is like — `exec`, `read`, `edit`,
  `search` or `web_fetch` — where its `name` is the CLI's own (`Bash`). Written since 0.8.5 and missing here, so every
  such row logged "tool.like is not in the contract". A reader that knows no `like` reads the step by its `name`.
- `usage.basis` may be `cli`: a coding CLI's prompt, as the CLI reported it over ACP — the tokens of the whole prompt,
  its cache read and written counted in `inputTokens` — on the CLI's own account. `usd` is 0 and the call is outside
  both daily caps. `provider` is the CLI's id. A reader that knows no such basis counts it as a call.

## 1.5 — Nouride 0.8.0

- `usage.purpose` may be `second_look`: the call that weighs what work nobody watches is about to send out against
  what the work is for, metered under the turn it guards. A reader that knows no such purpose counts it as a call.

## 1.4 — Nouride 0.7.26

- `usage` carries `stopReason`: why the provider says the call ended — `stop`, `tool_calls`, `max_tokens` or `error`.
  `max_tokens` is a reply cut at the output limit, said even when the cut reply carried tool calls. Absent when the
  provider gave no reason, and on a call that is no generation (an embedding, a clip transcribed).
- Work in the background is a turn of its own: a helper started with `background: true`, and an ask once it moved
  there, write a `turn` start marked `via` (`delegate` or `ask_agent`) and `by`, their steps, and an end whose `reply`
  is the report they handed back — in the chat they work for, and no turn of its conversation: a reader drawing it
  leaves out a turn whose start has `via`. Their `usage` and `audit` rows stay the turn's that started them.
- A kind, `context`: written before each model request of a turn, what the request carried — `request` (from 1, an
  identity key), `estimatedTokens`, `cleared` and `keptAt` (the tool results cleared out of it, and where those newly
  cleared were kept), `summary`, `notes`; `via` and `by` for a helper's or a peer's inside the turn that waits on it.
  Not a step. A reader that knows no `context` passes it over.

## 1.3 — Nouride 0.7.14

- A person's edit of a message they sent reaches the agent (G11), and the rows say so with `editOf`, the platform id of
  the message edited. On a `turn` start: the turn answers an edit — of its own `messageId`, edited while it waited and
  answered as corrected, or of an earlier message, answered after the edit as a turn of its own. On a `steer`: the turn
  read the edit as it worked; its line starts `✎ `, for a reader that knows no `editOf`.

## 1.2 — Nouride 0.7.11

- `waiting` carries `approvalId`, the request it waits on — what `POST /approvals/:id/:decision` answers — and is
  written once that request exists, before it is put in front of anybody. A call that takes an answer already given
  waits on nobody and writes no `waiting`; nor does a scheduled run, whose gate refuses at once.
- A helper's (`delegate`) and a peer's (`ask_agent`) steps are rows of the turn that started them, in its
  conversation, with `via` and `by` on `reasoning`, `tool`, `tool_done`, `note`, `waiting`, `retry` and `compact`, and
  their lines marked `↳ ` or `[<agent>] `. Their calls' `audit` rows are the turn's, and their `callId`s unique in it.
- A scheduled job's turn is written like any other: `turn` start and end, and its steps.
- A control frame, `thinking {turnId, text}`, to a stream asked for with `frames=1`: a model call of a turn the stream
  follows is under way. Not a row — no `id`, kept nowhere, not replayed. `nouride chat` draws it; it read the daemon's
  in-memory activity feed (`/activity`) before, which this replaces.

## 1.1 — Nouride 0.7.10

No kind changes. What a reader is told about the stream itself:

- Control frames, to a stream asked for with `frames=1`, each a named event: `hello` first — `version`, the
  `oldest` and `latest` `seq` there are, and the database's `epoch`, which changes when the database is restored to an
  older state; `reset {latest}` for a cursor past the newest row; `gap {since, until, reason}` for rows the stream
  will not send — `swept` with their turns, or `capped`, more than one stream replays; and `bye {reason}` before the
  daemon ends a stream — `shutdown`, or `slow` for a reader that let too many rows pile up.
- Every stream, asked or not: an id-only block right after `retry:` with the cursor it starts from.
- `GET /events` answers `oldest` and `latest` beside `version`; `/health` answers `eventProtocol`.
- A replay stops at 5,000 rows and goes on from the newest — said by `gap` to a reader that asked for frames.
- `GET /events?newest=1` answers the newest page, still oldest first.
- `tool_done` carries `outcome`: `ok`, `exit` (a non-zero exit — an answer), `failed`, `timed_out` or `killed`.
- `usage` carries `purpose` — `turn`, `helper`, `peer`, `steer_reply`, `compaction`, `reflection`, `memory`,
  `embedding`, `vision` or `transcription` — `basis` — `list`, `included` (a subscription: no cost per token) or
  `unpriced` — `priceAsOf`, the day the price was read, and `durationMs` for a clip transcribed. A turn's compaction
  and reflection are `usage` rows of it now, where they were metered nowhere.
- What the rows of a turn promise, held by the writers: `reply` rows of at most 2,000 characters, never cut, adding up
  to the whole streamed answer; a turn a restart cut off ends `interrupted`; a step's `text` and a `prompt` cut at
  2,000 characters say `truncated` and `cut`; a command's answer carries `replyChars`.
- The steps of turns recorded before 0.7.4 are rows of the stream, copied in once with their own `at` and
  `{step, text}` alone — no `callId` or `name`, as no row written before 0.7.6 has. `seq` is SQLite's `AUTOINCREMENT`
  from here: never handed out twice, whatever is deleted.

## 1.0 — Nouride 0.7.6

The first version, frozen as [events.v1.json](./events.v1.json). From what 0.7.4 and 0.7.5 wrote:

- `tool` and `tool_done` carry `callId` and `name`; `tool_done` carries `error`; `waiting` carries `callId` and `name`
  when it waits on a call. `callId` is unique within a turn.
- `retry` and `compact` are kinds of their own, where they were `note` lines.
- The note that says the step log reached its cap is a `note` with `capped`, where it was a `waiting`.
- `audit` carries `callId`, and is written with its `tool_done`, in the same transaction, right before it.
- A row too large to keep keeps its identity keys and the type of every value, and lists what was cut in `cut`.
- `GET /events` answers `version`; both routes send `x-event-protocol`.
- `usage` carries its turn's `gatewayId` and `chatId`, as every other row of a turn does, so a reader following
  one conversation gets its model calls.
