/**
 * Credentials by *name*, resolved from the environment or a writable store.
 *
 * Config files reference a secret by name (`api_key = "nougate"`), never by value. That
 * keeps §17.1's "no secrets in config files" true while solving the problem env-only
 * cannot: the dashboard has to be able to add a bot token without a redeploy.
 *
 * Resolution is **environment first, store second**. A container platform that injects
 * `NOUGATE=…` must win over whatever is in the data volume, otherwise a stale file
 * silently overrides the deployment's own configuration — the kind of bug that only shows
 * up in production.
 *
 * Encrypted at rest since 0.8.19 (`store-file.ts`, its key from `store-key.ts`): `data/secrets.enc`, written whole.
 * `secrets.json` is read until the daemon moves it, once no update is pending: the guard's way back to the previous
 * version needs the file that version reads.
 */

import { handlesIn } from "./transient.ts";
import { fileExistsSync, join, readTextFileSync, removePath, renamePath, setFileMode, writeFileAtomic, writeTextFileAtomic } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { changedFields, type FieldChange } from "./fields.ts";
import { SecretError } from "./store-error.ts";
import { ENCRYPTED_FILE, encodeStore, PLAIN_FILE, type StoredSecret, valuesOnly } from "./store-file.ts";
import { fileSignature, type Format, parseStored, readDisk } from "./store-disk.ts";
import { findStoreKeys, forgetMadeKey, type KeyLayout, type KeyLevel, makeStoreKey, type StoreKey } from "./store-key.ts";

export { SecretError };

const log = createLogger("secrets");

const STORE_MODE = 0o600;

export type SecretOrigin = "env" | "store";


/**
 * Values that look like credentials rather than names.
 *
 * The failure this prevents: someone pastes their actual key where the name goes. Without
 * a check, that key ends up committed in `config.toml` and the daemon still "works",
 * because a name that resolves to nothing and a name that is itself a key look the same
 * from the outside until you read the file.
 */
const LOOKS_LIKE_A_VALUE = [
  /^sk-/i,
  /^xox[baprs]-/i,
  /^ghp_/,
  /^Bearer\s/i,
  /^[0-9]{8,}:[A-Za-z0-9_-]{30,}$/, // Telegram bot token
];

const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/i;

/** Whether `value` has the shape of a credential rather than of a name — for a field that takes either, like a header. */
export function looksLikeCredential(value: string): boolean {
  return LOOKS_LIKE_A_VALUE.some((pattern) => pattern.test(value));
}

export function assertSecretName(name: string, where: string): void {
  if (!name) throw new SecretError(`${where} is empty: a secret name is expected`);

  if (name.length > 63 || LOOKS_LIKE_A_VALUE.some((pattern) => pattern.test(name))) {
    throw new SecretError(
      `${where} looks like a credential, not a name. Put the value in .env or the secret store ` +
        `and reference it by name here, e.g. api_key = "nougate".`,
    );
  }

  if (!VALID_NAME.test(name)) {
    throw new SecretError(
      `${where} is not a valid secret name: use letters, digits, dashes and underscores`,
    );
  }
}

/**
 * Environment variables a secret name maps to, in priority order.
 *
 * `nougate` → `NOUGATE`, then `NOURIDE_SECRET_NOUGATE`. The prefixed form exists for names
 * generic enough to collide with something else in the environment.
 */
export function envNamesFor(name: string): string[] {
  const upper = name.toUpperCase().replace(/-/g, "_");
  return [upper, `NOURIDE_SECRET_${upper}`];
}

/**
 * A name and a value fit to be stored: a name the config can say, a value that is there — and not the handle of a
 * credential sent in chat. A handle is what a message holds in place of a credential; stored, it is a token every
 * platform refuses. Live, two Telegram bots were saved as `$TMP_SECRET_…` and answered "Not Found" (2026-10-21).
 */
function assertSecretValue(name: string, value: string): void {
  assertSecretName(name, `secret name "${name}"`);
  if (!value) throw new SecretError(`refusing to store an empty value for "${name}"`);
  const trimmed = value.trim();
  if (handlesIn(trimmed).length > 0 && trimmed.replace(/\$TMP_SECRET_[0-9A-F]{12}/g, "").trim() === "") {
    throw new SecretError(
      `refusing to store ${trimmed} as "${name}": it is the handle of a credential sent in chat, not the credential. ` +
        "Hand it over where it is replaced by its value: the `nouride` tool's stdin or a command's environment",
    );
  }
}


/** One stored secret as a list shows it: what is said about it, never its value. */
export interface SecretDescription {
  name: string;
  origin: SecretOrigin;
  fields: Record<string, string>;
  addedBy?: string;
  addedAt?: string;
  changedAt?: string;
}

/** Where the store stands: encrypted or not yet, and with which key, said as a person needs it. Never the key. */
export interface StoreLock {
  encrypted: boolean;
  /** Where the key it is (or will be) encrypted with was found, and how far that is from the data. */
  key?: { where: string; level: KeyLevel };
}

export interface SecretStoreOptions {
  /** Where keys are found and kept. Default: the key kept inside `dataDir`, as a test or a bare store wants. */
  layout?: KeyLayout;
  /**
   * Whether this store may encrypt the file again with the first key it finds, when the file's key is another. The
   * daemon's, and nothing else's: a command run with a stray key in its shell would lock out the daemon.
   */
  rekey?: boolean;
  now?: () => Date;
}



export class SecretStore {
  /** Names the environment answered for — so their values are known to mask, though nothing stored them. */
  private readonly fromEnv = new Set<string>();

  /** The files as this store last read or wrote them — their times and sizes — so a change another process made is seen. */
  private seen: string;

  private readonly listeners: (() => void)[] = [];

  private constructor(
    private readonly dataDir: string,
    private stored: Record<string, StoredSecret>,
    private format: Format,
    private lockedWith: StoreKey | null,
    private keys: StoreKey[],
    private readonly env: Record<string, string | undefined>,
    private readonly layout: KeyLayout,
    private readonly now: () => Date,
  ) {
    this.seen = this.signature();
  }

  static async open(
    dataDir: string,
    env: Record<string, string | undefined> = process.env,
    options: SecretStoreOptions = {},
  ): Promise<SecretStore> {
    const layout = options.layout ?? { keptKey: join(dataDir, "encryption.key") };
    const keys = findStoreKeys(env, layout);
    const disk = readDisk(dataDir, keys, () => findStoreKeys(env, layout));
    const store = new SecretStore(dataDir, disk.secrets, disk.format, disk.lockedWith, keys, env, layout, options.now ?? (() => new Date()));
    if (options.rekey) await store.rekey();
    return store;
  }

  /**
   * Every secret replaced by `secrets`, under this install's key: what `nouride secret restore` puts back from a copy
   * sealed to the backup password, for a moved install or a lost key. A file locked with a key that cannot be found
   * here is set aside under another name, never written over: it is someone's secrets, and its key may turn up.
   */
  static async restore(
    dataDir: string,
    secrets: Record<string, StoredSecret>,
    env: Record<string, string | undefined> = process.env,
    options: SecretStoreOptions = {},
  ): Promise<{ setAside?: string }> {
    const layout = options.layout ?? { keptKey: join(dataDir, "encryption.key") };
    const keys = findStoreKeys(env, layout);
    const now = options.now ?? (() => new Date());
    let lockedWith: StoreKey | null = null;
    let setAside: string | undefined;
    const enc = join(dataDir, ENCRYPTED_FILE);
    if (fileExistsSync(enc)) {
      try {
        lockedWith = readDisk(dataDir, keys, () => findStoreKeys(env, layout)).lockedWith;
      } catch (err) {
        if (!(err instanceof SecretError)) throw err;
        setAside = `${enc}.unopened-${now().getTime()}`;
        renamePath(enc, setAside);
      }
    }
    const store = new SecretStore(dataDir, secrets, "encrypted", lockedWith, keys, env, layout, now);
    await store.persist();
    if (fileExistsSync(join(dataDir, PLAIN_FILE))) removePath(join(dataDir, PLAIN_FILE));
    return setAside ? { setAside } : {};
  }

  resolve(name: string): string | undefined {
    for (const envName of envNamesFor(name)) {
      const value = this.env[envName];
      if (value) {
        this.fromEnv.add(name);
        return value;
      }
    }
    // Not held: another process may have stored it since — `nouride setup` beside a running daemon (0.8.15).
    if (this.stored[name] === undefined) this.catchUp();
    return this.stored[name]?.value;
  }

  /**
   * Every value this store holds or has handed out, by name — what anything leaving the daemon is masked against: the
   * stored ones, those the environment answered for when something asked, and the store's own key. The daemon's own,
   * never a route's: a value read back over HTTP is one script away from somebody else (`inventory`).
   */
  knownValues(): Record<string, string> {
    const known: Record<string, string> = {};
    for (const name of new Set([...Object.keys(this.stored), ...this.fromEnv])) {
      const value = this.resolve(name);
      if (value) known[name] = value;
    }
    // The store's own key too, each once (the file's and the first found are often the same one).
    const keys = [...new Set([...(this.lockedWith ? [this.lockedWith.text] : []), ...this.keys.map((key) => key.text)])];
    for (const [index, text] of keys.entries()) known[keys.length === 1 ? "the secret store's key" : `the secret store's key #${index + 1}`] = text;
    return known;
  }

  /** Resolve or throw, naming what needed it — a missing key should say what it was for. */
  require(name: string, usedBy: string): string {
    const value = this.resolve(name);
    if (!value) {
      throw new SecretError(
        `${usedBy} needs the secret "${name}", which is not set. Add ${envNamesFor(name)[0]} to .env, ` +
          `or set it from the dashboard.`,
      );
    }
    return value;
  }

  has(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  origin(name: string): SecretOrigin | null {
    for (const envName of envNamesFor(name)) {
      if (this.env[envName]) return "env";
    }
    return this.stored[name] !== undefined ? "store" : null;
  }

  /**
   * Names, origins and what is said about each — never values.
   *
   * This is what the dashboard renders. A secret store that can display its contents is
   * one XSS away from being an exfiltration endpoint, so reading back a value is simply
   * not part of the API surface the HTTP layer can reach.
   */
  inventory(): SecretDescription[] {
    this.catchUp();
    return Object.keys(this.stored)
      .sort()
      .map((name) => this.describeStored(name));
  }

  /** What is said about one stored secret, or null when the store has none of that name. */
  describe(name: string): SecretDescription | null {
    this.catchUp();
    return this.stored[name] ? this.describeStored(name) : null;
  }

  private describeStored(name: string): SecretDescription {
    const entry = this.stored[name] as StoredSecret;
    return {
      name,
      origin: this.origin(name) ?? "store",
      fields: { ...entry.fields },
      ...(entry.addedBy ? { addedBy: entry.addedBy } : {}),
      ...(entry.addedAt ? { addedAt: entry.addedAt } : {}),
      ...(entry.changedAt ? { changedAt: entry.changedAt } : {}),
    };
  }

  /** Whether the file is encrypted yet, and where its key is. */
  lock(): StoreLock {
    this.catchUp();
    const key = this.lockedWith ?? this.keys[0];
    return { encrypted: this.format === "encrypted" && fileExistsSync(this.encPath()), ...(key ? { key: { where: key.where, level: key.level } } : {}) };
  }

  /**
   * Store a value. A new secret is added with `fields` and who added it; one replaced keeps what is said about it,
   * unless `fields` says it again.
   */
  async set(name: string, value: string, options: { fields?: FieldChange; actor?: string } = {}): Promise<void> {
    assertSecretValue(name, value);
    const current = this.onDisk();
    const before = current[name];
    const fields = options.fields ? changedFields(name, before?.fields ?? {}, options.fields) : (before?.fields ?? {});
    const at = this.now().toISOString();
    this.stored = {
      ...current,
      [name]: before
        ? { ...before, value, fields, changedAt: at }
        : { value, fields, addedAt: at, ...(options.actor ? { addedBy: options.actor } : {}) },
    };
    await this.persist();

    if (this.origin(name) === "env") {
      // Worth saying out loud: the write succeeded but changes nothing, because the
      // environment still wins. Otherwise this reads as a dashboard bug.
      log.warn("secret stored but the environment takes precedence", {
        name,
        env_var: envNamesFor(name)[0],
      });
    }
  }

  /** What is said about a stored secret, changed; its value untouched. The fields as they are after. */
  async changeFields(name: string, change: FieldChange): Promise<Record<string, string>> {
    const current = this.onDisk();
    const entry = current[name];
    if (!entry) throw new SecretError(`there is no stored secret "${name}" to say anything about`);
    const fields = changedFields(name, entry.fields, change);
    this.stored = { ...current, [name]: { ...entry, fields } };
    await this.persist();
    return fields;
  }

  async delete(name: string): Promise<boolean> {
    const current = this.onDisk();
    if (current[name] === undefined) {
      this.stored = current;
      return false;
    }
    const { [name]: _removed, ...rest } = current;
    this.stored = rest;
    await this.persist();
    return true;
  }

  /**
   * Several values, written in one write of the file: all of them or — when one is refused — none.
   *
   * For values that only work together, like an OAuth access token and the refresh token issued with it. Two `set`s
   * are two writes, and a process ended between them keeps a refresh token the server has already rotated away — a
   * login lost at the next restart. Each name is checked, and each value, before anything changes.
   */
  async setMany(values: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(values)) {
      assertSecretValue(name, value);
    }
    const current = this.onDisk();
    const at = this.now().toISOString();
    const next = { ...current };
    for (const [name, value] of Object.entries(values)) {
      const before = current[name];
      next[name] = before ? { ...before, value, changedAt: at } : { value, fields: {}, addedAt: at };
    }
    this.stored = next;
    await this.persist();
  }

  /** Each of `names` the store holds, removed in one write. The names it held. */
  async deleteMany(names: readonly string[]): Promise<string[]> {
    const current = this.onDisk();
    const held = names.filter((name) => current[name] !== undefined);
    if (held.length === 0) {
      this.stored = current;
      return [];
    }
    this.stored = Object.fromEntries(Object.entries(current).filter(([name]) => !held.includes(name)));
    await this.persist();
    return held;
  }

  /**
   * `secrets.json` moved into `secrets.enc`: written, read back and compared, and only then the plain file removed.
   * Under a key found, or one made where none is (`makeStoreKey`): every install is encrypted with nothing to run.
   * False when there was nothing to move.
   */
  async encryptAtRest(): Promise<boolean> {
    this.catchUp();
    // A move cut short after `secrets.enc` was written and before `secrets.json` went: the encrypted store is the newer,
    // and holds every value the plain one does. Finished now; a plain file it does not match is left, and doctor names it.
    if (this.format === "encrypted" && fileExistsSync(this.plainPath())) {
      const plain = parseStored(readTextFileSync(this.plainPath()), this.plainPath());
      if (Object.entries(plain).every(([name, value]) => this.stored[name]?.value === value)) {
        removePath(this.plainPath());
        this.seen = this.signature();
        log.info("finished moving the secret store: secrets.json removed, secrets.enc holds it", {});
      }
      return false;
    }
    if (this.format !== "plain" || !fileExistsSync(this.plainPath())) return false;
    const plain = parseStored(readTextFileSync(this.plainPath()), this.plainPath());
    // What is said about each, kept from this store's copy: fields given while it was plain went nowhere on disk yet.
    const moved: Record<string, StoredSecret> = {};
    for (const [name, value] of Object.entries(plain)) moved[name] = { ...(this.stored[name] ?? { fields: {} }), value };
    this.stored = moved;
    this.format = "encrypted";
    try {
      await this.persist();
      const back = readDisk(this.dataDir, this.keys, () => this.findKeys());
      if (JSON.stringify(valuesOnly(back.secrets)) !== JSON.stringify(valuesOnly(moved))) throw new SecretError("what was read back is not what was written");
    } catch (err) {
      this.format = "plain";
      removePath(this.encPath());
      this.seen = this.signature();
      throw err;
    }
    removePath(this.plainPath());
    this.seen = this.signature();
    log.info("the secret store is encrypted", { secrets: Object.keys(moved).length, key: this.lockedWith?.where, level: this.lockedWith?.level });
    return true;
  }

  /**
   * The store as an older version reads it: `secrets.json`'s map of names to values. For `nouride secret decrypt`, run
   * on the machine by a person going back to that version; never for a route, which would hand every value to whoever
   * can call it.
   */
  plainCopy(): string {
    this.catchUp();
    return `${JSON.stringify(valuesOnly(this.stored), null, 2)}\n`;
  }

  /** The whole store with what is said about each, as the backup password's sealed copy holds it. The daemon's own. */
  sealedCopyText(): string {
    this.catchUp();
    return JSON.stringify({ version: 2, secrets: this.stored });
  }

  /** Called after each write this store makes: the sealed copy is made again then (`modules/config/sealed-secrets.ts`). */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  /**
   * The file encrypted again with the first key found, when its key is another: the key given since (a container's
   * `NOURIDE_ENCRYPTION_KEY`, root's file `install.sh` made), over the one this daemon made itself, which then goes.
   */
  private async rekey(): Promise<void> {
    const best = this.keys[0];
    const old = this.lockedWith;
    if (this.format !== "encrypted" || !best || !old || best.fingerprint === old.fingerprint) return;
    this.lockedWith = best;
    await this.persist();
    await forgetMadeKey(old, this.layout);
    log.info("the secret store is encrypted with another key now", { from: old.where, to: best.where, level: best.level });
  }

  private findKeys(): StoreKey[] {
    this.keys = findStoreKeys(this.env, this.layout);
    return this.keys;
  }

  /** The key to write with: the file's own, else the first found, else one made now (no file needs another). */
  private async writingKey(): Promise<StoreKey> {
    if (this.lockedWith) return this.lockedWith;
    const found = this.keys[0] ?? this.findKeys()[0];
    if (found) return found;
    const made = await makeStoreKey(this.layout);
    this.keys = [made];
    log.info("made a key for the secret store", { where: made.where, level: made.level });
    return made;
  }

  /**
   * The file as it is now, which a write changes rather than the copy this store read at its start.
   *
   * A daemon holds its store open for days, and `nouride setup` — run beside it, as the Docker docs run it — opens one of
   * its own and writes the key there. The daemon's next write put back the copy it had read at boot, and the key was
   * gone: a fresh install under Nix's benchmark lost its provider key to the `nouride secret set` that followed, and its
   * bot answered nothing (2026-11-02).
   */
  private onDisk(): Record<string, StoredSecret> {
    const disk = readDisk(this.dataDir, this.keys, () => this.findKeys());
    if (disk.lockedWith) this.lockedWith = disk.lockedWith;
    // A plain file's map says nothing about its secrets: what this store was told while it was plain is kept.
    if (disk.format === "plain") {
      for (const [name, entry] of Object.entries(disk.secrets)) {
        const known = this.stored[name];
        if (known) disk.secrets[name] = { ...known, value: entry.value };
      }
    }
    this.format = disk.format;
    return disk.secrets;
  }

  /** The files read again where they changed since this store last read or wrote them; kept as they were if they cannot be read. */
  private catchUp(): void {
    const now = this.signature();
    if (now === this.seen) return;
    try {
      const disk = readDisk(this.dataDir, this.keys, () => this.findKeys());
      this.stored = disk.format === "plain" ? Object.fromEntries(Object.entries(disk.secrets).map(([name, entry]) => [name, { ...(this.stored[name] ?? entry), value: entry.value }])) : disk.secrets;
      this.format = disk.format;
      this.lockedWith = disk.lockedWith;
      this.seen = now;
    } catch (err) {
      log.warn("could not read the secret store again; going on with what was read before", { path: this.dataDir, error: String(err) });
    }
  }

  private async persist(): Promise<void> {
    if (this.format === "plain") {
      // Until it is moved, the file the previous version reads, as it reads it: names and values.
      await writeTextFileAtomic(this.plainPath(), `${JSON.stringify(valuesOnly(this.stored), null, 2)}\n`, { mode: STORE_MODE });
      if (!setFileMode(this.plainPath(), STORE_MODE)) log.warn("could not set 0600 on the secret store", { path: this.plainPath() });
    } else {
      const key = await this.writingKey();
      // Created 0600, never written wider and tightened after.
      await writeFileAtomic(this.encPath(), encodeStore(this.stored, key), { mode: STORE_MODE });
      this.lockedWith = key;
    }
    this.seen = this.signature();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        log.warn("after a write of the secret store, a listener failed", { error: String(err) });
      }
    }
  }

  private encPath(): string {
    return join(this.dataDir, ENCRYPTED_FILE);
  }

  private plainPath(): string {
    return join(this.dataDir, PLAIN_FILE);
  }

  private signature(): string {
    return `${fileSignature(this.encPath())}|${fileSignature(this.plainPath())}`;
  }
}
