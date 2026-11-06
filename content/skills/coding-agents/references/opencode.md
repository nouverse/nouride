# OpenCode

Checked against OpenCode 1.19 (October 2026). `opencode --help` and `opencode run --help` are right
when this page is not. **OpenCode 2 is a different program** with a different config schema: if
`opencode --version` says 2.x, its config is not the one below. Read its own docs.

The one CLI here that takes a plain OpenAI-compatible endpoint (`/v1/chat/completions`), so it is the
one that runs on the provider you already use.

## Install

```sh
curl -fsSL https://opencode.ai/install | bash -s -- --no-modify-path
ln -sf ~/.opencode/bin/opencode "$NOURIDE_BIN/opencode" && opencode --version
```

Or `npm i -g opencode-ai`.

## Sign in on your own provider

`nouride` `["provider"]` gives the base URL. The key arrives as an environment variable once the
operator binds the provider's secret to `opencode` in your `[security.exec_secrets]`. Check it is there without printing it:
`[ -n "$NAME" ] && echo set`. OpenCode turns an unset `{env:…}` into an empty key, which fails later
as a confusing auth error.

Which models the endpoint serves:

```sh
curl -s "<base url>/models" -H "Authorization: Bearer $NAME" | jq -r '.data[].id'
```

`~/.config/opencode/opencode.json` holds one provider, the models you will use, and the key by reference:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "model": "mine/<model>",
  "provider": {
    "mine": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My provider",
      "options": { "baseURL": "<base url>", "apiKey": "{env:NAME}" },
      "models": { "<model>": { "name": "<model>" } }
    }
  }
}
```

The first run fetches `@ai-sdk/openai-compatible` from npm, so it needs the network once.

## Run

With `cwd` set to the repository:

```sh
set -o pipefail; opencode run --format json --auto < "$TMPDIR/task.md" 2> "$TMPDIR/oc.err" | tee "$TMPDIR/oc.jsonl"
```

- `--format json` prints one JSON event per line; `tee` keeps them in a file and in the job's log, so
  the log keeps growing while it works.
- `--auto` approves its own edits and commands. Headless, anything it would still ask about is
  refused, not waited on (notably a path outside the working directory).
- The task comes in on stdin. Never leave stdin open: it reads to the end.
- `-m mine/<other model>` picks another model for one run.

## Answer and session id

There is no final event: it exits when it is done. Every line carries the session id; the answer is
in the `text` events.

```sh
head -1 "$TMPDIR/oc.jsonl" | jq -r .sessionID
jq -r 'select(.type=="text") | .part.text' "$TMPDIR/oc.jsonl" | tail -n 40
```

## Follow up

```sh
set -o pipefail; opencode run --format json --auto -s <session id> < "$TMPDIR/followup.md" 2> "$TMPDIR/oc.err" | tee "$TMPDIR/oc-2.jsonl"
```

`-c` continues the most recent session instead, which is only safe when nothing else ran since.
