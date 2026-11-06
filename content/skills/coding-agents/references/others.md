# Other coding agent CLIs

Starting points, checked against each one's docs in October 2026, less closely than the pages beside
this one. Confirm every flag with the CLI's own `--help` before the first run. Each still follows the
method: install into `$NOURIDE_BIN`, stdin from a file or `</dev/null`, output through `tee`, check its
work, resume by id.

| CLI | Install, no root | Headless | JSON output | Resume | Without asking | Your OpenAI-compatible endpoint |
|---|---|---|---|---|---|---|
| Qwen Code | npm `@qwen-code/qwen-code` → `qwen` | `qwen -p "…"` | `-o stream-json` | `-r <id>`, `-c` | `--yolo` | yes: `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` |
| Kilo CLI (from OpenCode) | npm `@kilocode/cli` → `kilo` | `kilo run "…" --dir <repo>` | `--format json` | `-s <id>`, `-c` | `--auto` | yes: `~/.config/kilo/kilo.jsonc` |
| Copilot CLI | `curl -fsSL https://gh.io/copilot-install \| PREFIX=<dir> bash` → `copilot` | `copilot -p "…" -s --no-ask-user` | `--output-format json` | `--session-id <uuid>` | `--allow-all-tools` | yes: `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL` |
| Goose | `curl -fsSL <its download_cli.sh> \| GOOSE_BIN_DIR="$NOURIDE_BIN" CONFIGURE=false bash` | `goose run -t "…"` | `-q --output-format stream-json` | `run --resume -n <name>` | `GOOSE_MODE=auto` (the default) | yes: `OPENAI_HOST`, `OPENAI_BASE_PATH` |
| Crush | its release tarball → `crush` | `crush run "…"` | none | `run -s <id>`, `-C` | `run` already does | yes: its `crushrc` |
| Aider | `aider.chat/install.sh` with `UV_TOOL_BIN_DIR="$NOURIDE_BIN"` | `aider --message "…"` | none | `--restore-chat-history` | `--yes-always` (still no shell commands) | yes: `--model openai/<id> --openai-api-base <url>` |
| Cursor CLI | `curl https://cursor.com/install -fsS \| bash` → `~/.local/bin/agent` (link it, do not copy) | `agent -p "…"` | `--output-format stream-json` | `--resume <id>` | `-f --trust` | no |
| Amp | `curl -fsSL https://ampcode.com/install.sh \| bash` → `~/.amp/bin/amp` | `amp -x "…"` | `--stream-json` | `amp threads continue <id> -x "…"` | asks nothing by default | an account-level URL only |

A CLI that is in none of these pages: its README's "headless", "non-interactive", "print" or "CI"
section, and `--help`, have the same four answers: how to run one task and exit, how to get JSON
out, how to resume, how to run without asking.
