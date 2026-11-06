/**
 * A command a person was told to run, gone from the words they read (0.8.19, "the dashboard in plain words"): the
 * people who use the dashboard are not technical, and a terminal is not where they go. Where the dashboard has a way, the
 * page offers it (the Pending tab, a button that asks the orchestrator); where only whoever runs the server can, the
 * page says so and the command is under Details. Each page here, rendered, holds no command outside a Details section.
 */

import { describe, expect, test } from "bun:test";
import { MCP_LOGIN_CALLBACK } from "@/commons/lib/session";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const COMMAND = /nouride [a-z]|journalctl|systemctl|ollama pull|(?<![\w-])--[a-z]/;

/** What a person reads without opening a Details section. */
const plain = (host: HTMLElement) => {
  const copy = host.cloneNode(true) as HTMLElement;
  for (const details of copy.querySelectorAll("details")) if (details.querySelector(":scope > summary")?.textContent === "Details") details.remove();
  return copy.textContent ?? "";
};
const inDetails = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("details")].some((details) => details.querySelector(":scope > summary")?.textContent === "Details" && details.textContent?.includes(text));
const ok = (body: unknown) => ({ status: 200, body });

describe("no command where a person reads", () => {
  test("Skills: a new draft is found on the Pending tab, one press away", async () => {
    answer({ "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }) });
    await renderPage("/skills", async (host) => {
      await eventually(() => plain(host).includes("as the only place to find one"), 2_000, "the learning panel");
      expect(plain(host)).not.toMatch(COMMAND);
      ([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Pending tab") as HTMLElement).click();
      await eventually(() => plain(host).includes("0 drafts waiting on you"), 2_000, "the Pending tab");
    });
  });

  test("Access: accounts the settings let in, and how to manage one here, said for whoever runs the server", async () => {
    answer({ "/access": ok({ mode: "pair", editable: true, allowlist: ["telegram:nouva:5550003333"], senders: [] }) });
    await renderPage("/access?tab=approved", async (host) => {
      await eventually(() => plain(host).includes("Always allowed"), 2_000, "the card");
      expect(plain(host)).not.toMatch(COMMAND);
      expect(plain(host)).not.toContain("config.toml");
      expect(inDetails(host, "nouride access allow")).toBe(true);
    });
  });

  test("a sign-in that did not finish: the terminal's way is under Details", async () => {
    answer({ "/mcp/oauth/finish": { status: 400, body: { error: "that login has already been used" } } });
    await renderPage(`${MCP_LOGIN_CALLBACK}?code=c&state=s`, async (host) => {
      await eventually(() => plain(host).includes("The login did not finish here"), 2_000, "the failure");
      expect(plain(host)).toContain("that login has already been used");
      expect(plain(host)).not.toMatch(COMMAND);
      expect(inDetails(host, "nouride mcp login")).toBe(true);
    });
  });

  test("Memory: Ollama's model download is under Details", async () => {
    answer({ "/providers": ok({ editable: true, providers: [{ name: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeySecret: "claude", hasCredential: true, builtIn: false }] }) });
    await renderPage("/memories", async (host) => {
      ([...host.querySelectorAll('[role="tablist"] > [role="tab"]')].find((tab) => tab.textContent?.startsWith("Settings")) as HTMLElement).click();
      await eventually(() => plain(host).includes("That machine needs the model downloaded first."), 2_000, "the guide");
      expect(plain(host)).not.toMatch(COMMAND);
      expect(inDetails(host, "ollama pull bge-m3")).toBe(true);
    });
  });
});
