# Adding a coding CLI

An agent can be run by a coding CLI instead of a model Nouride calls. Nouride drives the CLI over the Agent Client
Protocol (ACP): it starts the CLI's ACP mode, opens a session per conversation, and answers its permission requests
through Nouride's own gate. Nothing that drives a CLI names one. Everything a CLI needs is its **row**, one file of
`packages/acp/src/clis/`.

## The steps

1. **Find out how it runs, on a Linux machine with no account and no browser.** Install it the way its own
   documentation says. Start its ACP mode and send `initialize` and `session/new`. Read its version command, how its
   sign-in behaves with no browser (it should print a link, a code, or ask for one pasted back), and what it says when
   signed out. A CLI with no ACP mode on Linux cannot be built in.
2. **Write its row** as `packages/acp/src/clis/<id>.ts`, exporting one `CliRow` (the shape is `clis/row.ts`, each field
   explained there), and add it to the list in `clis/index.ts`. The fields most CLIs need:
   - `command` and `args`: what starts its ACP mode.
   - `install`, and `package` with `tested` where it ships on npm (Nouride then reads its newest version and offers
     updates). A CLI its maker installs with a script of its own gives `script` instead (the script's address, and
     where under HOME it leaves the CLI), and its `install` is `nouride agents install <id>`: the card's Set it up then
     asks the orchestrator to run it, as it does an npm one.
   - `profileEnv` and `profileFiles`: the variable that points it at a profile folder (its sign-in and settings), and
     files a new profile starts with, such as the setting that keeps it from updating itself. Absent: its `HOME`.
   - `modes`: Nouride's three presets as the session modes the CLI offers.
   - `instructionFile` and `skillsDir`: where Nouride writes the agent's instructions and copies its skills.
   - `login`, `status`, `signedOut`: how a person signs it in from the dashboard's terminal, and how Nouride tells it is
     signed in. A `status` command that exits 0 whether or not it is signed in is no status: leave it out.
   - `authenticate`: the sign-in methods to name when it refuses a session as signed out.
   - `limit`, `use`, `readUse`: how a refusal for the account's limit is marked, what it says of its use while it works,
     and how its account's use is asked for at any time. `readUse` parses the answer into `CliUse`, the one shape
     every CLI's use is shown and acted on in.
3. **Mark it `experimental: true` until it has run on a real account.** It is offered with an Experimental label and
   names no `tested` versions. Once a turn has run on it, take the flag off and record the versions it ran.
4. **Test it.** `packages/acp/tests/clis.test.ts` holds every row to the shape; a parse in `readUse` gets a test with
   the answer its maker sends. Docs: the manual's coding CLIs page in both languages, and the release notes.

A CLI a person adds by hand (`[[external_clis]]` in `config.toml`) is a row of the same shape, without the promise that
it was tried.
