# Codex

Checked against Codex 0.162 (October 2026). `codex exec --help` is right when this page is not. In
Codex, `-p` picks a config profile, not a prompt.

It speaks OpenAI's Responses API: a custom endpoint has to serve `/v1/responses`. One that serves only
`/v1/chat/completions` does not work any more.

## Install

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_INSTALL_DIR="$NOURIDE_BIN" CODEX_NON_INTERACTIVE=1 sh
codex --version
```

OpenAI documents 4 GB of memory as the minimum.

## Sign in

- **An API key:** a secret `codex_api_key` bound to `codex` in your `[security.exec_secrets]` arrives as `$CODEX_API_KEY`,
  which Codex reads.
- **A ChatGPT plan:** `codex login --device-auth`, run in a `session`. It prints a URL and a code; send
  both to the person, who opens the URL and enters the code. Nothing comes back through the chat. The
  login is saved under `~/.codex/`.
- **A custom endpoint** with the Responses API, in `~/.codex/config.toml`:

  ```toml
  model = "<model>"
  model_provider = "mine"
  [model_providers.mine]
  name = "My provider"
  base_url = "<base url>"
  env_key = "<NAME>"
  wire_api = "responses"
  ```

## Run

With `cwd` set to the repository:

```sh
set -o pipefail; codex exec --json --sandbox workspace-write - < "$TMPDIR/task.md" 2> "$TMPDIR/cx.err" | tee "$TMPDIR/cx.jsonl"
```

- `-` reads the task from stdin.
- It never asks: a command its sandbox blocks simply fails. `workspace-write` may edit the working
  directory and has no network; add `-c sandbox_workspace_write.network_access=true` when the task
  needs to install anything.
- The sandbox may not start inside a container. If the error says so, the way out is
  `--dangerously-bypass-approvals-and-sandbox`, which removes every limit, so use it only in a worktree you
  could throw away.
- Outside a git repository it refuses unless given `--skip-git-repo-check`.

## Answer and session id

```sh
jq -r 'select(.type=="thread.started") | .thread_id' "$TMPDIR/cx.jsonl"
jq -r 'select(.type=="item.completed" and .item.type=="agent_message") | .item.text' "$TMPDIR/cx.jsonl" | tail -n 40
```

The turn ends with `turn.completed`, or `turn.failed` with the reason.

## Follow up

Flags go before `resume`:

```sh
set -o pipefail; codex exec --json --sandbox workspace-write resume <thread id> - < "$TMPDIR/followup.md" 2> "$TMPDIR/cx.err" | tee "$TMPDIR/cx-2.jsonl"
```
