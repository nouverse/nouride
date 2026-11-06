/**
 * A picture or a voice note sent to an agent a coding CLI answers (0.8.7), through the pipeline with a real CLI process.
 *
 * Each one reached the CLI as `[image_ref attached]`, and the note beside it said the picture was in its context. Now a
 * CLI that says at its handshake it takes pictures is sent ACP's image block; one that does not is given the file's path
 * to open with its own tools, and the note says so. Decided by what the CLI said, never by which CLI it is.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliRow, ContentBlock } from "@nouride/acp";
import { privateWorkspace } from "@nouride/persona";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { promptOf } from "@/modules/external-agents/prompt.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { AttachmentIntake } from "@/modules/pipeline/attachments.ts";
import type { PipelineDeps } from "@/modules/pipeline/deps.ts";
import type { MessageEnvelope } from "@nouride/shared";
import { tempDir } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const benches: Bench[] = [];
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const bench of benches.splice(0)) bench.dispose();
});
afterAll(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A screenshot sent from the dashboard to Nouva, answered by the fake CLI in `look` mode: what reached it, as blocks. */
async function sentToCli(takes: Record<string, boolean>): Promise<ContentBlock[]> {
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", env: { FAKE_MODE: "look", FAKE_TAKES: JSON.stringify(takes) }, modes: { folder: "yolo", risky: "default", all: "default" }, instructionFile: "AGENTS.md" };
  const uploads = tempDir("cli-uploads");
  dirs.push(uploads);
  writeFileSync(join(uploads, "screen.png"), PNG);
  const local = new LocalGateway();
  const bench = await pipelineBench({
    gateways: [local],
    agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n',
    deps: (made) => {
      const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => made.config.daemon.workspaceDir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
      services.push(service);
      mkdirSync(privateWorkspace(made.config.daemon.workspaceDir, "nouva"), { recursive: true });
      return { externalAgents: service, attachments: new AttachmentStore({ rootDir: join(made.dataDir, "attachments"), maxBytes: 1024 * 1024 }) };
    },
  });
  benches.push(bench);
  bench.pipeline.attach();
  const { chatId } = local.dispatch({ text: "what is wrong here?", chatId: "dash-1", attachments: [{ type: "image", mimeType: "image/png", filename: "screen.png", url: join(uploads, "screen.png") }] });
  await eventually(() => bench.turns.forChat("web:dashboard", chatId).some((turn) => turn.status !== "running"), 10_000, "the CLI's turn to end");
  return JSON.parse(bench.turns.forChat("web:dashboard", chatId)[0]!.reply) as ContentBlock[];
}

const textOf = (blocks: ContentBlock[]) => blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");

describe("a picture sent to an agent a coding CLI answers", () => {
  test("goes as ACP's image block where the CLI said it takes pictures, and the note says it is in its context", async () => {
    const blocks = await sentToCli({ image: true });
    expect(blocks.filter((block) => block.type === "image")).toEqual([{ type: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" }]);
    expect(textOf(blocks)).toContain("The 1 image(s) above are in your context as pictures");
    expect(textOf(blocks)).not.toContain("attached]");
    // Its own tools are the CLI's: Nouride's are not named to it.
    expect(textOf(blocks)).not.toContain("attachment_read");
  });

  test("goes as its file's path where the CLI takes none, and the note does not say it is in its context", async () => {
    const blocks = await sentToCli({});
    expect(blocks.map((block) => block.type)).toEqual(["text"]);
    const text = textOf(blocks);
    expect(text).not.toContain("in your context as pictures");
    expect(text).not.toContain("attachment_read");
    expect(text).toContain("Open them\nat the paths below with your own tools: your file-reading tool for text and pictures alike.");
    expect(text).toContain("The 1 image(s) above are not in your context: open each at its path with your file-reading tool to look at it.");
    // The path is the stored copy, the one the agent's own user reads — and the picture is there.
    const path = /^- (\/\S+) · image\/png/m.exec(text)?.[1];
    expect(path && readFileSync(path)).toEqual(Buffer.from(PNG));
  });
});

describe("a picture from earlier in the conversation — the message replied to, the room's", () => {
  test("is carried to a CLI that takes pictures, and not to one that takes none: the note there would say it is in its context", async () => {
    const dir = tempDir("cli-carried");
    dirs.push(dir);
    writeFileSync(join(dir, "earlier.png"), PNG);
    const file = { ref: "r-earlier", gatewayId: "telegram:main", mimeType: "image/png", kind: "image", localPath: join(dir, "earlier.png") };
    const carriedTo = (takes: { image: boolean; audio: boolean }) =>
      new AttachmentIntake({
        config: { media: { imageModel: "", readImages: true, maxImageBytes: 8_388_608 } },
        registry: { get: (id: string) => ({ config: { id, external: { cli: "fake" } } }) },
        externalAgents: { runnerFor: () => null, takes: async () => takes },
        gateways: new Map(),
      } as unknown as PipelineDeps).pictures("nouva", { gatewayId: "telegram:main", chatId: "c1" } as MessageEnvelope, [file]);
    expect((await carriedTo({ image: true, audio: false })).map((part) => part.ref)).toEqual(["r-earlier"]);
    expect(await carriedTo({ image: false, audio: false })).toEqual([]);
  });
});

describe("a part of a message as a CLI's prompt takes it", () => {
  const dir = tempDir("cli-parts");
  dirs.push(dir);
  const clip = join(dir, "note.ogg");
  writeFileSync(clip, new Uint8Array([0x4f, 0x67, 0x67, 0x53, 9, 9]));
  const heic = join(dir, "photo.heic");
  writeFileSync(heic, new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]));
  const message = (part: object) => ({ role: "user" as const, content: [{ type: "text" as const, text: "listen" }, part] as never });

  test("a voice note is ACP's audio block where the CLI takes sound, and its path where it does not", async () => {
    const part = { type: "audio_ref", ref: "r1", localPath: clip, format: "ogg" };
    expect((await promptOf(message(part), undefined, "", { image: false, audio: true }))[1]).toEqual({ type: "audio", data: Buffer.from(readFileSync(clip)).toString("base64"), mimeType: "audio/ogg" });
    const [said, ...rest] = await promptOf(message(part), undefined, "", { image: true, audio: false });
    expect(rest).toEqual([]);
    expect(said).toEqual({ type: "text", text: `listen\n[sound: ${clip} (not in your context; open it with your tools to listen)]` });
  });

  test("a picture no model takes, or one over the size limit, is its path even where the CLI takes pictures", async () => {
    const part = { type: "image_ref", ref: "r2", localPath: heic, mimeType: "image/heic" };
    expect(await promptOf(message(part), undefined, "", { image: true, audio: false })).toEqual([{ type: "text", text: `listen\n[image: ${heic} (not in your context; open it with your file-reading tool to look at it)]` }]);
    const png = join(dir, "big.png");
    writeFileSync(png, PNG);
    expect((await promptOf(message({ ...part, localPath: png }), undefined, "", { image: true, audio: false }, 4)).map((block) => block.type)).toEqual(["text"]);
    expect((await promptOf(message({ ...part, localPath: png }), undefined, "", { image: true, audio: false }, 1024)).map((block) => block.type)).toEqual(["text", "image"]);
  });
});
