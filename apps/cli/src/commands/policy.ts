import { BOLD, DIM, GREEN, RESET, YELLOW, emit, say, usageError, afterOptions } from "@nouride/cli-kit";
import type { Client } from "@nouride/cli-kit";

/**
 * `nouride policy` — what always asks, at which approval level, and whether a given command would.
 *
 * The rules were discoverable two ways before this: read `hardline.ts`, or trip over a prompt. An
 * operator choosing a level needs to know what each still asks, and one surprised by a prompt needs to
 * know which entry of the fixed list fired.
 *
 * `check` runs the real classifier rather than consulting the printed summary, so it cannot drift
 * from what the daemon actually does — and it answers without running anything, which is the only
 * safe way to ask "what would happen if…" about `rm -rf`.
 */
export async function policy(_client: Client, args: string[]): Promise<void> {
  const { BALANCED_ASKS, classifyHardline, classifyOwnState, credentialPath, decideExec, HARDLINE_SUMMARY, HARDLINE_EXEMPTIONS } = await import("@nouride/policy");
  const asksAt = (cls: string) => ({ careful: true, balanced: BALANCED_ASKS.has(cls as never), trusted: false });
  const levels = (cls: string) => (BALANCED_ASKS.has(cls as never) ? "careful and balanced" : "careful");

  if (args[0] === "check") {
    // After `--` when one is given, so the command's own flags are its own: `policy check -- ls --help`.
    const argv = afterOptions(args) ?? args.slice(1);
    if (argv.length === 0) usageError("usage: nouride policy check <command…>");

    say(`${DIM}$ ${argv.join(" ")}${RESET}`);

    const verdict = classifyHardline(argv);
    if (verdict) {
      emit({ command: argv, class: verdict.class, reason: verdict.reason, asks: asksAt(verdict.class) });
      say(`${YELLOW}●${RESET} ${BOLD}${verdict.class}${RESET}: asks every time under ${levels(verdict.class)}, never grantable`);
      say(`  ${DIM}${verdict.reason}${RESET}`);
      return;
    }

    // The daemon's own state counts only where agents run as the daemon's user: elsewhere their files' permissions
    // answer first. Said, since this command reads no daemon and cannot tell which this install is.
    const own = classifyOwnState(argv);
    if (own) {
      emit({ command: argv, class: own.class, reason: own.reason, asks: asksAt(own.class), onlyWithoutOwnUsers: true });
      say(`${YELLOW}●${RESET} ${BOLD}${own.class}${RESET}: asks every time under ${levels(own.class)}, where agents run as the daemon's user`);
      say(`  ${DIM}${own.reason}; where each agent runs as its own user, the file's permissions refuse it instead${RESET}`);
      return;
    }

    /**
     * An everyday program runs at every level, unasked — decided by the decision itself, so this says what an agent's
     * command meets. Answered "careful asks it once" for every command off the fixed list, it could not tell
     * `rg --pre=sh x` from `rg -n foo` (found on the live box).
     */
    const decided = decideExec({ policy: { blocked: [] }, request: { argv: [...argv], cwd: "", agentId: "" }, grantKey: "", grants: new Set(), canAsk: true, ownStateByOs: true });
    if (decided.action === "run") {
      emit({ command: argv, class: null, reason: null, everyday: true, asks: { careful: false, balanced: false, trusted: false } });
      say(`${GREEN}✓${RESET} an everyday program: it runs at every level without asking`);
      return;
    }
    const credential = credentialPath(argv);
    emit({ command: argv, class: null, reason: credential ? `touches credentials (${credential})` : null, asks: { careful: "once", balanced: false, trusted: false } });
    say(`${GREEN}✓${RESET} on no list: ${credential ? `it touches credentials (${credential}), so ` : ""}careful asks it once and \`allow-always\` remembers it; balanced and trusted run it`);
    return;
  }

  emit({ alwaysAsks: HARDLINE_SUMMARY.map((entry) => ({ ...entry, asks: asksAt(entry.class) })), neverOnTheList: HARDLINE_EXEMPTIONS });

  say(`${BOLD}The fixed list${RESET} ${DIM}(asked every time and never remembered; trusted asks none of it)${RESET}`);
  say();
  for (const entry of HARDLINE_SUMMARY) {
    say(`${YELLOW}●${RESET} ${BOLD}${entry.class}${RESET}  ${DIM}${entry.what} (${levels(entry.class)})${RESET}`);
    for (const example of entry.examples) say(`    ${DIM}${example}${RESET}`);
    say();
  }

  say(`${BOLD}On no list${RESET} ${DIM}(careful asks each once and remembers; balanced and trusted run them)${RESET}`);
  for (const line of HARDLINE_EXEMPTIONS) say(`  ${GREEN}✓${RESET} ${DIM}${line}${RESET}`);
  say();
  say(`${DIM}A command inside \`sh -c\` or after \`ssh host\` is classified by what it would run.${RESET}`);
  say(`${DIM}nouride policy check <command…>  ·  answers without running anything${RESET}`);
}
