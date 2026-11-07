# Adding or changing a chat platform

A gateway adapter has one job: turn a platform's messages into `MessageEnvelope`, and turn
`OutboundMessage` back into whatever that platform wants. **Every platform quirk stops
here.** The engine hands `send()` arbitrary text; if Discord caps replies at 2000 characters,
the Discord adapter splits them.

---

## What you implement

Extend `BaseGateway` and provide four primitives. Everything else — the retry loop,
exponential backoff with jitter, the bounded outbound buffer, health checks, status events —
is inherited. Three copies of that logic would have drifted apart within a month.

```ts
export class MyGateway extends BaseGateway {
  constructor(private readonly options: MyGatewayOptions) {
    super(options, options.resilience);   // options extends GatewayIdentity
  }

  protected async connect(): Promise<void>          // throw to fail; the retry loop handles it
  protected async disconnect(): Promise<void>       // must not throw — runs during shutdown
  protected async deliver(msg: OutboundMessage)     // chunking, escaping, upload
  protected async ping(): Promise<boolean>          // false counts toward the failure threshold
  override async setTyping(chatId: string)          // optional; default is a no-op
}
```

Then add a case to `createGateways` in `packages/gateways/src/index.ts` and a platform entry
to `PLATFORMS` + `DEFAULT_GATEWAY_RESILIENCE` in the engine config.

### Validate credentials in `connect()`

`await bot.init()` for grammY, waiting on `ClientReady` for discord.js. A wrong token must
fail `connect()` so the caller sees it; a library that discovers the problem later just loops
in the background with nothing in the log that names the cause.

### Emit, do not answer

`this.emitMessage(envelope)` and let the engine decide. An adapter never calls the router,
never reads agent config, never formats a reply beyond platform mechanics.

Call `this.handleDisconnect(reason)` when the library reports a dropped connection, and
`this.handleSessionExpired()` when credentials stop being usable (WhatsApp QR).

---

## Envelope rules

```ts
{
  gateway: "telegram",          // platform — for formatting decisions only
  gatewayId: "telegram:nouva",  // instance — for session identity and routing back
  chatId, chatType, senderId, senderName, text, replyTo?, mentions?, raw
}
```

- **`gatewayId` is the instance, and it is what keys a conversation.** Chat `12345` on one bot
  has nothing to do with `12345` on another.
- **Fold threads into `chatId`.** A Telegram topic becomes `${chat.id}:${thread}`; a Discord
  thread already has its own channel id. Otherwise every topic in a forum shares one context.
- **Drop your own messages.** Some platforms echo them back, and answering them is how loops
  start. Discord drops *every* bot author, not just itself — two Nouride agents in one channel
  would otherwise talk to each other indefinitely.
- **Drop empty text — unless the message tagged us.** A sticker or a join event is not a turn; `@Nouva`
  with nothing behind it *is*, and it is the most common way anyone addresses a bot in a busy channel.
  Discord strips its own leading tag (so the model does not read its own name as every message's first
  token), which left that message an empty string and dropped it — tagging an agent with no words did
  nothing at all, twice, live, and looked exactly like the bot being down. The decision is
  `worthDelivering()`, extracted so it can be tested without a live `Message`.
- **`raw` is the original payload**, kept for platform-specific features. It is never sent to
  the model.
- **A person's edit is an envelope too** (G11): `edit.of` is the platform's id of the message it changes, `text` and
  `mentions` what that message says now, `edit.sentAt` when it was first sent where the platform says, and `id` the
  edit's own — the claim, the inbox and the queue know a message by its id, and the same edit delivered twice must be
  the same id (Telegram: `<id>:edited:<edit_date>`; Discord: `<id>:edited:<editedTimestamp>`; WhatsApp: the protocol
  message's own key). Words only, a person's only, and only a real edit: Discord updates a message when an embed loads,
  and only an edit moves `editedTimestamp`. Where the message is and what the edit then does is the engine's
  (`pipeline/edits.ts`) — an adapter never looks.
- **`mentions` is raw names or ids**; the router matches them against agent ids and display
  names. Do not try to resolve agents in the adapter.

---

## Rooms — the standard every platform follows (0.7.24)

Adding Slack, Mattermost, Teams or the next one is an adapter, not a redesign, because a room means the same thing
everywhere. `docs/ARCHITECTURE.md` §13 is the model; this is the checklist.

- [ ] **`chatId` is the room where one conversation lives.** A group, a channel, a DM. **A thread is its own room**:
      its own id (Discord gives one), or folded into `chatId` (Telegram: `${chat}:${topic}`; Slack would be
      `${channel}:${thread_ts}`). Never a server, guild or workspace — that level is not modelled; two channels in one
      workspace are two unrelated rooms.
- [ ] **`chatType`**: `dm` for one person, `group` or `channel` for a room. Only a DM is answered unaddressed by default.
- [ ] **`roomTitle(chatId)`** — optional, and the engine tests for the method, never the platform. Return the room's own
      name as people see it: a group's subject or title, a channel as `#name`, a thread by its own name. Never the
      workspace or server name, nothing for a DM, `undefined` when unknown — and never throw for a room the bot cannot
      see. The engine asks only when it has no name or a day-old one and does not wait for the answer, so a fetch is
      fine; cache what is cheap to cache (WhatsApp's subject is fetched by the bridge beside the message).
- [ ] **`threadOpener`** — optional, on a message in a thread that was started from another message: who wrote that
      message (`senderId`, `senderName`), its text, and `where` (the parent room's `roomTitle`). Fetch it once per
      thread; never for the message that *is* the thread's start. The engine uses it on the conversation's first turn only.
- [ ] **`mentionsSelf` and `repliesToSelf`**: the platform tagged this connection's own bot, or the message replies to
      one its bot sent. The adapter answers both from its own id — never exports the id for the engine to compare — and
      a reply's ping is not a tag. Without `repliesToSelf` a reply to the agent reaches nobody after a restart, in a room
      that needs a mention.
- [ ] **`senderName` is the platform's display name**, and `senderId` the account id `[[people]]` holds. The engine
      replaces the name with the person's `[[people]]` name wherever it shows one (`speakerName`) — the adapter never looks
      people up.

What comes free once those hold: a conversation per room per agent, its background chatter, `/mention`, its memory
file, its row on the Groups page with its name and a rename, `send_message` by that name, and the room's name in the
agent's prompt.

---

## Outbound rules

- **Chunk on natural boundaries.** `chunk(text, limit)` in `packages/gateways/src/commons/text.ts` tries paragraph, then
  line, then a hard cut, and only accepts a boundary past the halfway mark so one long line
  cannot produce a tiny fragment followed by a full one. Reuse it.
- **Only the first chunk quotes the trigger.** Repeating the quote on every part of a long
  answer is unreadable.
- **`setTyping` failures are swallowed.** A typing indicator is decoration; failing to show it
  must never fail the turn.
- **A failed `deliver` on a socket believed healthy is evidence it is not.** `BaseGateway`
  buffers the message and starts the reconnect cycle rather than losing it to an exception the
  caller cannot act on.

### Buttons — a capability, declared

A platform difference the engine needs to know about is declared on the adapter, never asked of its id (invariant 2):
`promptsApprovals`, `progressStyle`, `echoesOwnMessages`, and since 0.7.14 `buttons` (G11). An adapter that says
`buttons = true` promises three things:

- `deliver` puts `OutboundMessage.buttons` under the message — one row, on its last part — and an adapter without the
  capability sends the text alone, so whoever asks something says how to answer it in words too;
- a press goes to `answerPress(press)` (`BaseGateway`; the engine registers the handler with `onPress`), and the answer
  is carried out the platform's way: `notice` to the presser alone, `settled` as the message rewritten without its
  buttons. Always acknowledged, whatever comes back — Telegram shows a spinner until `answerCallbackQuery`, and Discord
  fails an interaction not acknowledged in three seconds;
- `settleButtons(chatId, messageId, text)` rewrites a message it sent and takes its buttons away, for a question
  answered somewhere else.

`data` is opaque to the adapter — what a press means is the engine's (`tools/approval-prompts.ts`). Keep it under 64
bytes: Telegram refuses more.

---

## Platform notes

**Discord** — `discord.js`. Needs the **MESSAGE CONTENT** privileged intent enabled in the
developer portal, or every message arrives with empty content, which reads as a silent bug
rather than a missing checkbox. `Partials.Channel` is required or DMs are dropped. `ws.ping`
of `-1` means no heartbeat has completed yet, which is not the same as alive.

### The reconnect must tear down first

`attemptConnect` calls `disconnect()` before `connect()`, and that line is load-bearing rather than
tidy. Without it a retry builds a *second* live connection beside the one just declared broken. On a
platform that tolerates two that is a leak; on Telegram it is fatal, because long polling allows exactly
one `getUpdates` per token:

```
sendPhoto fails once  ->  handleDisconnect  ->  connect() while the old poll is still open
                      ->  Telegram terminates the old poll and answers it 409
                      ->  that reads as another dropped connection  ->  connect() again
                      ->  ... one 409 per attempt until the budget runs out, inbound dead
```

That ran for an hour on a live box and the log blamed "another bot instance" — the other instance was
this daemon's own previous poll. A new adapter's `disconnect()` must therefore be idempotent *and*
actually drain: Telegram awaits `bot.stop()`, which waits for the in-flight request to end.

### A replaced connection does not get to report a problem

A superseded instance keeps its handlers and its in-flight request, and its failure lands *after* the
replacement is healthy. Acted on, it tears down the connection that just succeeded. All three adapters
guard it — Telegram with `this.bot === bot`, Discord with `this.client === client` on `Error` and
`ShardDisconnect`, and the WhatsApp bridge, which learned it first as "a replaced socket kept its
listeners and a second `close` started another reconnect".

Two things make the guard real rather than decorative:

- **Assign the instance before you start it**, not after the connect resolves. Otherwise the check is
  false for the whole of login and the guard swallows exactly the failures it must not — and a login
  that times out leaves a live connection `disconnect()` cannot see to destroy.
- **The stakes differ per platform, the guard does not.** On Discord an abandoned client is wasteful:
  its duplicate deliveries are already absorbed by the pipeline's claim table, so the symptom is a leak
  and some flapping. On Telegram the abandoned poll is *guaranteed* to fail, because the replacement is
  what terminates it — which is how a leak became an hour of dead inbound.

### A failed send is evidence, not a verdict

`send()` buffers and then *probes* (`ping()`) instead of calling `handleDisconnect` outright. Outbound
and inbound are separate requests: one upload losing its connection says nothing about the poll, and an
upload is the most likely request to fail on its own — it carries megabytes where a poll carries a few
bytes. A healthy probe flushes the buffer immediately, so nothing is stranded by not reconnecting; a
failed one reconnects, reaching the same conclusion the health timer would have up to a whole interval
sooner.

### Some failures cannot be retried fast

`handleDisconnect(reason, settleMs)` sets a floor on the next delay. Telegram passes 35s on a 409,
because Telegram holds the `getUpdates` session open server-side for ~30s after the client leaves — the
generic backoff starts at 1s, so the first attempts were doomed by arithmetic however clean the local
teardown was. A floor rather than a fixed delay, so a long backoff late in the budget is not shortened
by it. It belongs to the *failure*, so only the adapter that read the error can ask for one.

---

**Telegram** — grammY, long polling. **Privacy mode is on by default and it silently disables group
context**: the Bot API delivers only messages that tag the bot or are commands, so the room buffer
stays empty and the feature reads as broken rather than unconfigured. `/setprivacy` → Disable in
@BotFather, or make the bot a group admin. There is nothing to log here — the daemon cannot tell a
quiet room from an undelivered one.

`drop_pending_updates` is true only on the **first** poll of the process and false on every reconnect: a
boot backlog can be arbitrarily old, but a reconnect backlog is seconds old with somebody watching the
chat. It was unconditionally true, so every reconnect silently discarded whatever arrived while the
gateway was down — two "tes" messages during an hour-long outage got no reply even after it recovered,
which reads as being ignored rather than as an outage.

`bot.start()` resolves only when polling *stops*, so it
must not be awaited in `connect()`. Errors surface in `bot.catch`; anything other than a 400
is treated as a suspect connection. Commands in groups arrive as `/new@botname`, which
`parseCommand` strips. Webhook mode is refused at config parse time while unimplemented —
better than a connect-time failure that looks like a network problem.

**WhatsApp** — **not** a Baileys integration. It is a client of `packages/wa-bridge`, a
workspace member that every edition compiles into the daemon and runs in-process
(`apps/engine/src/modules/gateways/bridge.ts`). Read `packages/wa-bridge/README.md` before
touching it. The coupling is the
newline-delimited JSON protocol in `packages/shared/src/types/bridge.ts`, hand-copied on the
bridge side; **do not replace that copy with an import** — the duplication *is* the boundary. The
`hello` handshake checks a version so drift fails loudly.

---

## Testing an adapter

The platform libraries need a live connection, so adapter internals are the least
unit-testable part of the repo. What is testable, and worth testing:

- **Pure helpers.** `chunk()`, chat-id splitting, mention extraction, envelope mapping from a
  captured payload. Put a real payload in the test rather than inventing one.
- **The engine side, with `FakeGateway`.** It implements the real `Gateway` interface, so
  `apps/engine/tests/pipeline/pipeline.test.ts` drives routing, queueing and replies without any
  platform at all.
- **Resilience, with a subclass.** `backoffDelay` is pure and tested in
  `packages/shared/tests/gateway.test.ts`; a fake subclass whose `connect()` fails on demand
  exercises the retry loop without a network.

If you cannot verify an adapter live — no bot token — **say so explicitly** rather than
letting a green suite imply the platform works.

---

## Not going quiet

A turn can run for minutes: several provider round-trips, a tool that shells out, a human being
asked to approve something. Silence in a chat reads as *broken*, not *busy*, and that impression is
the one this daemon cannot afford.

**`createTypingKeepalive`** (`packages/gateways/src/commons/typing.ts`) spans the **whole turn**, armed in
`TurnExecutor.run` and stopped in a `finally`. The previous version armed a bare `setInterval`
inside the provider call and cleared it on return — and only when streaming was enabled — so the
indicator died for the entire duration of every tool, which is the part that actually takes time. A
60ms tool with a 5ms keepalive produced exactly **one** tick; the test in `pipeline.test.ts` pins
that at more than three.

Two details that are not incidental:

- **In-flight suppression.** If the platform API stalls past the interval, ticks queue behind it and
  each one is another request to an API already failing. Openclaw guards this the same way.
- **A failing tick never escapes.** Typing is decoration; it must not be able to fail a turn.

`setTyping` in an adapter swallows its own errors for the same reason.

## Telling the operator something is wrong

`apps/engine/src/commons/notify.ts` is the daemon's own voice, and the only place that sends
runtime-generated messages. Two destinations, because there are two questions:

- **`toChat(target, text)`** — "tell the person in this conversation". Used for the approval notice,
  so a turn waiting on a human does not just stop talking for five minutes.
- **`alert(key, text)`** — "tell whoever owns this daemon", from `[alerts]`. Dead gateway, expired
  session.

Both are best-effort and return a boolean: an alert must never be able to break the thing it is
reporting on. `alert` is keyed on the *kind*, not the message text — `gateway_dead:telegram:nouva`,
not "gave up after 4 attempts" — because a reconnect loop emits the same incident with a changing
count, and keying on text would let every retry through and get the channel muted. **The cooldown is
recorded before the send, not after**, so a slow or failing channel is not retried on every event.

New failure modes belong here, not in a `gateway.send()` at the call site: scattered sends make
"does the operator actually find out when this breaks" impossible to answer, and that is the whole
question.
