# Command Code

Checked against Command Code's docs (October 2026). `cmd --help` is right when this page is not.

A closed-source CLI that runs on its own hosted service and plan by default. Bringing your own
OpenAI-compatible endpoint is supported but marked beta.

## Install

Node 22 or newer:

```sh
npm i -g command-code && cmd --version
```

The same package installs `command-code`, `cmdc` and `commandcode`. Use `command-code` if `cmd`
means something else on this machine.

## Sign in

- **Its own plan:** a secret `command_code_api_key` bound to its command in your `[security.exec_secrets]` arrives as
  `$COMMAND_CODE_API_KEY`.
- **Your own provider:** `~/.commandcode/providers.json`. It refuses a raw key, so the reference is
  the only way to write it:

  ```json
  { "provider": { "mine": { "baseURL": "<base url>", "apiKey": "$NAME",
    "models": { "<model>": { "contextWindow": 128000 } } } } }
  ```

  `cmd --list-models` shows the ids it accepts. `--local-only` keeps it from contacting its own
  service at all.

## Run

With `cwd` set to the repository:

```sh
set -o pipefail; DO_NOT_TRACK=1 COMMANDCODE_SKIP_UPDATES=1 cmd -p "$(cat "$TMPDIR/task.md")" --yolo --trust \
  --skip-onboarding --no-auto-update -m mine/<model> --output-format json </dev/null 2> "$TMPDIR/cmd.err" | tee "$TMPDIR/cmd.jsonl"
```

Without `--yolo`, a headless run is denied every edit and command. It stops at 100 turns
(`--max-turns`).

## Answer and session id

The last line is the result:

```sh
tail -n 1 "$TMPDIR/cmd.jsonl" | jq -r '.subtype, .sessionId, .finalText'
```

Exit codes worth knowing: 3 not signed in, 4 permission denied, 8 out of turns, 10 out of credits.

## Follow up

`cmd -p --resume <session id> "…"` with the same flags. A bare `--resume` is an error; `-c` takes the
latest headless session in this directory.
