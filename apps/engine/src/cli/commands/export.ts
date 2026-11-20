/**
 * `nouride export --out <file>`: this install as one file, to take it to another machine (`modules/transfer`).
 *
 * It works on the install's folders themselves, as `nouride db` does. An export only reads, and the database's snapshot
 * is one a running daemon allows, so it is made whether Nouride runs or not. What the file will hold is said before it
 * is made. The passphrase that seals the secrets is asked for without echo, twice; a script gives it on stdin
 * (`--stdin`). `--no-secrets` makes a file that holds none, and says so first.
 */

import { dirname, ensureDir, fileExistsSync, join, listDir, openLinePrompt, readStdin, removePath, resolve, statFile } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RESET, YELLOW, emit, fail, flagValue, hasFlag, say, usageError } from "@nouride/cli-kit";
import { formatBytes, plural } from "@nouride/shared";
import { openCommandSecretStore } from "@/boot/secret-store.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { VERSION } from "@/commons/version.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { exportPlan, writeExport, type ExportManifest } from "@/modules/transfer/archive.ts";
import { PASSPHRASE_MIN } from "@/modules/transfer/service.ts";
import { openForExport } from "@/modules/transfer/transfer.store.ts";
import { leftOut } from "@/modules/web/control/system-files.ts";

const PART_WORDS: Record<string, string> = {
  config: "the config and the people",
  agents: "the agents' packs and the skills",
  memory: "the memory",
  knowledge: "the documents",
  uploads: "files sent in the dashboard's chats",
  notes: "the work notes",
  attachments: "files sent in chats",
  workspace: "the agents' own folders",
};

/** What a file holds, a line for each part there is something of. */
export function holds(parts: ExportManifest["parts"], database: number): string[] {
  return [
    `the database (${formatBytes(database)})`,
    ...Object.entries(parts)
      .filter(([, part]) => part.files > 0)
      .map(([name, part]) => `${PART_WORDS[name] ?? name}: ${part.files} ${plural(part.files, "file")}, ${formatBytes(part.bytes)}`),
  ];
}

/** The agents an install has: each folder of its agents' folder that holds a pack. */
export function agentsIn(agentsDir: string): string[] {
  return listDir(agentsDir)
    .filter((entry) => entry.isDirectory && entry.name !== "skills" && fileExistsSync(join(agentsDir, entry.name, "config.toml")))
    .map((entry) => entry.name);
}

async function passphraseForExport(args: string[]): Promise<string | null> {
  if (hasFlag(args, "--no-secrets")) return null;
  if (hasFlag(args, "--stdin")) {
    const given = (await readStdin()).split("\n")[0]?.trim() ?? "";
    if (given.length < PASSPHRASE_MIN) fail(`The passphrase on stdin is shorter than ${PASSPHRASE_MIN} characters.`, "A longer one, or --no-secrets for a file that holds no secret.");
    return given;
  }
  if (!process.stdin.isTTY) usageError("A passphrase for the secrets, or none?", "nouride export --out <file> --stdin   (the passphrase on stdin)\nnouride export --out <file> --no-secrets");
  const prompt = openLinePrompt();
  try {
    say(`${DIM}The secrets go into the file sealed to a passphrase, which the import asks for. At least ${PASSPHRASE_MIN} characters. It is not kept anywhere: without it they cannot be opened.${RESET}`);
    const first = await prompt.askHidden("Passphrase: ");
    if (first.length < PASSPHRASE_MIN) fail(`That is shorter than ${PASSPHRASE_MIN} characters. Nothing was made.`);
    if ((await prompt.askHidden("Again: ")) !== first) fail("The two are not the same. Nothing was made.");
    return first;
  } finally {
    prompt.close();
  }
}

export async function exportInstall(args: string[]): Promise<void> {
  const out = flagValue(args, "--out");
  if (!out) usageError("Where should the file go?", "nouride export --out <file> [--folders] [--stdin | --no-secrets]");
  const file = resolve(out);
  if (statFile(file)) fail(`${file} is already there.`, "Name another file, or remove that one first.");
  if (!statFile(dirname(file))?.isDirectory) fail(`${dirname(file)} is not a folder.`);

  const { config, source } = await loadConfig();
  const configPath = source ?? defaultConfigPath();
  const dbPath = join(config.daemon.dataDir, "nouride.db");
  if (!statFile(dbPath)) fail(`No database at ${dbPath}.`, "Has Nouride ever started here?");
  const folders = hasFlag(args, "--folders");

  const plan = exportPlan({ config, configPath, dbPath, folders, credential: leftOut });
  say(`${BOLD}This file will hold${RESET} ${DIM}(about ${formatBytes(plan.bytes)} before it is compressed)${RESET}`);
  for (const line of holds(plan.parts, plan.database)) say(`  - ${line}`);
  if (!folders && plan.folders.files > 0) say(`${DIM}  Not the agents' own folders (${plan.folders.files} ${plural(plan.folders.files, "file")}, ${formatBytes(plan.folders.bytes)}): --folders puts them in.${RESET}`);
  say(`${DIM}  Never in it: a coding CLI's sign-ins, the snapshots, logs, installed tools, a chat app's own session.${RESET}`);

  // A store that holds nothing has nothing to seal: no passphrase is asked for, and the file says it holds none.
  const store = hasFlag(args, "--no-secrets") ? null : (await openCommandSecretStore({ dataDir: config.daemon.dataDir, configPath })).sealedCopyText();
  const count = store === null ? 0 : Object.keys((JSON.parse(store) as { secrets?: object }).secrets ?? {}).length;
  let secrets: { passphrase: string; store: string; count: number } | undefined;
  if (store !== null && count === 0) say(`${DIM}No secrets are kept in this install's store, so none go into the file.${RESET}`);
  else {
    const passphrase = await passphraseForExport(args);
    if (passphrase === null || store === null) say(`${YELLOW}!${RESET} No secrets go into this file: on the new machine each is set again.`);
    else secrets = { passphrase, store, count };
  }

  const work = join(config.daemon.dataDir, "export-work");
  ensureDir(work, 0o700);
  const db = openForExport(dbPath);
  try {
    const done = await writeExport({ config, configPath, db, version: VERSION, agents: agentsIn(config.daemon.agentsDir), out: file, work, folders, credential: leftOut, secrets });
    if (!done.ok) fail("The file was not made.", done.error);
    emit({ path: done.path, bytes: done.bytes, manifest: done.manifest });
    say(`${GREEN}✓${RESET} ${done.path}  ${DIM}${formatBytes(done.bytes)}${RESET}`);
    say(`${DIM}  It holds every chat and memory${secrets ? `, and ${secrets.count} ${plural(secrets.count, "secret")} sealed to the passphrase` : ""}: keep it as you would keep those.${RESET}`);
    say(`${DIM}  On the new machine: install Nouride, then ${BOLD}nouride import <this file>${RESET}${DIM}, or its dashboard's Settings, Export and import.${RESET}`);
  } finally {
    db.close();
    removePath(work);
  }
}
