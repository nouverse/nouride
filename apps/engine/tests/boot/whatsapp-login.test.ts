/**
 * An install's one WhatsApp login, kept where it is when each connection gets a folder of its own
 * (`boot/whatsapp-login.ts`).
 *
 * While a daemon held one number its login was in `whatsapp` under the data folder, whatever the connection was
 * called. Each connection's folder is named for it now, so without this step the connection an install already has
 * would open an empty folder and ask for a scan again. Each case is a `config.toml` and a data folder as an older
 * install left them, loaded as the daemon loads them, with the step run as boot runs it: before any connection opens.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { bringConfigForward } from "@/boot/config-forward.ts";
import { keepSharedWhatsappLogin, sharedLoginNote } from "@/boot/whatsapp-login.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { tempDir } from "../temp-dirs.ts";

const said: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "config.whatsapp" && said.push(entry)));

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  said.length = 0;
});

const number = (name: string, more = "") => `\n[gateways.whatsapp.${name}]\nenabled = true\nencryption_key = "whatsapp-${name}-key"\n${more}`;

/** An install's file and its data folder, and the step as boot runs it on what the loader made of the file. */
function install(options: { connections: string; dataDir?: string | null; login?: boolean }) {
  const root = tempDir("whatsapp-login");
  cleanup.push(() => removePath(root));
  const configPath = join(root, "config.toml");
  const dataDir = join(root, ".nouride", "data");
  const text = `# the family's box\n[daemon]\n${options.dataDir === null ? "" : `data_dir = "${options.dataDir ?? dataDir}" # where everything is kept\n`}${options.connections}`;
  writeFileSync(configPath, text);
  const shared = join(dataDir, "whatsapp");
  if (options.login !== false) {
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "creds.enc"), "encrypted-login-bytes");
  }
  const file = () => readFileSync(configPath, "utf8");
  const load = () => readConfigText(file(), configPath);
  const config = load();
  const folder = (of: { gateways: { id: string; sessionDir?: string }[] }, id: string) => of.gateways.find((gateway) => gateway.id === id)?.sessionDir;
  return { root, configPath, dataDir, shared, text, file, load, config, folder, keep: () => keepSharedWhatsappLogin({ configPath, config, source: file() }) };
}

describe("an install with one number, linked before each connection had its own folder", () => {
  test("opens the folder its login is in at this start, and the file says so from then on", async () => {
    const at = install({ connections: number("main") });
    // As the file is read before the step: a folder named for the connection, which holds no login.
    expect(at.folder(at.config, "whatsapp:main")).toBe(join(at.dataDir, "whatsapp-main"));
    expect(sharedLoginNote(at.config, at.file())).toEqual({
      message: `[gateways.whatsapp.main] names no session_dir, and its login is in ${at.shared}: the next start writes that folder into its table, so the number stays linked`,
      hint: "Each WhatsApp connection keeps its login in a folder of its own now. Nothing is moved, and no scan is needed.",
    });

    expect(await at.keep()).toEqual({ id: "whatsapp:main", dir: at.shared });

    // The running config, which the connections are made from next, and the file as the next start reads it.
    expect(at.folder(at.config, "whatsapp:main")).toBe(at.shared);
    expect(at.folder(at.load(), "whatsapp:main")).toBe(at.shared);
    expect(at.file()).toBe(`${at.text}session_dir = "${at.shared}"\n`);
    // Nothing was moved.
    expect(readFileSync(join(at.shared, "creds.enc"), "utf8")).toBe("encrypted-login-bytes");
    expect(said.map((entry) => [entry.level, entry.message, entry.data?.gateway])).toEqual([["info", "a WhatsApp connection's login is kept where it is, and its folder written into config.toml", "whatsapp:main"]]);
  });

  test("run again, it does nothing: the connection names the folder", async () => {
    const at = install({ connections: number("main") });
    await at.keep();
    const once = at.file();
    said.length = 0;
    const again = at.load();
    expect(await keepSharedWhatsappLogin({ configPath: at.configPath, config: again, source: once })).toBeNull();
    expect({ file: at.file(), said, note: sharedLoginNote(again, once) }).toEqual({ file: once, said: [], note: null });
  });

  test("the folder is written the way the file writes its data folder, so an install moved whole still finds its login", async () => {
    const at = install({ connections: number("main"), dataDir: ".nouride/data" });
    await at.keep();
    expect(at.file()).toContain('session_dir = ".nouride/data/whatsapp"');
    expect(at.folder(at.load(), "whatsapp:main")).toBe(at.shared);
  });

  test("and the way the default has it, where the file names no data folder", async () => {
    const at = install({ connections: number("main"), dataDir: null });
    await at.keep();
    expect(at.file()).toContain('session_dir = ".nouride/data/whatsapp"');
    expect(at.folder(at.load(), "whatsapp:main")).toBe(at.shared);
  });

  test("the whole path where the file's own word for the data folder is not where data is", async () => {
    // What a container does: its data folder is named to the daemon another way, over the file.
    const at = install({ connections: number("main"), dataDir: "somewhere/else" });
    const elsewhere = join(at.root, "somewhere", "else", "whatsapp");
    expect(at.folder(at.config, "whatsapp:main")).toBe(join(at.root, "somewhere", "else", "whatsapp-main"));
    // The running daemon's data folder is the one that holds the login, as an override leaves it.
    at.config.daemon.dataDir = at.dataDir;
    await at.keep();
    expect(at.file()).toContain(`session_dir = "${at.shared}"`);
    expect(at.file()).not.toContain(elsewhere);
    expect(at.folder(at.config, "whatsapp:main")).toBe(at.shared);
  });

  test("a file that cannot be written: this start still opens the login, and says the file was not told", async () => {
    const at = install({ connections: number("main") });
    chmodSync(at.root, 0o555);
    chmodSync(at.configPath, 0o444);
    cleanup.push(() => (chmodSync(at.root, 0o755), chmodSync(at.configPath, 0o644)));
    expect(await at.keep()).toEqual({ id: "whatsapp:main", dir: at.shared });
    expect(at.folder(at.config, "whatsapp:main")).toBe(at.shared);
    expect(at.file()).toBe(at.text);
    expect(said.map((entry) => [entry.level, entry.message])).toEqual([["warn", "could not write [gateways.whatsapp.main] session_dir into config.toml"]]);
  });
});

describe("at a start", () => {
  test("it is one of the things an older install's file is given, before a connection opens, with the others in the same pass", async () => {
    // `boot/config-forward.ts` as the daemon calls it: this install also has a profile on OpenAI's own API, which
    // another step writes for. Both are in the file after the one pass, and the running config holds both.
    const openai = '\n[providers.openai]\nkind = "openai"\nbase_url = "https://api.openai.com/v1"\napi_key = "openai_api_key"\n';
    const at = install({ connections: number("main") + openai });
    await bringConfigForward({ configPath: at.configPath, config: at.config, carried: false, edition: "pro" });
    expect(at.folder(at.config, "whatsapp:main")).toBe(at.shared);
    expect(at.file()).toContain(`session_dir = "${at.shared}"`);
    expect(at.file()).toContain('max_tokens_field = "max_completion_tokens"');
    expect(at.config.providers.openai?.maxTokensField).toBe("max_completion_tokens");
    // And what the next start reads is the same install: the file loads, with the login where it is.
    expect(at.folder(at.load(), "whatsapp:main")).toBe(at.shared);
  });
});

describe("which connection the login is", () => {
  test("the one that was running: the first switched on that names no folder; the others keep their own", async () => {
    const at = install({ connections: number("spare").replace("enabled = true", "enabled = false") + number("main") + number("shop") });
    expect(await at.keep()).toEqual({ id: "whatsapp:main", dir: at.shared });
    const after = at.load();
    expect({ spare: at.folder(after, "whatsapp:spare"), main: at.folder(after, "whatsapp:main"), shop: at.folder(after, "whatsapp:shop") }).toEqual({
      spare: join(at.dataDir, "whatsapp-spare"),
      main: at.shared,
      shop: join(at.dataDir, "whatsapp-shop"),
    });
  });

  test("none switched on: the first of them", async () => {
    const off = (name: string) => number(name).replace("enabled = true", "enabled = false");
    const at = install({ connections: off("main") + off("shop") });
    expect((await at.keep())?.id).toBe("whatsapp:main");
  });

  test("nobody, once a connection names the shared folder itself: a second that names none keeps its own", async () => {
    const at = install({ connections: number("shop") });
    const text = `${at.file()}${number("main", `session_dir = "${at.shared}"\n`)}`;
    writeFileSync(at.configPath, text);
    const config = at.load();
    expect(await keepSharedWhatsappLogin({ configPath: at.configPath, config, source: text })).toBeNull();
    expect({ file: at.file(), shop: at.folder(config, "whatsapp:shop"), main: at.folder(config, "whatsapp:main") }).toEqual({ file: text, shop: join(at.dataDir, "whatsapp-shop"), main: at.shared });
  });

  test("not one that names a folder of its own in the file: the next that names none", async () => {
    const at = install({ connections: number("main", 'session_dir = "/var/lib/wa-main"\n') + number("shop") });
    expect((await at.keep())?.id).toBe("whatsapp:shop");
    expect(at.folder(at.load(), "whatsapp:main")).toBe("/var/lib/wa-main");
  });
});

describe("nothing to keep", () => {
  test("no login in the shared folder: a new connection scans into its own folder, and the file is left alone", async () => {
    const at = install({ connections: number("main"), login: false });
    expect(await at.keep()).toBeNull();
    expect({ file: at.file(), folder: at.folder(at.config, "whatsapp:main"), note: sharedLoginNote(at.config, at.file()) }).toEqual({ file: at.text, folder: join(at.dataDir, "whatsapp-main"), note: null });
  });

  test("a login there and no WhatsApp connection, or every one naming its own folder: left where it is", async () => {
    const none = install({ connections: "\n[gateways.telegram.bot]\nenabled = false\ntoken = \"telegram_bot\"\n" });
    expect(await none.keep()).toBeNull();
    expect(none.file()).toBe(none.text);
    const named = install({ connections: number("main", 'session_dir = "/var/lib/wa-main"\n') });
    expect(await named.keep()).toBeNull();
    expect(named.file()).toBe(named.text);
  });
});
