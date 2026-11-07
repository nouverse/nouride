# LLM wire formats

`@nouride/llm` turns a `ChatParams` into a `ChatResponse` or a chunk stream. It knows nothing
about agents, tools or sessions — the loop that uses it lives in the engine, because that
loop needs an approval gate and a tool registry.

Two formats, per TD-004: **OpenAI-compatible** and **Anthropic**. Raw `fetch`, no SDKs
(TD-006) — the request shape is fifty lines of types, and we own retry, timeouts and error
handling instead of inheriting an SDK's opinions.

---

## Why two implementations and not a translator

The formats differ structurally, not cosmetically:

| | OpenAI | Anthropic |
|---|---|---|
| system prompt | first message | top-level `system` field |
| tool result | `role: "tool"` message | `tool_result` block inside a **user** message |
| several results | one message each | **merged into one** user message |
| tool schema | `{type:"function",function:{parameters}}` | `{name,description,input_schema}` |
| `max_tokens` | optional | **required** |
| streamed args | `tool_calls[].function.arguments` fragments | `input_json_delta.partial_json` |

Nougate has full bidirectional mappers; Nouride only needs to speak each format natively.

**The merge is a correctness requirement.** Emitting one user message per `tool_result` is
rejected with an "unexpected role" error, which is why `toWireMessages` is a loop with a
merge and not a `.map()`.

An assistant message with `tool_calls` sends `content: null`, not `""` — some
OpenAI-compatible servers reject an empty string alongside tool calls.

---

## Retry belongs in `http.ts`, before the body is touched

`postJson` retries the *request* and hands back an untouched `Response`. Once a stream has
yielded a chunk to the caller, replaying would duplicate output — so retry cannot live in the
executor or inside `stream()`.

429 and 5xx retry with exponential backoff; 4xx does not, because a malformed request will be
malformed on the third attempt too and retrying only burns the rate limit. `LLMError.retryable`
encodes that. A caller-initiated abort is a decision, not a failure to retry around.

Error bodies are truncated to 500 chars: providers sometimes echo the whole request back, and
a log line holding a full conversation both is useless and leaks content that was never meant
to be logged.

---

## Streaming

`parseSse` is the only place that knows the framing. **A chunk boundary can land anywhere,
including mid-field**, so the buffer is only consumed up to the last complete `\n\n`. Splitting
per chunk would corrupt exactly the long tool-call arguments that are hardest to reproduce.

Tool call arguments arrive as fragments and are **assembled, then emitted once complete** —
a half-parsed JSON object is not something a caller can act on. Parallel calls keep their
index order.

Malformed arguments are passed through as `{_malformed: "…"}` rather than thrown. Models do
emit broken JSON; throwing aborts the whole turn, while this lets the tool layer answer with
a parse error the model sees and corrects on the next iteration.

---

## Never trust reported usage

**Nougate returns no `usage` field at all** on its OpenAI-compatible path, and `input_tokens: 0`
in Anthropic `message_start`. Recording that silence as zero made the daily cost cap in §10.2
fail open — a spend limit that never trips.

`fillMissingUsage` estimates from the request and response when a provider reports nothing, and
marks the result `estimated: true`. Anything charging against a budget should know which of the
two it is looking at. Output tokens are **not** invented for an empty response.

Any new provider must run its response through it.

---

## Model ids carry prefixes

A proxy renames models: Nougate serves `antigravity:claude-sonnet-4-6`, OpenRouter serves
`anthropic/claude-3-5-sonnet`. Left as-is, every one of those falls through to the conservative
32k default — so an agent on a 200k model gets its history trimmed six times harder than
necessary, and its cost reported as unpriced.

`normalizeModelId` strips everything up to the last `:` or `/`. **Both `contextWindowFor` and
`priceFor` must go through it.** Any new lookup keyed by model id must too.

Unknown models get a conservative context window on purpose: guessing high produces requests
the provider rejects, guessing low only shortens history.

---

## Adding a format

1. Implement `LLMProvider` (`kind`, `baseUrl`, `chat`, `stream`) in `packages/llm/src/`.
2. Use `postJson` — do not call `fetch` directly, or you lose retry and the injectable
   `fetchImpl` that keeps tests off the network.
3. Run usage through `fillMissingUsage`.
4. Map `stopReason` to `stop | tool_calls | max_tokens`; `tool_calls` wins whenever calls are
   present, whatever the upstream field says.
5. Add the `kind` to `ProviderKind` in shared and a case to `createProvider`. The `never`
   guard there means a missing case is a type error, not a silent fallthrough.
6. Test with `fakeFetch` / `sseResponse` from `packages/llm/tests/helpers.ts`: request mapping,
   tool round-trip, streamed fragments, retry behaviour, and missing usage.

Then check it against the real endpoint — see the live-testing rules in `workflow.md`. Both
usage findings above came from that, and no fixture would have revealed either.

---

## Cost

`estimateCost` returns `{usd, unpriced}`. A model absent from the price book is reported
**unpriced**, not given a plausible rate: a guessed number is indistinguishable from a real
one on a chart, and a budget that silently under-counts is worse than one that admits it does
not know.

Prices drift. When you add a model, add it with the date you checked in the commit message,
not in a comment that will rot.

---

## Failures are classified, and the classification drives behaviour

`packages/llm/src/classify.ts`. Before it, `retryable` was `status === 429 || status >= 500` and
nothing else, so every other failure looked identical. Measured, not imagined: a model id missing its
provider prefix came back from Nougate as `model_prefix_required` — a permanent configuration error —
and the chat said *"The model is not responding right now."* The model was answering perfectly, and we
retried three times first.

Hermes carries 1,842 lines of this and uses it to drive provider failover. Ours covers the classes we
can act on differently, and **every action is wired**:

| Action | Who reads it | What happens |
|---|---|---|
| `retry` | `postJson` backoff loop | back off and try again |
| `shrink` | `TurnExecutor.callProvider` | halve the context budget, truncate, retry **once** |
| `stop` | same loop | one attempt, then fail — the same request cannot succeed |
| `alertOperator` | `Pipeline` turn-failure path | `notifier.alert` with the real cause |

A classification nothing reads is decoration. If you add a class, wire its action in the same commit.

### The body is consulted before the status

`model_prefix_required` and a malformed-JSON complaint are both `400` and need opposite responses: one
is fixable in `config.toml`, the other is a bug in our own wire mapping. Status-only classification
conflates them and sends the operator to the wrong file. Same reason a spending cap is matched before
`auth` — it arrives as a `403`, and "check your API key" is the wrong advice for an empty balance.

### User messages carry no status codes and no provider bodies

Asserted over every case in `classify.test.ts`. `operatorHint` is the opposite: it names the knob to
change, and it is what reaches the alert channel.

### `shrink` retries once, not until it fits

If half the budget is still too much, the request is not the problem — an oversized single message, or
a context window smaller than one turn. Retrying further just spends money on the same failure. And if
truncation dropped nothing, the original error is rethrown rather than resent unchanged.
