# Claude Code

Checked against Claude Code 2.1 (October 2026). `claude --help` is right when this page is not.

It speaks Anthropic's API only, so it runs on a Claude subscription, an Anthropic API key, or a gateway
that serves the Anthropic Messages format, not on a plain OpenAI-compatible endpoint.

## Install

```sh
curl -fsSL https://claude.ai/install.sh | bash
claude --version   # it lands in ~/.local/bin, which is on your PATH
```

The installer downloads about 250 MB and prints nothing until it is done (minutes on a slow link).
Run it in the background (written as above, it is sent there on its own) and check `claude --version`
when it wakes you. A timeout here is the download, not the network being down.

Anthropic documents 4 GB of memory as the minimum; on a smaller machine run nothing else alongside it.

## Sign in

- **A subscription (Pro, Max):** the person runs `claude setup-token` on a computer with a browser,
  and the token it prints is kept as the secret `claude_code_oauth_token`. Sent here, it reaches you
  as a `$TMP_SECRET_…` handle: keep it with `secret_save` under that name, as their
  `/secret set claude_code_oauth_token <token>` in the chat would. Or they add it on the dashboard's
  Secrets page or with `nouride secret set claude_code_oauth_token --stdin` on this machine (paste,
  Ctrl-D, so it stays out of the shell history), and bind `claude_code_oauth_token = ["claude"]` in your
  `[security.exec_secrets]`. It reaches `claude` as `$CLAUDE_CODE_OAUTH_TOKEN`, the variable Claude
  Code reads, and lasts a year. Never print it.
- **An API key:** the same, with a secret named `anthropic_api_key`. When it is set, a headless run
  uses it before a subscription token, so do not set both.
- **A gateway** that serves the Anthropic format: `ANTHROPIC_BASE_URL` (without `/v1`) and
  `ANTHROPIC_AUTH_TOKEN`.

There is no `/login` in a headless run. Never use `--bare` with a subscription: it ignores the token.

## Run

With `cwd` set to the repository:

```sh
set -o pipefail; DISABLE_AUTOUPDATER=1 claude -p --output-format stream-json --verbose \
  --permission-mode bypassPermissions < "$TMPDIR/task.md" 2> "$TMPDIR/cc.err" | tee "$TMPDIR/cc.jsonl"
```

- Always pass `--permission-mode`: its default depends on things you cannot see. `bypassPermissions`
  runs everything without asking and is refused as root; `acceptEdits` with `--allowedTools` is the
  narrower choice. Headless, anything it is not allowed is denied and the run carries on.
- After its answer it waits for background tasks it started, up to ten minutes, before it exits. Tell
  it in the task not to leave servers running.

## Answer and session id

The last line is the result:

```sh
tail -n 1 "$TMPDIR/cc.jsonl" | jq -r '.session_id, .is_error, .result'
```

`.permission_denials` lists what it wanted to do and was not allowed.

## Follow up

```sh
set -o pipefail; claude -p --resume <session id> --output-format stream-json --verbose \
  --permission-mode bypassPermissions < "$TMPDIR/followup.md" 2> "$TMPDIR/cc.err" | tee "$TMPDIR/cc-2.jsonl"
```
