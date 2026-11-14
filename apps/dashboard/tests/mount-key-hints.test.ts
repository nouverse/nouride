/**
 * "How to get an API key" where a provider is added: on the Models page's form and in the first-run setup. Folded
 * until asked for; each service a link to the page its key is made on, marked as charged by use or part of a plan;
 * and "Use it" fills the form with that service's address and its name, unless the person typed a name of their own.
 */

import { describe, expect, test } from "bun:test";
import { answer, enabled, press, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const block = (host: HTMLElement) => [...host.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent?.includes("How to get an API key")) as HTMLDetailsElement | undefined;
const rows = (host: HTMLElement) => [...(block(host)?.querySelectorAll("li") ?? [])];
const row = (host: HTMLElement, name: string) => rows(host).find((li) => li.querySelector("a")?.textContent?.trim() === name)!;
/** "Extra headers": the folded block, and the lines in it. */
const extra = (host: HTMLElement) => [...host.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent?.includes("Extra headers")) as HTMLDetailsElement | undefined;
const lines = (host: HTMLElement) => extra(host)?.querySelector<HTMLTextAreaElement>("textarea") ?? null;
const use = (host: HTMLElement, name: string) => row(host, name).querySelector<HTMLButtonElement>(`button[aria-label="Use ${name}"]`)!.click();
const GO_HEADER = "x-opencode-session: {session}";
const field = (host: HTMLElement, label: string) => [...host.querySelectorAll("label")].find((element) => element.textContent?.trim().startsWith(label))?.querySelector<HTMLInputElement>("input") ?? null;

describe("How to get an API key, on the Models page", () => {
  test("is folded under the key's field, and opened lists each service with its link and what it costs", async () => {
    answer({});
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Add Provider")), 3_000, "the Models page");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add Provider"))!.click();
      await eventually(() => block(host) !== undefined, 3_000, "the form with its hints");
      expect(block(host)!.open).toBe(false);
      expect(rows(host).map((li) => li.querySelector("a")!.textContent!.trim())).toEqual(["OpenAI", "Anthropic", "Google Gemini", "DeepSeek", "Z.ai", "OpenCode Zen", "OpenCode Go", "Command Code"]);
      // Each name is the way to the page where its key is made, in a tab of its own.
      const link = row(host, "Command Code").querySelector("a")!;
      expect([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]).toEqual(["https://commandcode.ai/settings/keys", "_blank", "noreferrer noopener"]);
      // What it costs, marked and said.
      expect(row(host, "Command Code").textContent).toContain("In your plan");
      expect(row(host, "Command Code").textContent).toContain("nothing is charged outside it");
      expect(row(host, "OpenAI").textContent).toContain("Pay per use");
      expect(row(host, "OpenAI").textContent).toContain("A ChatGPT subscription does not cover it.");
      expect(rows(host).filter((li) => li.textContent?.includes("In your plan")).map((li) => li.querySelector("a")!.textContent!.trim())).toEqual(["OpenCode Go", "Command Code"]);
      // Two services of one company, one charged and one in a plan: each marked as what it is.
      expect(row(host, "OpenCode Zen").textContent).toContain("Pay per use");
      expect(row(host, "OpenCode Go").textContent).toContain("unless you turn on Extra Usage there");
    });
  });

  test("Use it fills how it is talked to, its address and its name; the name follows each pick until one is typed", async () => {
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
      // Another one: the name the form put there follows with the address. It stayed "anthropic" once, on DeepSeek's address.
      row(host, "DeepSeek").querySelector<HTMLButtonElement>('button[aria-label="Use DeepSeek"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
      expect(kind()).toBe("openai");
      expect(field(host, "Name")?.value).toBe("deepseek");
      row(host, "OpenCode Go").querySelector<HTMLButtonElement>('button[aria-label="Use OpenCode Go"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://opencode.ai/inference/go/openai/v1", 2_000, "OpenCode Go's address");
      expect(field(host, "Name")?.value).toBe("opencode-go");
      // A name the person typed is theirs: the address follows, the name does not.
      type(field(host, "Name")!, "work");
      row(host, "OpenAI").querySelector<HTMLButtonElement>('button[aria-label="Use OpenAI"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.openai.com/v1", 2_000, "OpenAI's address");
      expect(field(host, "Name")?.value).toBe("work");
      // Emptied, it follows again.
      type(field(host, "Name")!, "");
      row(host, "Z.ai").querySelector<HTMLButtonElement>('button[aria-label="Use Z.ai"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.z.ai/api/paas/v4", 2_000, "Z.ai's address");
      expect(field(host, "Name")?.value).toBe("zai");
      // Nothing was sent by filling a form.
      expect(field(host, "API Key")?.value).toBe("");
    });
  });
});

describe("Extra headers, on the Models page", () => {
  const opened = async (host: HTMLElement) => {
    await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Add Provider")), 3_000, "the Models page");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Add Provider"))!.click();
    await eventually(() => extra(host) !== undefined, 3_000, "the form with its extra headers");
  };

  test("are folded and empty until a picked service asks for one: OpenCode Go's is filled in and shown, and goes with the next pick", async () => {
    answer({});
    await renderPage("/models", async (host) => {
      await opened(host);
      expect(extra(host)!.open).toBe(false);
      expect(lines(host)!.value).toBe("");
      // The words of the field: what it is for, how a line is written, and what `{session}` means.
      expect(extra(host)!.textContent).toContain("Only if your provider asks for them. One on each line, as Name: value.");
      expect(extra(host)!.textContent).toContain("Where a provider wants an id for each conversation, write {session} as the value.");
      expect(extra(host)!.textContent).not.toContain("A saved one shows its name only");

      use(host, "OpenCode Go");
      await eventually(() => lines(host)?.value === GO_HEADER, 2_000, "Go's header in the field");
      // Opened by itself, with a count beside its name: a person sees what was put there for them.
      await eventually(() => extra(host)!.open, 2_000, "the block opened");
      expect(extra(host)!.querySelector("summary")!.textContent).toContain("1");

      // A service that asks for none: the header the form put there does not stay on a provider pointed elsewhere.
      use(host, "DeepSeek");
      await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
      expect(lines(host)!.value).toBe("");
    });
  });

  test("a header the person typed is theirs through any pick, and the save sends every line of the field", async () => {
    answer({});
    const posted = recordPosts({ "/providers": { status: 200, body: { ok: true, restartRequired: false } } });
    try {
      await renderPage("/models", async (host) => {
        await opened(host);
        use(host, "OpenCode Go");
        await eventually(() => lines(host)?.value === GO_HEADER, 2_000, "Go's header in the field");
        type(lines(host)!, `${GO_HEADER}\nx-team: ops`);
        use(host, "OpenAI");
        await eventually(() => field(host, "Base URL")?.value === "https://api.openai.com/v1", 2_000, "OpenAI's address");
        expect(lines(host)!.value).toBe(`${GO_HEADER}\nx-team: ops`);

        type(field(host, "API Key")!, "typed-key");
        await enabled(host, "Add Profile");
        press(host, "Add Profile");
        await eventually(() => posted.posts.some((post) => post.path === "/providers"), 3_000, "the save");
        expect(posted.posts.find((post) => post.path === "/providers")!.body).toEqual({
          name: "openai",
          kind: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "typed-key",
          headers: { "x-opencode-session": "{session}", "x-team": "ops" },
        });
      });
    } finally {
      posted.restore();
    }
  });

  test("a provider added with none sends an empty set, not nothing", async () => {
    answer({});
    const posted = recordPosts({ "/providers": { status: 200, body: { ok: true, restartRequired: false } } });
    try {
      await renderPage("/models", async (host) => {
        await opened(host);
        use(host, "DeepSeek");
        await eventually(() => field(host, "Name")?.value === "deepseek", 2_000, "DeepSeek's name");
        type(field(host, "API Key")!, "typed-key");
        await enabled(host, "Add Profile");
        press(host, "Add Profile");
        await eventually(() => posted.posts.some((post) => post.path === "/providers"), 3_000, "the save");
        expect(posted.posts.find((post) => post.path === "/providers")!.body).toMatchObject({ name: "deepseek", headers: {} });
      });
    } finally {
      posted.restore();
    }
  });

  test("a saved provider shows its headers by name, a value only where it is {session}; a pick leaves them, and the save keeps what it was not shown", async () => {
    answer({
      "/providers": {
        status: 200,
        body: { providers: [{ name: "work", kind: "openai", baseUrl: "https://gate.example/v1", apiKeySecret: "work_api_key", hasCredential: true, builtIn: false, headers: { "x-gateway-key": null, "x-opencode-session": "{session}" } }], editable: true },
      },
    });
    const posted = recordPosts({ "/providers": { status: 200, body: { ok: true, restartRequired: false } } });
    try {
      await renderPage("/models", async (host) => {
        await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Edit"), 3_000, "the saved provider");
        press(host, "Edit");
        await eventually(() => extra(host) !== undefined, 3_000, "its form");
        expect(lines(host)!.value).toBe(`x-gateway-key:\n${GO_HEADER}`);
        expect(extra(host)!.open).toBe(true);
        expect(extra(host)!.textContent).toContain("A saved one shows its name only: leave its line as it is to keep it, or remove the line to drop it.");
        // They may be its operator's own: a pick changes where it points, and leaves them.
        use(host, "DeepSeek");
        await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
        expect(lines(host)!.value).toBe(`x-gateway-key:\n${GO_HEADER}`);

        press(host, "Save Changes");
        await eventually(() => posted.posts.some((post) => post.path === "/providers"), 3_000, "the save");
        expect(posted.posts.find((post) => post.path === "/providers")!.body).toEqual({
          name: "work",
          kind: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          headers: { "x-gateway-key": null, "x-opencode-session": "{session}" },
        });
      });
    } finally {
      posted.restore();
    }
  });

  test("a saved provider with none takes the header of a service picked for it", async () => {
    answer({ "/providers": { status: 200, body: { providers: [{ name: "work", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeySecret: "work_api_key", hasCredential: true, builtIn: false, headers: {} }], editable: true } } });
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Edit"), 3_000, "the saved provider");
      press(host, "Edit");
      await eventually(() => extra(host) !== undefined, 3_000, "its form");
      expect(lines(host)!.value).toBe("");
      use(host, "OpenCode Go");
      await eventually(() => lines(host)?.value === GO_HEADER, 2_000, "Go's header in the field");
      expect(field(host, "Name")?.value).toBe("work");
    });
  });
});

describe("Extra headers, in the first-run setup", () => {
  test("follow the picked service and the kind switch, and go with the provider the setup saves", async () => {
    answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false } } });
    const posted = recordPosts({
      "/setup/probe": { status: 200, body: { ok: true, models: ["glm-5.3"] } },
      "/setup/provider": { status: 200, body: { ok: true, models: ["glm-5.3"] } },
    });
    try {
      await renderPage("/setup", async (host) => {
        await eventually(() => extra(host) !== undefined, 3_000, "the setup's key form with its extra headers");
        expect(extra(host)!.open).toBe(false);
        use(host, "OpenCode Go");
        await eventually(() => lines(host)?.value === GO_HEADER, 2_000, "Go's header in the field");
        // The switch to another kind of provider takes the header the form put there with it.
        [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Anthropic")!.click();
        await eventually(() => field(host, "Base URL")?.value === "https://api.anthropic.com/v1", 2_000, "Anthropic's address");
        expect(lines(host)!.value).toBe("");

        use(host, "OpenCode Go");
        await eventually(() => lines(host)?.value === GO_HEADER, 2_000, "Go's header again");
        type(field(host, "API Key")!, "typed-key");
        await enabled(host, "Test Connection");
        press(host, "Test Connection");
        await enabled(host, "Save & Continue");
        press(host, "Save & Continue");
        await eventually(() => posted.posts.some((post) => post.path === "/setup/provider"), 3_000, "the save");
        expect(posted.posts.find((post) => post.path === "/setup/provider")!.body).toEqual({
          kind: "openai",
          name: "opencode-go",
          base_url: "https://opencode.ai/inference/go/openai/v1",
          api_key: "typed-key",
          headers: { "x-opencode-session": "{session}" },
          skip_probe: true,
        });
      });
    } finally {
      posted.restore();
    }
  });
});

describe("How to get an API key, on a provider that is already saved", () => {
  test("Use it changes where it points and how it is talked to, never its name: agents refer to it by that", async () => {
    answer({ "/providers": { status: 200, body: { providers: [{ name: "work", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeySecret: "work_api_key", hasCredential: true }], editable: true } } });
    await renderPage("/models", async (host) => {
      await eventually(() => [...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Edit"), 3_000, "the saved provider");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Edit")!.click();
      await eventually(() => block(host) !== undefined, 3_000, "its form with the hints");
      expect(field(host, "Name")?.value).toBe("work");
      expect(field(host, "Name")?.disabled).toBe(true);
      row(host, "DeepSeek").querySelector<HTMLButtonElement>('button[aria-label="Use DeepSeek"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
      expect(field(host, "Name")?.value).toBe("work");
    });
  });
});

describe("How to get an API key, in the first-run setup", () => {
  test("is the same block under the key's field, and Use it fills the setup's own form", async () => {
    answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: false, hasAgent: false } } });
    await renderPage("/setup", async (host) => {
      await eventually(() => block(host) !== undefined, 3_000, "the setup's key form with its hints");
      expect(block(host)!.open).toBe(false);
      expect(rows(host)).toHaveLength(8);
      // The setup's form opens with a name in it, which the form put there: it follows the pick. It stayed "openai".
      expect(field(host, "Name")?.value).toBe("openai");
      row(host, "Command Code").querySelector<HTMLButtonElement>('button[aria-label="Use Command Code"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.commandcode.ai/provider/v1", 2_000, "Command Code's address");
      expect(field(host, "Name")?.value).toBe("commandcode");
      // The way it is talked to follows the line: the setup's own switch says so.
      row(host, "Anthropic").querySelector<HTMLButtonElement>('button[aria-label="Use Anthropic"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.anthropic.com/v1", 2_000, "Anthropic's address");
      expect(host.textContent).toContain("Claude, from Anthropic, or a service that works like it.");
      expect(field(host, "Name")?.value).toBe("anthropic");
      // The switch itself names it too: OpenAI-compatible, then back.
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "OpenAI-compatible")!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.openai.com/v1", 2_000, "the OpenAI-compatible address");
      expect(field(host, "Name")?.value).toBe("openai");
      // A name the person typed is theirs, whatever is picked after.
      type(field(host, "Name")!, "mine");
      row(host, "DeepSeek").querySelector<HTMLButtonElement>('button[aria-label="Use DeepSeek"]')!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.deepseek.com/v1", 2_000, "DeepSeek's address");
      expect(field(host, "Name")?.value).toBe("mine");
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Anthropic")!.click();
      await eventually(() => field(host, "Base URL")?.value === "https://api.anthropic.com/v1", 2_000, "Anthropic's address again");
      expect(field(host, "Name")?.value).toBe("mine");
    });
  });
});
