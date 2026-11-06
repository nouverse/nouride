# Gemini CLI

Checked against Gemini CLI 0.63 (October 2026). `gemini --help` is right when this page is not.

It speaks the Gemini API only: a Gemini API key, Vertex AI, or an endpoint in the Gemini API format.

## Install

Node 20 or newer:

```sh
npm i -g @google/gemini-cli && gemini --version
```

Google documents 4 GB of memory as the minimum.

## Sign in

A secret `gemini_api_key` bound to `gemini` in your `[security.exec_secrets]` arrives as `$GEMINI_API_KEY`, which it reads. A
`security.auth.selectedType` in `~/.gemini/settings.json` wins over the variable, so remove one that
points elsewhere.

## Run

With `cwd` set to the repository:

```sh
set -o pipefail; gemini -o stream-json --approval-mode yolo --skip-trust < "$TMPDIR/task.md" 2> "$TMPDIR/gm.err" | tee "$TMPDIR/gm.jsonl"
```

- It runs headless by itself when stdin is not a terminal, and reads the task from it.
- `--approval-mode yolo` lets it edit and run commands; `auto_edit` allows edits only. Headless, a
  question it would ask is answered no. Do not add `--yolo`: it is the old spelling and cannot be
  combined with `--approval-mode`.
- `--skip-trust` matters: in a folder it does not trust, it falls back to asking, that is, to no.

## Answer and session id

The answer arrives in pieces:

```sh
jq -r 'select(.type=="init") | .session_id' "$TMPDIR/gm.jsonl"
jq -rj 'select(.type=="message" and .role=="assistant") | .content' "$TMPDIR/gm.jsonl" | tail -n 40
```

## Follow up

From the same directory (sessions are kept per project):

```sh
set -o pipefail; gemini -r <session id> -o stream-json --approval-mode yolo --skip-trust < "$TMPDIR/followup.md" 2> "$TMPDIR/gm.err" | tee "$TMPDIR/gm-2.jsonl"
```
