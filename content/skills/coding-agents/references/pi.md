# pi and oh-my-pi

Checked against pi 1.1 and oh-my-pi (October 2026). `pi --help` and `omp --help` are right when this
page is not. Both take an OpenAI-compatible endpoint, so both run on the provider you already use.

pi moved: the package is `@earendil-works/pi-coding-agent` now; `@mariozechner/pi-coding-agent` is
the old, deprecated one. oh-my-pi (`omp`) is a fork with more built in.

Neither asks before a tool call, and neither has a turn or time limit of its own. Wrap a run in
`timeout`. Both read a stdin that is not a terminal to the end: always give them `</dev/null`. Never
use `-r` headless: it opens a picker.

## pi

```sh
npm i -g --ignore-scripts @earendil-works/pi-coding-agent && pi --version
```

Needs Node 22.19 or newer. Its installer script will not install Node without a terminal.

`~/.pi/agent/models.json` takes the key by reference, written with a quoted heredoc:

```json
{ "providers": { "mine": {
  "baseUrl": "<base url>", "api": "openai-completions", "apiKey": "$NAME",
  "models": [ { "id": "<model>", "contextWindow": 128000, "maxTokens": 16384 } ]
} } }
```

`pi --list-models mine` shows what it found. With `cwd` set to the repository:

```sh
set -o pipefail; PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 timeout 60m pi --mode json --model mine/<model> \
  --session-id <name> "$(cat "$TMPDIR/task.md")" </dev/null 2> "$TMPDIR/pi.err" | tee "$TMPDIR/pi.jsonl"
```

- `--session-id <name>` creates the session for this directory, and the same name continues it. Pick
  one per task and you never have to look the id up. Run the follow-up from the same directory: from
  another one it asks whether to fork, and with no stdin that is a no.
- The first line is `{"type":"session","id":…}`. The answer is the last `message_end` whose message is
  the assistant's:

  ```sh
  jq -r 'select(.type=="message_end" and .message.role=="assistant") | .message | .stopReason, ([.content[] | select(.type=="text") | .text] | join(""))' "$TMPDIR/pi.jsonl" | tail -n 40
  ```

- In JSON mode it exits 0 even when the turn failed: read `stopReason`.

## oh-my-pi

```sh
curl -fsSL https://omp.sh/install | PI_INSTALL_DIR="$NOURIDE_BIN" sh -s -- --binary && omp --version
omp config set startup.checkUpdate false
```

In `~/.omp/agent/models.yml`, `apiKey` is the variable's **name**, and if that variable is unset the
name itself is sent as the key:

```yaml
providers:
  mine:
    baseUrl: <base url>
    api: openai-completions
    apiKey: NAME
    models:
      - id: <model>
        contextWindow: 128000
        maxTokens: 16384
```

`omp models mine` shows what it found. Always pass `--cwd`: started in your home, it quietly moves to
a temporary directory. It loads a repository's own `.omp`, `.claude` and `.cursor` settings without
asking, so a repository can change what it does. Use it on repositories you trust.

```sh
set -o pipefail; OMP_SKIP_SETUP=1 omp -p --mode json --cwd <repo> --model mine/<model> --yolo --max-time 60m \
  "$(cat "$TMPDIR/task.md")" </dev/null 2> "$TMPDIR/omp.err" | tee "$TMPDIR/omp.jsonl"
```

The events have pi's shape: the session id is on the first line, the answer in the last assistant
`message_end`. It exits non-zero when the turn fails. Follow up with `--resume <id>` and the same
flags.
