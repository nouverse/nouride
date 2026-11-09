/**
 * `nouride secret` — put a credential in the store, list what is there, remove one.
 *
 * **There is no read verb, and there never will be.** The store exists so a config file can name a
 * credential instead of holding one; a command that printed a value back would hand every caller of
 * this CLI — including an agent — a way to exfiltrate every token on the box in one call. `list`
 * gives names and where each resolves from, which is what an operator or an agent actually needs:
 * "is `discord_nox_token` set" is answerable without seeing it.
 *
 * The value arrives on **stdin**, not in an argument. Everything in `argv` is kept in three places
 * permanently — the exec grant, the audit table and the daemon's own log table — so an inline flag
 * would write the credential to disk three times on its way to being stored properly. `--value`
 * exists anyway, for a human at a terminal who has decided that is fine, and its help text says what
 * it costs.
 *
 * This is what lets an agent finish a setup it starts: it can ask the person for a bot token in chat
 * and store it itself, rather than getting three steps in and handing back instructions.
 *
 * `seal` sets the backup passphrase (0.8.18): the config snapshots then hold the store sealed to it, which only
 * that passphrase opens (`secret-unseal.ts`). It arrives on stdin for the reason a value does.
 */

import type { AckResponse } from "@/cli/wire.ts";
import { readStdin } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, fail, say, usageError, usageLines } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";

export async function secret(client: Client, args: string[]): Promise<void> {
  const [action, name] = args;
  const flag = (key: string): string | undefined => flagValue(args, `--${key}`);

  if (!action || action === "list") {
    const { secrets, sealedInSnapshots, lock } = await client.get<{
      secrets: { name: string; origin: string; usedBy?: string[]; fields?: Record<string, string> }[];
      sealedInSnapshots?: boolean;
      lock?: { encrypted: boolean; key?: { where: string; level: string } };
    }>("/secrets");
    if (secrets.length === 0) return say(`${DIM}no secrets stored${RESET}`);
    for (const entry of secrets) {
      // Where it resolves from, because that decides what changing it does: an env-provided secret
      // wins over the store, so writing one that is shadowed looks like a no-op. And `missing` — the
      // config needs it, nobody set it — said as such: it read as `store`, and a provider key lost to
      // a second writer looked set while the bot answered nothing (0.8.15).
      const from =
        entry.origin === "env" ? `${YELLOW}env${RESET}` : entry.origin === "missing" ? `${RED}not set${RESET}` : `${DIM}store${RESET}`;
      const needs = entry.usedBy?.length ? `${DIM}, for ${entry.usedBy.join(", ")}${RESET}` : "";
      say(`${BOLD}${entry.name}${RESET} ${from}${needs}`);
      // What is said about it (0.8.19): its fields, never its value.
      const fields = Object.entries(entry.fields ?? {});
      if (fields.length) say(`  ${DIM}${fields.map(([name, text]) => `${name}: ${text}`).join(" · ")}${RESET}`);
    }
    say();
    const unset = secrets.filter((entry) => entry.origin === "missing");
    for (const entry of unset) say(`${RED}✗${RESET} ${entry.name} is not set: nouride secret set ${entry.name} --stdin`);
    // Encrypted, and how far its key is from the data (0.8.19); then where a restore would find them (0.8.18).
    if (lock) say(`${DIM}${lockLine(lock)}${RESET}`);
    say(
      sealedInSnapshots
        ? `${DIM}The config snapshots hold these, sealed to your backup passphrase: nouride secret restore, with it.${RESET}`
        : `${DIM}The snapshots do not hold these, and a lost key means setting each again: nouride secret seal --stdin seals them to a passphrase.${RESET}`,
    );
    return say(`${DIM}Values are never printed. nouride secret set <name> --stdin${RESET}`);
  }

  if (action === "set") {
    if (!name) {
      usageLines(
        `${DIM}nouride secret set <name> --stdin            read the value from stdin (preferred)\n` +
          `nouride secret set <name> --value <value>    inline: it ends up in shell history, in the\n` +
          `                                            exec grant and in the audit log, all of\n` +
          `                                            which keep it forever\n` +
          `nouride secret rm <name>${RESET}`,
      );
    }

    // Read before the request, so failing to supply a value is not a half-written secret.
    let value = flag("value");
    if (hasFlag(args, "--stdin")) {
      value = (await readStdin()).trim();
      if (!value) return fail("--stdin was given but nothing arrived on stdin");
    }
    if (!value) {
      return fail(
        "No value given.",
        "Use --stdin and pipe it in, or --value if you accept that it is kept forever.",
      );
    }

    const fields = every(args, "--field");
    const set = fieldTexts(fields);
    if (typeof set === "string") return usageError(set, "nouride secret set <name> --stdin --field domain=github.com --field username=…");
    const result = await client.put<AckResponse>(`/secrets/${encodeURIComponent(name)}`, { value, ...(fields.length ? { fields: { set } } : {}) });
    say(`${GREEN}✓${RESET} ${BOLD}${name}${RESET} ${DIM}stored (${value.length} chars)${RESET}`);
    if (result.shadowedByEnv) {
      // Said out loud, because the write succeeded and will still have no effect.
      say(
        `${YELLOW}!${RESET} an environment variable of the same name takes priority, so this stored\n` +
          `  value is not what resolves. Unset it, or use a different name.`,
      );
    }
    return say(`${DIM}  Reference it by name in config.toml. Never paste the value there.${RESET}`);
  }

  if (action === "field" || action === "fields") {
    if (!name) return usageError("Which secret?", "nouride secret field <name> name=text… [--remove name]…");
    const given = args.slice(2).filter((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--remove");
    const set = fieldTexts(given);
    if (typeof set === "string") return usageError(set, "nouride secret field <name> domain=github.com username=…");
    const remove = every(args, "--remove");
    if (!Object.keys(set).length && !remove.length) return usageError("Which fields?", "nouride secret field <name> name=text… [--remove name]…");
    const { fields } = await client.patch<{ fields: Record<string, string> }>(`/secrets/${encodeURIComponent(name)}/fields`, { set, remove });
    say(`${GREEN}✓${RESET} ${BOLD}${name}${RESET} ${DIM}${Object.entries(fields).map(([field, text]) => `${field}: ${text}`).join(" · ") || "no fields"}${RESET}`);
    return;
  }

  if (action === "rm" || action === "delete") {
    if (!name) return usageError("Which secret?", "nouride secret rm <name>");
    const { deleted } = await client.del<{ deleted: boolean }>(
      `/secrets/${encodeURIComponent(name)}`,
    );
    return deleted
      ? say(`${GREEN}✓${RESET} removed ${BOLD}${name}${RESET}`)
      : say(`${DIM}nothing stored under ${name}${RESET}`);
  }

  if (action === "seal") {
    const off = hasFlag(args, "--off");
    if (off === hasFlag(args, "--stdin")) return usageError("Seal to a passphrase, or stop?", "nouride secret seal --stdin (the passphrase on stdin) | nouride secret seal --off");
    const passphrase = off ? null : (await readStdin()).trim();
    if (passphrase === "") return fail("--stdin was given but nothing arrived on stdin");
    const result = await client.post<{ snapshot?: string; skipped?: string }>("/secrets/seal", off ? { off: true } : { passphrase });
    if (off) {
      say(`${GREEN}✓${RESET} the snapshots no longer hold the secrets`);
      return say(`${DIM}  The ones already taken keep theirs, sealed to the passphrase of their day.${RESET}`);
    }
    say(`${GREEN}✓${RESET} the config snapshots hold the secrets, sealed to this passphrase`);
    say(`${DIM}  Keep it somewhere other than this box: nothing here can open them, and without it no one can.${RESET}`);
    if (result.snapshot) {
      say(`${DIM}  Taken now: ${result.snapshot}/secrets.sealed${RESET}`);
      say(`${DIM}  Check that it opens: nouride secret unseal <that file> --stdin --out <path>${RESET}`);
    }
    if (result.skipped) say(`${YELLOW}!${RESET} no snapshot now: ${result.skipped}`);
    return;
  }

  usageError(`Unknown secret action "${action}".`, "Use: list, set <name>, field <name>, rm <name>, seal --stdin|--off, unseal <file>, decrypt --out <path>, restore [<file>]");
}

/** Each value given after a flag that may be repeated (`--field a=1 --field b=2`). */
function every(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag && args[i + 1] !== undefined ? [args[i + 1] as string] : []));
}

/** `name=text` pairs as fields, or what is wrong with one. */
function fieldTexts(pairs: readonly string[]): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) return `"${pair}" is not name=text`;
    out[pair.slice(0, at).trim()] = pair.slice(at + 1);
  }
  return out;
}

/** The store's lock in one line: encrypted or not yet, and how far its key is from the data. Never the key. */
function lockLine(lock: { encrypted: boolean; key?: { where: string; level: string } }): string {
  if (!lock.encrypted) return "Not encrypted yet: it is once this update is confirmed.";
  const where = lock.key?.where ?? "this install";
  if (lock.key?.level === "install") return `Encrypted, its key in ${where}, beside the data: running install.sh again moves it to /etc/nouride.`;
  if (lock.key?.level === "data") return `Encrypted, its key kept in the data folder (${where}): give NOURIDE_ENCRYPTION_KEY to keep it apart from the data.`;
  return `Encrypted, its key in ${where}.`;
}
