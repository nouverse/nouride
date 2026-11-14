/**
 * "How to get an API key" where a provider is added: on the Models page's form and in the first-run setup. Folded
 * until asked for; each service a link to the page its key is made on, marked as charged by use or part of a plan;
 * and "Use it" fills the form with that service's address, keeping a name already typed.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const block = (host: HTMLElement) => [...host.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent?.includes("How to get an API key")) as HTMLDetailsElement | undefined;
const rows = (host: HTMLElement) => [...(block(host)?.querySelectorAll("li") ?? [])];
const row = (host: HTMLElement, name: string) => rows(host).find((li) => li.querySelector("a")?.textContent?.trim() === name)!;
const field = (host: HTMLElement, label: string) => [...host.querySelectorAll("label")].find((element) => element.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement>("input") ?? null;

describe("How to get an API key, on the Models page", () => {
  test("is folded under the key's field, and opened lists each service with its link and what it costs", async () => {
    answer({});
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Add Provider")), 3_000, "the Models page");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add Provider"))!.click();
      await eventually(() => block(host) !== undefined, 3_000, "the form with its hints");
      expect(block(host)!.open).toBe(false);
      expect(rows(host).map((li) => li.querySelector("a")!.textContent!.trim())).toEqual(["OpenAI", "Anthropic", "Google Gemini", "DeepSeek", "Z.ai", "OpenCode Zen", "Command Code"]);
      // Each name is the way to the page where its key is made, in a tab of its own.
      const link = row(host, "Command Code").querySelector("a")!;
      expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["https://commandcode.ai/settings/keys", "_blank", "noreferrer noopener"]);
      // What it costs, marked and said.
      expect(row(host, "Command Code").textContent).toContain("In your plan");
      expect(row(host, "Command Code").textContent).toContain("nothing is charged outside it");
      expect(row(host, "OpenAI").textContent).toContain("Pay per use");
      expect(row(host, "OpenAI").textContent).toContain("A ChatGPT subscription does not cover it.");
      expect(rows(host).filter((li) => li.textContent?.includes("In your plan")).map((li) => li.querySelector("a")!.textContent!.trim())).toEqual(["Command Code"]);
    });
  });

  test("Use it fills how it is talked to, its address and a name; a name already typed is kept", async () => {
    answer({});
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Add Provider")), 3_000, "the Models page");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add Provider"))!.click();
      await eventually(() => block(host) !== undefined, 3_000, "the form with its hints");
      const kind = () => host.querySelector<HTMLSelectElement>("form select")!.value;
      row(host, "Anthropic").querySelector<HTMLButtonElement>('button[aria-label="Use Anthropic"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.anthropic.com/v1", 2_000, "Anthropic's address");
      expect(kind()).toBe("anthropic");
      expect(field(host, "Name")?.value).toBe("anthropic");
      // Another one: the address and the way it is talked to follow, the name stays the one that is there.
      row(host, "DeepSeek").querySelector<HTMLButtonElement>('button[aria-label="Use DeepSeek"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
      expect(kind()).toBe("openai");
      expect(field(host, "Name")?.value).toBe("anthropic");
      // Nothing was sent by filling a form.
      expect(field(host, "API Key")?.value).toBe("");
    });
  });
});

describe("How to get an API key, in the first-run setup", () => {
  test("is the same block under the key's field, and Use it fills the setup's own form", async () => {
    answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false } } });
    await renderPage("/setup", async (host) => {
      await eventually(() => block(host) !== undefined, 3_000, "the setup's key form with its hints");
      expect(block(host)!.open).toBe(false);
      expect(rows(host)).toHaveLength(7);
      type(field(host, "Name")!, "mine");
      row(host, "Command Code").querySelector<HTMLButtonElement>('button[aria-label="Use Command Code"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.commandcode.ai/provider/v1", 2_000, "Command Code's address");
      expect(field(host, "Name")?.value).toBe("mine");
      // The way it is talked to follows the line: the setup's own switch says so.
      row(host, "Anthropic").querySelector<HTMLButtonElement>('button[aria-label="Use Anthropic"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.anthropic.com/v1", 2_000, "Anthropic's address");
      expect(host.textContent).toContain("Claude, from Anthropic, or a service that works like it.");
    });
  });
});
