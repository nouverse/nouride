/**
 * `send_message`: which chat `to` means, and that nothing is asked or sent when it means none (0.7.23).
 *
 * The resolver is pure, so each rule is a row here — a person's key or name, a group's name, an address, several
 * matches narrowed to one, too many, none, the chat it is in, and another agent's connection. Then the tool's gate and
 * its run, with a fake `post`: an unresolved `to` is refused before a person is asked, a resolved one is asked about by
 * where it goes, and the audit keeps where and how long, never the words.
 */

import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";
import { createSendMessageTool, resolveSendTarget, type ReachableChat, type SendTargets } from "@/modules/tools/builtins/send-message.ts";

const gadingDm: ReachableChat = { gatewayId: "telegram:main", chatId: "814", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 300 };
const miraTelegram: ReachableChat = { gatewayId: "telegram:main", chatId: "555", platform: "telegram", kind: "dm", people: [{ key: "mira", name: "Mira Wati" }], lastActive: 200 };
const miraWhatsapp: ReachableChat = { gatewayId: "whatsapp:main", chatId: "62811@s.whatsapp.net", platform: "whatsapp", kind: "dm", people: [{ key: "mira", name: "Mira Wati" }], lastActive: 100 };
const family: ReachableChat = { gatewayId: "whatsapp:main", chatId: "1203@g.us", platform: "whatsapp", kind: "group", title: "Keluarga Besar", people: [{ key: "mira", name: "Mira Wati" }, { name: "Budi" }], lastActive: 250 };

const targets: SendTargets = { chats: [gadingDm, family, miraTelegram, miraWhatsapp], othersGateways: ["telegram:nox"] };
/** Asked from `gadingDm`, a Telegram one-to-one. */
const here = { gatewayId: "telegram:main", chatId: "814", gateway: "telegram" };

const chatOf = (to: string, from = here, within = targets) => {
  const found = resolveSendTarget(to, within, from);
  return found.ok ? `${found.chat.gatewayId}:${found.chat.chatId}` : `refused: ${found.reason}`;
};

describe("what `to` means", () => {
  test("an address is that chat", () => {
    expect(chatOf("whatsapp:main:1203@g.us")).toBe("whatsapp:main:1203@g.us");
  });

  test("a group's name, however it is cased or spaced, is that group", () => {
    expect(chatOf("keluarga besar")).toBe("whatsapp:main:1203@g.us");
    expect(chatOf("Keluarga-Besar")).toBe("whatsapp:main:1203@g.us");
  });

  test("a person's key or name is their one-to-one, when they have one", () => {
    const one = { chats: [gadingDm, miraWhatsapp], othersGateways: [] };
    expect(chatOf("mira", here, one)).toBe("whatsapp:main:62811@s.whatsapp.net");
    expect(chatOf("Mira Wati", here, one)).toBe("whatsapp:main:62811@s.whatsapp.net");
  });

  test("a person with several one-to-ones is not guessed at — not even this connection's: the answer lists them", () => {
    // Live: "to my WhatsApp" went to the operator's second Telegram account, which shared the request's connection.
    const answer = chatOf("mira");
    expect(answer).toStartWith('refused: "mira" has 2 chats you can reach');
    expect(answer).toContain("`telegram:main:555`");
    expect(answer).toContain("`whatsapp:main:62811@s.whatsapp.net`");
  });

  test("groups of one name: this connection, this platform, then the one already talked in; still several, listed", () => {
    const other: ReachableChat = { ...family, gatewayId: "telegram:main", chatId: "-100", platform: "telegram" };
    expect(chatOf("keluarga besar", here, { chats: [family, other], othersGateways: [] })).toBe("telegram:main:-100");
    const quiet: ReachableChat = { ...family, chatId: "777@g.us", lastActive: 0 };
    expect(chatOf("keluarga besar", here, { chats: [family, quiet], othersGateways: [] })).toBe("whatsapp:main:1203@g.us");
    const twice = { chats: [family, { ...family, chatId: "778@g.us" }], othersGateways: [] };
    const answer = chatOf("keluarga besar", here, twice);
    expect(answer).toStartWith('refused: "keluarga besar" could be 2 chats.');
    expect(answer).toContain("`whatsapp:main:778@g.us`");
  });

  test("nothing it can reach: refused with the chats it can, addresses and keys", () => {
    const answer = chatOf("grup wa");
    expect(answer).toContain('No chat you can reach is "grup wa".');
    expect(answer).toContain('`whatsapp:main:1203@g.us`: the whatsapp group "Keluarga Besar" (Mira Wati, Budi)');
    expect(answer).toContain('`telegram:main:555`: the telegram one-to-one with Mira Wati · to: "mira"');
  });

  test("an address of a chat it never talked in is not reachable, even on its own connection", () => {
    expect(chatOf("telegram:main:999")).toContain('No chat you can reach is "telegram:main:999"');
  });

  test("another agent's connection is refused as such", () => {
    expect(chatOf("telegram:nox:555")).toBe("refused: telegram:nox is another agent's connection, and you only send through your own");
  });

  test("the chat it is in is a reply, not a message — by address or by name", () => {
    expect(chatOf("telegram:main:814")).toContain("that is the chat you are in");
    expect(chatOf("gading")).toContain("that is the chat you are in");
  });

  test("an empty `to` lists the chats", () => {
    expect(chatOf("  ")).toContain("`to` is empty.");
  });

  test("with no chat to reach, it says where a message can go by the People list's name, not a config table's", () => {
    const answer = chatOf("mira", here, { chats: [], othersGateways: [] });
    expect(answer).toContain("you can only send into a chat you have already talked in, or to a person on the People list through a connection of your own.");
    expect(answer).not.toContain("[[people]]");
  });
});

describe("the tool", () => {
  const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "814", gateway: "telegram", senderId: "814", chatType: "dm" } as ToolContext;

  function tool(post: (chat: ReachableChat, text: string) => { ok: true } | { ok: false; reason: string } = () => ({ ok: true })) {
    const posted: { chat: string; text: string }[] = [];
    const made = createSendMessageTool({
      targets: () => targets,
      post: async (_ctx, chat, text) => {
        posted.push({ chat: `${chat.gatewayId}:${chat.chatId}`, text });
        return post(chat, text);
      },
    });
    return { made, posted };
  }

  test("asks, naming where it goes; never grantable for good", () => {
    const decision = tool().made.gate!({ to: "keluarga besar", text: "Rapat jam 7." }, ctx);
    expect(decision).toEqual({ action: "ask", grantable: false, reason: 'it sends a message to the whatsapp group "Keluarga Besar" (Mira Wati, Budi), outside this conversation' });
  });

  test("an unknown `to` or no text is refused before anybody is asked", () => {
    const { made } = tool();
    expect(made.gate!({ to: "grup wa", text: "x" }, ctx).action).toBe("refuse");
    expect(made.gate!({ to: "mira", text: "  " }, ctx)).toEqual({ action: "refuse", reason: "`text` is empty" });
  });

  test("sends to the chat `to` resolved to, and says so", async () => {
    const { made, posted } = tool();
    const result = await made.execute({ to: "telegram:main:555", text: "Jangan lupa obatnya." }, ctx);
    expect(result.isError).toBe(false);
    expect(posted).toEqual([{ chat: "telegram:main:555", text: "Jangan lupa obatnya." }]);
    // Said to be done, so the agent does not go and check: live, it read the daemon's database to confirm a send.
    expect(result.content).toStartWith("Delivered to the telegram one-to-one with Mira Wati: the platform took it, so there is nothing to check.");
  });

  test("a send the platform refused is an error the model reads", async () => {
    const { made } = tool(() => ({ ok: false, reason: "whatsapp did not take it" }));
    const result = await made.execute({ to: "keluarga besar", text: "x" }, ctx);
    expect(result).toMatchObject({ isError: true, content: 'Not sent to the whatsapp group "Keluarga Besar" (Mira Wati, Budi): whatsapp did not take it' });
  });

  test("the audit keeps where and how long, not the words", () => {
    expect(tool().made.auditArgs!({ to: "keluarga besar", text: "Rapat jam 7." }, ctx)).toEqual({ to: "keluarga besar", chat: "whatsapp:main:1203@g.us", chars: 12 });
  });
});

describe("in a toolset", () => {
  const agentWith = (enabled: string[]) => fakeAgent({ config: { ...fakeAgent().config, tools: { enabled, approvalRequired: [], blocked: [] } } });
  const sendFile: Tool = { requiresApproval: false, definition: { name: "send_file", description: "", parameters: {} }, execute: async () => ({ content: "", isError: false }) };
  const registry = new Map<string, Tool>([
    ["send_file", sendFile],
    ["send_message", createSendMessageTool({ targets: () => targets, post: async () => ({ ok: true }) })],
  ]);
  const resolved = (enabled: string[]) => resolveToolset(agentWith(enabled), registry, DEFAULT_CONFIG.security);

  test("comes with send_file, for the packs written before it, and only with it", () => {
    expect(resolved(["send_file"]).definitions.map((tool) => tool.name)).toEqual(["send_file", "send_message"]);
    expect(resolved(["read"]).definitions.map((tool) => tool.name)).toEqual([]);
  });

  test("asks whatever the pack's approval_required says — its own gate decides", () => {
    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "814", gateway: "telegram" } as ToolContext;
    expect(resolved(["send_message"]).gate("send_message", { to: "keluarga besar", text: "hai" }, ctx).action).toBe("ask");
  });
});
