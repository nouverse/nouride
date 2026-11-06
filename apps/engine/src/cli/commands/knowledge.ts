/**
 * `nouride knowledge` — the knowledge base (0.8.20, KNOWLEDGE_BASE §13): its collections, a search of them, a file added
 * to one, the index brought in line with the folder, a collection archived or brought back, a document removed. Through
 * the daemon's own routes (`routes/knowledge.ts`), so this and the dashboard's Knowledge tab say the same.
 */

import { basename, readFileBytes, readStdinBytes } from "@nouride/runtime";
import type { Client } from "@/cli/client.ts";
import { flagValue } from "@/cli/args.ts";
import { BOLD, DIM, RESET, YELLOW, emit, fail, say, usageError } from "@/cli/ui.ts";
import { knownAction } from "@/cli/usage.ts";

interface CollectionRow {
  id: string;
  name: string;
  description: string;
  readers: { kind: string; people?: string[]; chat?: string };
  agents: string[] | null;
  about: string[];
  archived: boolean;
  documents: number;
  sections: number;
  problem?: string;
}

interface Hit {
  item: string;
  collectionName: string;
  trail: string;
  text: string;
  pageFrom?: number;
}

/** Who may be answered from it, in a few words. */
function readersLine(readers: CollectionRow["readers"]): string {
  switch (readers.kind) {
    case "everyone":
      return "everyone";
    case "admins":
      return "the admins";
    case "group":
      return `the group ${readers.chat}`;
    default:
      return (readers.people ?? []).join(", ");
  }
}

/** The words of a search: every positional after the action, flags and their values left out. */
function words(args: string[]): string {
  const out: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--in") i += 1;
    else if (!args[i]!.startsWith("-")) out.push(args[i]!);
  }
  return out.join(" ").trim();
}

/**
 * The collection a person named: its id, or the name the dashboard and the list show. `--to House` was refused with
 * `no collection "House"` while the list printed House, its id beside it (0.8.20's check on the box).
 */
async function collectionId(client: Client, given: string): Promise<string> {
  const { collections } = await client.get<{ collections: CollectionRow[] }>("/knowledge");
  const wanted = given.trim().toLowerCase();
  const found = collections.find((row) => row.id === given) ?? collections.find((row) => row.name.trim().toLowerCase() === wanted);
  if (!found) fail(`no collection "${given}"`, "`nouride knowledge` lists them, with each one's id");
  return found.id;
}

/** A word as a shell reads it: as it is when nothing in it is special, else in single quotes. */
function shellWord(word: string): string {
  return /^[\w./@%+=:,-]+$/.test(word) ? word : `'${word.split("'").join(`'\\''`)}'`;
}

/**
 * The file's bytes, or why not. On a server `nouride` run as root runs as the service's account, which cannot read a
 * file in root's home: that was "is not a file here" of a file that was (0.8.20's check on the box). The shell that ran
 * the command can open it, and hand it over on standard input.
 */
async function readNamed(file: string, to: string): Promise<Uint8Array> {
  try {
    return await readFileBytes(file);
  } catch (err) {
    if ((err as { code?: unknown })?.code !== "EACCES") return fail(`${file} is not a file here.`);
    return fail(
      `Cannot read ${file}: permission denied for ${process.env.USER || "this account"}, the account this command runs as.`,
      `Hand it over on standard input: nouride knowledge add - --name ${shellWord(basename(file))} --to ${shellWord(to)} < ${shellWord(file)}`,
    );
  }
}

/** Bytes as base64, in pieces small enough for `String.fromCharCode`. */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export async function knowledge(client: Client, args: string[]): Promise<void> {
  knownAction("knowledge", args[0], ["list", "search", "add", "reindex", "archive", "unarchive", "rm"]);
  const action = args[0] && !args[0].startsWith("-") ? args[0] : "list";

  if (action === "list") {
    const { collections } = await client.get<{ collections: CollectionRow[] }>("/knowledge");
    emit({ collections });
    if (collections.length === 0) return say(`${DIM}no collections yet: make one on the dashboard's Knowledge tab, or a folder in .nouride/knowledge/${RESET}`);
    for (const row of collections) {
      const archived = row.archived ? ` ${YELLOW}archived${RESET}` : "";
      say(`${BOLD}${row.name}${RESET} ${DIM}(${row.id})${RESET}${archived} · ${row.documents} document(s), ${row.sections} section(s) · for ${readersLine(row.readers)}${row.agents ? ` · agents ${row.agents.join(", ")}` : ""}`);
      if (row.description) say(`  ${DIM}${row.description}${RESET}`);
      if (row.problem) say(`  ${YELLOW}${row.problem}${RESET}`);
    }
    return;
  }

  if (action === "search") {
    const query = words(args);
    if (!query) usageError("usage: nouride knowledge search <words> [--in <collection>]", "the words a document would contain");
    const named = flagValue(args, "--in");
    const only = named ? await collectionId(client, named) : undefined;
    const { hits } = await client.get<{ hits: Hit[] }>(`/knowledge/search?q=${encodeURIComponent(query)}${only ? `&collection=${encodeURIComponent(only)}` : ""}`);
    emit({ hits });
    if (hits.length === 0) return say(`${DIM}nothing found${RESET}`);
    for (const hit of hits) {
      const text = hit.text.replace(/\s+/g, " ").trim();
      say(`${BOLD}${hit.collectionName}${RESET} · ${hit.trail}${hit.pageFrom !== undefined ? ` · p. ${hit.pageFrom}` : ""} ${DIM}${hit.item}${RESET}`);
      say(`  ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
    }
    return;
  }

  if (action === "add") {
    const file = args[1];
    const named = flagValue(args, "--to");
    const given = flagValue(args, "--name")?.trim();
    if (!file || (file.startsWith("-") && file !== "-") || !named || (file === "-" && !given)) {
      usageError("usage: nouride knowledge add <file> --to <collection>, or add - --name <file name> --to <collection> < <file>", "`nouride knowledge` lists the collections");
    }
    const bytes = file === "-" ? await readStdinBytes() : await readNamed(file, named);
    const to = await collectionId(client, named);
    const { saved } = await client.post<{ saved: { path: string; status: string; reason?: string }[] }>(`/knowledge/${encodeURIComponent(to)}/documents`, {
      name: file === "-" ? given : basename(file),
      base64: base64(bytes),
    });
    emit({ saved });
    for (const row of saved) say(`${row.status === "indexed" ? "✓" : "!"} ${to}/${row.path}${row.reason ? ` ${DIM}${row.reason}${RESET}` : ""}`);
    return;
  }

  if (action === "reindex") {
    const only = args[1] && !args[1].startsWith("-") ? await collectionId(client, args[1]) : undefined;
    const report = await client.post<{ indexed: number; unchanged: number; dropped: number; notSearched: number }>("/knowledge/sync", only ? { collection: only } : {});
    emit(report);
    return say(`✓ ${report.indexed} read again, ${report.unchanged} unchanged, ${report.dropped} gone, ${report.notSearched} kept but not searched`);
  }

  if (action === "archive" || action === "unarchive") {
    const named = args[1];
    if (!named || named.startsWith("-")) usageError(`usage: nouride knowledge ${action} <collection>`, "`nouride knowledge` lists the collections");
    const id = await collectionId(client, named);
    const { collection } = await client.patch<{ collection: CollectionRow | null }>(`/knowledge/${encodeURIComponent(id)}`, { archived: action === "archive" });
    emit({ collection });
    return say(action === "archive" ? `✓ ${id} is kept, and no longer searched` : `✓ ${id} is searched again`);
  }

  // rm <collection>/<path>
  const target = args[1];
  const slash = target ? target.indexOf("/") : -1;
  if (!target || slash <= 0 || slash === target.length - 1) usageError("usage: nouride knowledge rm <collection>/<file>", "the document's path in its collection, as `nouride knowledge` shows the collections");
  const id = await collectionId(client, target.slice(0, slash));
  const path = target.slice(slash + 1);
  await client.del(`/knowledge/${encodeURIComponent(id)}/documents?path=${encodeURIComponent(path)}`);
  emit({ removed: { collection: id, path } });
  say(`✓ removed ${id}/${path}`);
}
