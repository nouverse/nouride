import type { PeopleResponse, SenderRow, Client } from "@nouride/cli-kit";
import { BOLD, DIM, GREEN, RESET, say, usageError, usageLines, YELLOW, flagValue, hasFlag, knownAction } from "@nouride/cli-kit";
import { saidSaved } from "@/cli/saved.ts";

/**
 * `nouride people` — who the agents know, and who is talking to them without a name yet.
 *
 * One source — `[[people]]` in config.toml — cross-referenced against the senders who have paired.
 * The second list is the useful half: a sender the daemon answers and cannot name is a person the
 * agent greets as nobody, and there is otherwise nothing that puts them in front of the operator.
 */
export async function peopleCommand(client: Client, args: string[]): Promise<void> {
  const [action, target] = args;
  knownAction("people", action, ["set", "remove", "list"]);

  /**
   * `set` — what used to be the `person_manage` tool.
   *
   * The tool took no id: it recorded whoever sent the message being handled, and there was no
   * parameter that could point it at anyone else. That is gone here by construction — a CLI command
   * has no "current sender" to fall back on, so the id has to be an argument. What it removes is the
   * guard against "record Sam's number as mine"; what stands in its place is that reaching this
   * command at all costs an `exec` approval a human reads, and every call is audited.
   */
  if (action === "set") {
    const name = flagValue(args, "--name");
    if (!target || !name) {
      usageLines(
        `nouride people set <key|platform:account> --name <name> [--note <note>] [--reattach]\n` +
          `  e.g. nouride people set telegram:5550001111 --name Sam   (whoever holds that account)\n` +
          `       nouride people set sam --name "Kak Sam"           (a new person by key, with no account yet)`,
      );
    }
    const note = flagValue(args, "--note");
    // An account names the platform (`telegram:…`); a key never has a colon. The daemon validates both.
    const who = target.includes(":") ? { id: target } : { key: target };
    // `--reattach`: the key of someone removed from People, given on purpose with the memory still under it.
    const answer = await client.post<{ restartRequired?: boolean }>("/people", { ...who, name, ...(note ? { notes: note } : {}), ...(hasFlag(args, "--reattach") ? { reattach: true } : {}) });
    return saidSaved(`${target} is ${name}`, answer);
  }

  /**
   * `remove` takes somebody out of People. It was called `forget` and printed "forgot sam" while every
   * conversation and fact about them stayed — and then `nouride memory forget sam` refused, as nobody had
   * that key. So it says what it leaves, every time.
   */
  if (action === "remove") {
    if (!target) usageError(`usage: nouride people remove <key|platform:account>  e.g. sam, or telegram:5550001111`);
    const removed = await client.del<{ tokensRevoked?: number; restartRequired?: boolean }>(`/people?${target.includes(":") ? "id" : "key"}=${encodeURIComponent(target)}`);
    saidSaved(`removed ${target} from People${removed?.tokensRevoked ? `, and revoked ${removed.tokensRevoked} MCP token(s)` : ""}`, removed);
    say(`${DIM}what memory keeps about them stays under their key: nouride memory forget <key> removes it${RESET}`);
    return;
  }

  const { people } = await client.get<PeopleResponse>("/people");
  // Approved senders, so the unnamed list is people the daemon actually answers — a pending request
  // is an access decision, and `nouride access` is where that belongs.
  const { senders } = await client
    .get<{ senders: SenderRow[] }>("/access?status=approved")
    .catch(() => ({ senders: [] as SenderRow[] }));

  // An account is the platform and the sender — `telegram:814…` — whichever of our bots it wrote to.
  const named = new Set((people ?? []).flatMap((p) => p.ids ?? []));
  const nameless = (senders ?? []).filter(
    (s: { gatewayId: string; senderId: string }) => !named.has(`${s.gatewayId.split(":")[0]}:${s.senderId}`),
  );

  if ((people?.length ?? 0) === 0 && nameless.length === 0) {
    say(`${DIM}nobody is named yet${RESET}`);
    return say(`${DIM}an agent records a name itself when someone says it, or add one in the dashboard${RESET}`);
  }

  for (const person of people ?? []) {
    const accounts = person.ids?.length ? person.ids.join(", ") : "no account yet";
    say(`${GREEN}●${RESET} ${BOLD}${person.name}${RESET} ${DIM}(${person.key}) ${accounts}${RESET}`);
    if (person.notes) say(`    ${DIM}${person.notes.split("\n")[0]}${RESET}`);
  }

  for (const sender of nameless) {
    // The platform's display name, shown as theirs rather than as ours: it is a string they chose,
    // and the whole point of this row is that nobody has confirmed who they are.
    const claims = sender.senderName ? ` ${DIM}calls themselves "${sender.senderName}"${RESET}` : "";
    say(`${YELLOW}●${RESET} ${DIM}(no name yet)${RESET} ${DIM}${sender.gatewayId}:${sender.senderId}${RESET}${claims}`);
  }

  say();
  say(`${DIM}nouride people set <key|platform:account> --name <name> [--note <note>]${RESET}`);
  say(`${DIM}nouride people remove <key|platform:account>${RESET}`);
}
