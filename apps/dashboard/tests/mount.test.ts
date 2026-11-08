/**
 * Every page, mounted.
 *
 * The last of four checks the dashboard was missing, and the one that needed a DOM. The other three tests
 * check the layer under rendering — that routes are declared, that modules import, that the paths
 * they call exist. None of them can see a component that throws the moment React runs it, which is
 * the class of defect that actually reached the operator: clicking **Chat** threw `Cannot read
 * properties of undefined (reading 'length')`, because a plain `useQuery` and an `useInfiniteQuery`
 * shared the key `["sessions", ""]` and whichever mounted first filled the cache with the wrong
 * shape. Nothing static could have found it — both hooks were individually correct.
 *
 * So this drives the real router over the real route tree with the real query client, and asserts
 * that each page produces a tree and raises nothing. It is deliberately not assertions about
 * *content*: a test that pinned the words on a page would fail on every copy edit and teach people
 * to update it without reading. What it pins is that the page runs.
 *
 * ## `fetch` is stubbed, not the API module
 *
 * At the transport, so everything above it is the code that ships — `api.ts`, its query keys, its
 * error handling and the hooks built on it are all exercised. Stubbing `api` instead would have
 * tested a stub, and the collision above lived in the query keys, which is exactly the part a
 * module-level fake replaces.
 *
 * The fixtures answer with the *shapes* `api.ts` declares. A page whose query returns a shape it
 * does not expect is the failure being hunted, so answering `{}` for everything would be a weaker
 * test than answering plausibly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { answer, buttons, enabled, errors, overrides, PAGES, painted, press, recordPosts, renderPage, RESPONSES, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually, sleep } from "./wait.ts";

useMountHarness();

describe("every page mounts", () => {
  for (const [name, path] of PAGES) {
    test(name, async () => {
      const html = await renderPage(path);

      // The two failures worth catching, and they are different: a page that threw leaves evidence
      // in React's logging, and a page that rendered nothing leaves an empty div.
      expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
      expect(html.length).toBeGreaterThan(0);
    });
  }
});

/**
 * Every tab of the Memory menu, clicked through — the loop above only ever sees the first.
 *
 * Each tab is its own component with its own queries, and a tab nobody opens in a test is a tab whose
 * crash ships. So each is opened in turn and asked for the one thing only it draws.
 */
describe("the Memory menu, every tab", () => {
  test("Knowledge, Agent notes, People, Timeline, Shared, Proposals and Settings each render", async () => {
    const drawn: Record<string, string> = {};
    await renderPage("/memories", async (host) => {
      const tabs = [...host.querySelectorAll('[role="tablist"] > [role="tab"]')] as HTMLElement[];
      for (const tab of tabs) {
        tab.click();
        for (let i = 0; i < 6; i += 1) await sleep(10);
        drawn[(tab.textContent ?? "").replace(/\d+$/, "").trim()] = host.innerHTML;
      }
    });

    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(Object.keys(drawn)).toEqual(["Knowledge", "Agent notes", "People", "Timeline", "Shared", "Proposals", "Settings"]);
    expect(drawn.Knowledge).toContain("Your agents may answer anyone from it.");
    // A profile's fact, with its readers by name; someone without a key offers to start learning.
    expect(drawn.People).toContain("Uses a MacBook M3.");
    // What changed, and why, above the profiles.
    expect(drawn.People).toContain("Recent changes");
    expect(drawn.People).toContain("profile tidy-up");
    expect(drawn.People).toContain("told by someone else");
    expect(drawn.People).toContain("Owns a MacBook Air M1 laptop.");
    // Everybody has a key since 0.7.0 — a person is one — so nobody waits to "start learning".
    expect(drawn.People).not.toContain("Start learning");
    expect(drawn.People).toContain("raka");
    expect(drawn.People).toContain("Memory is on");
    expect(drawn.Timeline).toContain("Planning a trip to Bali.");
    expect(drawn.Timeline).toContain("#travel");
    // Not summarized yet: the first thing said, and what it waits for.
    expect(drawn.Timeline).toContain("“Cari memori soal board STB”");
    expect(drawn.Timeline).toContain("Waiting for the nightly pass at 01:00.");
    expect(drawn.Timeline).toContain("2026-09-25-2210-nouva");
    expect(drawn.Shared).toContain("The router is in the hall.");
    expect(drawn["Agent notes"]).toContain("Nouva");
    expect(drawn.Proposals).toContain("The porch light goes off at 22:00.");
    // One card per thing it decides, nothing folded away; the rest sits beside what it shapes.
    for (const card of ["Nightly pass", "Helper model", "What agents see", "Semantic search"]) expect(drawn.Settings).toContain(card);
    // There is no owner: nothing to choose in Settings, no badge on People.
    expect(drawn.Settings).not.toContain("Nobody (memory off)");
    expect(drawn.People).not.toContain(">Owner<");
    expect(drawn.Settings).not.toContain("<details");
    expect(drawn.Settings).toContain("Attempts per conversation");
    expect(drawn.Settings).toContain("Summaries only, never transcripts");
    const semantic = (WIRE["/memory/status"] as { semantic: { items: number; model: string } }).semantic;
    expect(drawn.Settings).toContain(`${semantic.items} item(s) embedded with ${semantic.model}.`);
    expect(drawn.Settings).not.toContain("Keep transcripts for");
    expect(drawn.Settings).not.toContain("Save facts from conversations");
    expect(drawn.Timeline).toContain("Transcripts");
    expect(drawn.Timeline).toContain("Archive old transcripts");
    // Days by default, with forever one switch away; archiving is live while there are days.
    expect(drawn.Timeline).toContain("Keep transcripts forever");
    expect(drawn.Timeline).toContain("Keep for");
    expect(drawn.People).toContain("Save facts from conversations");
    expect(drawn.Shared).toContain("Suggest shared knowledge from conversations");
    expect(drawn.Settings).toContain("ollama lists no embedding models.");
    // The pass's model is a choice first; provider and model appear only for one model for all.
    expect(drawn.Settings).toContain("Each agent's own model");
    expect(drawn.Settings).not.toContain("Nightly pass provider");
    expect(drawn.Settings).not.toContain("MCP server");
  });
});

/**
 * The memory graph: drawn, filtered, empty, and failed (dash-practice-tests-untypechecked-and-mount-gaps).
 *
 * The one page no test drew — its canvas wanted a 2D context happy-dom does not have — so a crash on it would
 * have shipped with the suite green.
 */
describe("the memory graph", () => {
  /** A few frames: the canvas paints on the next animation frame, and the layout ticks after that. */
  const frames = async () => {
    for (let i = 0; i < 6; i += 1) await sleep(20);
  };
  const crashes = () => errors.filter((line) => /Error|error boundary|Cannot read/.test(line));

  test("draws every kind of node, names the hubs, and lists the kinds it shows", async () => {
    const html = await renderPage("/memories/graph", frames);
    expect(crashes()).toEqual([]);
    expect(html).toContain("<canvas");
    for (const kind of ["Conversations", "People", "Tags", "Agents"]) expect(html).toContain(kind);
    // On the canvas: a dot for each node, and the hubs' names — the person, the tag and the agent.
    expect(painted.filter((call) => call.method === "arc").length).toBeGreaterThanOrEqual(5);
    expect(painted.filter((call) => call.method === "fillText").map((call) => call.args[0])).toEqual(expect.arrayContaining(["Gading", "#home", "nouva"]));
  });

  test("filters by what the vault holds, and a filter can be cleared", async () => {
    const html = await renderPage("/memories/graph", async (host) => {
      (host.querySelector('button[aria-label="People"]') as HTMLElement).click();
      await frames();
      // The list is drawn on the page's body, not inside the filter (`placeMenu`): looked for there.
      const gading = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("Gading")) as HTMLElement;
      gading.click();
      await frames();
    });
    expect(crashes()).toEqual([]);
    // The filter shows who it narrows to, and the page offers the way back.
    expect(html).toMatch(/aria-label="People"[^>]*>[\s\S]*?Gading/);
    expect(html).toContain("Clear");
  });

  test("says when there is nothing to draw", async () => {
    answer({ "/memory/graph": { status: 200, body: { nodes: [], links: [], episodes: 0, total: 0 } } });
    const html = await renderPage("/memories/graph", frames);
    expect(crashes()).toEqual([]);
    expect(html).toContain("Nothing remembered yet");
    expect(html).not.toContain("<canvas");
  });

  test("says what failed when the graph cannot be read", async () => {
    answer({ "/memory/graph": { status: 500, body: { error: "the memory index is not readable" } } });
    const html = await renderPage("/memories/graph", frames);
    expect(crashes()).toEqual([]);
    expect(html).toContain("the memory index is not readable");
    expect(html).toContain('role="alert"');
  });
});

/**
 * Skills from hubs: the Explore tab searches every hub and installs into Pending.
 */
describe("pages that keep their lists in bounds", () => {
  const ok = (body: unknown) => ({ status: 200, body });
  const clickText = async (host: HTMLElement, selector: string, text: string) => {
    const target = [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)) as HTMLElement | undefined;
    if (!target) throw new Error(`nothing matching ${selector} with "${text}"`);
    target.click();
    for (let i = 0; i < 4; i += 1) await sleep(10);
  };
  afterEach(() => {
    answer({});
  });

  test("Overview: today's spend first, closed until opened; the Office in place of the agent and gateway lists", async () => {
    answer({
      "/status": ok({
        status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nero",
        agents: [
          { id: "nouva", displayName: "Nouva", enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" },
          { id: "nero", displayName: "Nero", enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" },
        ],
      }),
      "/usage": ok({ days: 1, total: { usd: 1.2345, inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cacheCreationInputTokens: 0, requests: 7 }, byModel: [], byAgent: [] }),
    });
    const closed = await renderPage("/");
    expect(closed.indexOf("AI usage and spend")).toBeLessThan(closed.indexOf("Active Agents"));
    // Tokens, compact, and the cached share — no dollars in the header.
    expect(closed).toMatch(/>100<\/span> in ·.*?>50<\/span> out ·.*?>0%<\/span> cached/s);
    expect(closed).not.toContain("$1.2345");
    expect(closed).not.toContain("Tokens read");
    // The Office, small, where the lists were (0.8.15): who is doing what, and a way in.
    expect(closed).toContain("data-office-teaser");
    expect(closed).toContain("2 idle");
    expect(closed).toContain('aria-label="Open the Office: 2 idle"');
    expect(closed).not.toContain("Live connections bridging chat platforms to agents.");
    expect(closed).not.toContain("Active persona packs and their runtime state.");

    const open = await renderPage("/", (host) => clickText(host, "button[aria-expanded]", "AI usage"));
    expect(open).toContain("Tokens read");
  });

  test("Users: what the roles mean comes before the accounts, which scroll", async () => {
    answer({
      "/users": ok({ multiUser: true, users: [{ id: "u1", username: "tester", role: "admin", createdAt: 0, mustChangePassword: false }] }),
    });
    const html = await renderPage("/users");
    expect(html.indexOf("Role Permissions Summary")).toBeLessThan(html.indexOf(">Accounts<"));
    // Held to the window, the list scrolling inside its card (fillsViewport).
    expect(html).toMatch(/lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);
  });

  test("Memory: an open profile scrolls inside itself, under a header that stays", async () => {
    const html = await renderPage("/memories", (host) => clickText(host, '[role="tab"]', "People"));
    expect(html).toMatch(/<summary class="[^"]*sticky top-0/);
    expect(html).toMatch(/max-h-\[55vh\] overflow-y-auto/);
  });

  test("Memory: Agent notes, Proposals and Timeline scroll inside their cards", async () => {
    for (const tab of ["Agent notes", "Proposals", "Timeline"]) {
      const html = await renderPage("/memories", (host) => clickText(host, '[role="tab"]', tab));
      expect(html).toMatch(/max-h-\[32rem\] overflow-y-auto/);
    }
  });

  test("Skills: opens on the pool when nothing waits; each tab shows its own list", async () => {
    answer({ "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }) });
    const live = await renderPage("/skills");
    // The panel's name on screen; the config and the CLI keep `[skills.learning]`.
    expect(live).toContain("Self-Improving Skill");
    expect(live).not.toContain("Skill learning");
    expect(live).not.toContain("drafts waiting on you");
    expect(live).toMatch(/skills? live/);
    expect(live).not.toMatch(/>All</);
    const pending = await renderPage("/skills", (host) => clickText(host, '[role="tab"]', "Pending"));
    expect(pending).toContain("0 drafts waiting on you");
    expect(pending).not.toMatch(/skills? live/);
  });
});

describe("Skills lists", () => {
  const skill = (name: string, description: string) => ({
    name, description, scope: "shared", path: `/srv/nouride/.nouride/agents/skills/${name}/SKILL.md`, requires: [], missing: [],
    needsTools: [], offGlobally: false, agents: [{ id: "nouva", displayName: "Nouva", enabled: true, decided: true, missingTools: [] }], lastUsedAt: null,
  });
  const fixtures = {
    "/skills/catalog": { skills: [skill("pdf-tools", "Work with PDF files"), skill("deploy-k8s", "Ship to Kubernetes")], software: {}, poolDir: "/srv/skills", editable: true },
    "/skills/drafts": { enabled: true, recent: [], pending: [
      { id: "dft_1", createdAt: 0, agentId: "nouva", gatewayId: null, chatId: null, triggerKind: "external_install", triggerReason: "installed from skills.sh", name: "xlsx", description: "Spreadsheets", requires: "", body: "b", target: null, files: [], carries: [], model: null, status: "pending", decidedAt: null, decidedBy: null, publishedPath: null },
    ] },
  };
  const type = async (host: HTMLElement, label: string, text: string) => {
    const input = host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
    if (!input) throw new Error(`no input labelled ${label}`);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
    for (let i = 0; i < 4; i += 1) await sleep(10);
  };

  test("each list scrolls inside its card, filling the window, and has its own filter", async () => {
    Object.assign(overrides, Object.fromEntries(Object.entries(fixtures).map(([path, body]) => [path, { status: 200, body }])));
    try {
      // Something waits, so it opens on Pending.
      const html = await renderPage("/skills");
      expect(html).toContain('aria-label="Filter drafts"');
      expect(html).toMatch(/lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);

      const live = async (host: HTMLElement) => {
        ([...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("Live")) as HTMLElement).click();
        await eventually(() => Boolean(host.querySelector('input[aria-label="Filter skills"]')), 2_000, "the Live list");
        await type(host, "Filter skills", "kubernetes");
      };
      const filtered = await renderPage("/skills", live);
      expect(filtered).toContain("deploy-k8s");
      expect(filtered).not.toContain("pdf-tools");
      expect(filtered).toMatch(/lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);

      const none = await renderPage("/skills", (host) => type(host, "Filter drafts", "nothing like this"));
      expect(none).toContain("No draft matches");
    } finally {
      for (const key of Object.keys(fixtures)) delete overrides[key];
    }
  });
});

describe("Skills Explore", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await sleep(10);
  };
  const clickText = async (host: HTMLElement, selector: string, text: string) => {
    const target = [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)) as HTMLElement | undefined;
    if (!target) throw new Error(`nothing matching ${selector} with "${text}"`);
    target.click();
    await settle();
  };

  test("the tab says what install means, and offers search and a repository field", async () => {
    const html = await renderPage("/skills", (host) => clickText(host, '[role="tab"]', "Explore"));
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Find a skill");
    expect(html).toContain("nothing runs until you do");
    expect(html).toContain("Install from a repository or URL");
    expect(html).toContain("All hubs");
    // Installing by repository comes first: it is the one that needs no searching.
    expect(html.indexOf("Install from a repository or URL")).toBeLessThan(html.indexOf("Find a skill"));
  });

  test("a search lists hits with Install, and says which hub did not answer", async () => {
    const html = await renderPage("/skills", async (host) => {
      await clickText(host, '[role="tab"]', "Explore");
      const input = host.querySelector('input[aria-label="Search skill hubs"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
      setter.call(input, "pdf");
      input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
      await settle();
      await clickText(host, 'button[type="submit"]', "Search");
    });
    expect(html).toContain("skills.sh:anthropics/skills/pdf");
    expect(html).toContain("205,751 installs");
    expect(html).toMatch(/<\/svg> Install<\/button>/);
    expect(html).toContain("clawhub did not answer");
    // The results scroll inside their card rather than pushing the page down.
    expect(html).toMatch(/min-h-0 flex-1[^"]*overflow-y-auto/);
  });
});

/**
 * Web Search: four providers as cards, the steps for the one picked, and a key that can be pasted or
 * picked from Secrets.
 */
describe("Web Search", () => {
  const click = async (host: HTMLElement, selector: string, text: string) => {
    const target = [...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)) as HTMLElement | undefined;
    if (!target) throw new Error(`nothing matching ${selector} with "${text}"`);
    target.click();
    for (let i = 0; i < 4; i += 1) await sleep(10);
  };

  test("says what the agents search with now, and offers the four providers", async () => {
    const html = await renderPage("/web-search");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Agents search with");
    for (const title of ["Free sources", "Brave Search API", "SearXNG", "Another search service"]) expect(html).toContain(title);
    expect(html).toContain("In use");
    expect(html).toContain("How the free sources work");
    // Nothing changed yet: nothing to save.
    expect(html).not.toContain("Unsaved changes");
  });

  test("Brave: how to get a key, and a key pasted or picked from Secrets", async () => {
    const pasted = await renderPage("/web-search", (host) => click(host, '[role="radio"]', "Brave Search API"));
    expect(pasted).toContain("Getting a Brave Search API key");
    expect(pasted).toContain("brave.com/search/api");
    expect(pasted).toContain("Paste a key");
    expect(pasted).toContain('type="password"');
    expect(pasted).toContain("Fall back to the free sources");
    expect(pasted).toContain("Unsaved changes");

    const picked = await renderPage("/web-search", async (host) => {
      await click(host, '[role="radio"]', "Brave Search API");
      await click(host, '[role="tab"]', "Use a saved secret");
    });
    expect(picked).toContain("Pick one from Secrets");
  });

  test("SearXNG: the setup steps, and the two settings a fresh instance gets wrong", async () => {
    const html = await renderPage("/web-search", (host) => click(host, '[role="radio"]', "SearXNG"));
    expect(html).toContain("Running SearXNG beside Nouride");
    expect(html).toContain("formats: [html, json]");
    expect(html).toContain("limiter: false");
    expect(html).toContain("SearXNG Search Address");
  });
});

/**
 * Integrations: Nouride used from other tools. Its own page, so what the MCP server offers is not
 * read as part of memory, and a name that says the direction, so it is not read as an agent's own
 * MCP servers either.
 */
describe("Integrations", () => {
  test("the server's switch and address, tokens with their scopes, a token form with scopes, and the client snippets", async () => {
    const html = await renderPage("/integrations");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Let other apps connect");
    expect(html).toContain("/mcp");
    expect(html).toContain("zed");
    expect(html).toContain(">memory<");
    expect(html).toContain(">personas<");
    expect(html).toContain("Read who the agents are");
    expect(html).toContain("Save conversations");
    expect(html).toContain("memory_save_conversation");
    // The first client's snippet, with this origin's endpoint and a placeholder until a token is made.
    expect(html).toContain("claude mcp add --transport http nouride");
    expect(html).toContain("Bearer &lt;token&gt;");
    expect(html).toContain("search my Nouride memory (memory_search)");
    expect(html).toContain("Add to AGENTS.md");
  });

  test("an agent's own connectors are its Connectors tab, and point the other way", async () => {
    answer({
      "/status": {
        status: 200,
        body: {
          status: "ready", gateways: [], providers: [], uptimeMs: 1000,
          agents: [{ id: "nouva", displayName: "Nouva", enabled: true, state: "ready", provider: "ollama", model: "m", tools: [], approvals: "careful" }],
        },
      },
    });
    const html = await renderPage("/agents/nouva/mcp");
    expect(html).toContain("Manage connectors");
    expect(html).toContain("For other apps using Nouride, see Integrations.");
  });
});

describe("the MCP library (0.7.19)", () => {
  test("Configure → MCP lists each server once, with a chip per agent saying whether it is on", async () => {
    const html = await renderPage("/mcp");
    expect(html).toContain("notion");
    expect(html).toContain("github");
    expect(html).toContain("Used by");
    // github is on for nouva, notion is not — a chip each, pressed or not.
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(html).not.toContain("mcp-lib-github");
  });

  test("an agent's page has every library server, switched as the agent has it, and sends changes to Configure → MCP", async () => {
    const html = await renderPage("/agents/nouva/mcp");
    expect(html).toContain("1 of 2 on");
    expect(html).toContain("Manage connectors");
  });
});

describe("the orchestrator in every agent list", () => {
  afterEach(() => {
    answer({});
  });

  test("first, with a crown — on MCP's chips, whatever order the daemon listed them in", async () => {
    const status = RESPONSES["/status"] as Record<string, unknown>;
    const library = RESPONSES["/mcp/library"] as { servers: { agents: unknown[] }[] };
    answer({
      "/status": { status: 200, body: { ...status, orchestrator: "nox" } },
      "/mcp/library": { status: 200, body: { servers: [{ ...library.servers[1], agents: [{ id: "nouva", on: true, own: false }, { id: "nox", on: false, own: false }] }] } },
    });
    const html = await renderPage("/mcp");
    const chips = [...html.matchAll(/aria-pressed="(?:true|false)"[^>]*>(.*?)<\/button>/g)].map((match) => match[1]!);
    expect(chips[0]).toContain('aria-label="orchestrator"');
    expect(chips[0]).toContain("nox");
    expect(chips[1]).not.toContain("orchestrator");
  });

  test("first, with its badge — on Memory's Agent notes", async () => {
    const status = RESPONSES["/status"] as Record<string, unknown>;
    answer({
      "/status": { status: 200, body: { ...status, orchestrator: "nox" } },
      "/memory/agents": { status: 200, body: { agents: [{ id: "nero", name: "Nero", bytes: 0, updatedAt: null }, { id: "nox", name: "Nox", bytes: 0, updatedAt: null }] } },
    });
    const html = await renderPage("/memories", async (host) => {
      ([...host.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("Agent notes")) as HTMLElement).click();
      await eventually(() => host.innerHTML.includes(">Nero"), 2_000, "the Agent notes list");
    });
    expect(html.indexOf(">Nox")).toBeLessThan(html.indexOf(">Nero"));
    expect(html).toMatch(/>Nox<span class="badge[^"]*">.{0,900}?<\/svg> orchestrator/s);
  });
});

describe("something on its way shows (0.7.19)", () => {
  afterEach(() => {
    answer({});
  });
  /** Click, then wait for what the click should show. */
  const press = async (host: HTMLElement, selector: string, text: string, shows: string) => {
    ([...host.querySelectorAll(selector)].find((el) => el.textContent?.includes(text)) as HTMLElement).click();
    await eventually(() => host.innerHTML.includes(shows), 2_000, shows);
  };

  test("an MCP chip being switched spins, the others do not", async () => {
    answer({ "/agents/nouva/mcp/notion": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/mcp", (host) => press(host, "button[aria-pressed]", "nouva", 'aria-label="loading"'));
    expect(html.match(/aria-label="loading"/g)).toHaveLength(1);
  });

  test("MCP's Explore list loads with a spinner", async () => {
    answer({ "/mcp/catalog": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/mcp", (host) => press(host, '[role="tab"]', "Explore", 'aria-busy="true"'));
    expect(html).toContain('aria-busy="true"');
  });
});

describe("a nightly pass that falls behind (M4)", () => {
  /** The memory page on a tab, once it shows `until` — what the pass card says once the status has come back. */
  const tab = async (name: string, until: string) => {
    let html = "";
    await renderPage("/memories", async (host) => {
      ([...host.querySelectorAll('[role="tablist"] > [role="tab"]')].find((t) => t.textContent?.startsWith(name)) as HTMLElement).click();
      await eventually(() => host.innerHTML.includes(until), 4_000, `the ${name} tab to show "${until}"`);
      html = host.innerHTML;
    });
    return html;
  };
  const status = RESPONSES["/memory/status"] as { pass: Record<string, unknown> & { lastRun: unknown } };

  test("says so on the pass card, with each agent's pace and the count that catches up — and the night's tokens", async () => {
    const backlog = { waiting: 32, oldest: "2026-09-22", perNight: 5, days: 3, agents: [{ agent: "nix", waiting: 2, perDay: 0.7 }, { agent: "nouva", waiting: 30, perDay: 10 }], behind: ["nouva"], enough: 15 };
    const lastRun = { finishedAt: 1_760_000_000_000, cut: 4, filed: 5, failed: 0, problems: [], applied: 0, proposed: 0, dropped: 0, tidied: 0, compacted: 0, restored: 0, waiting: 32, spent: { tokens: 51_200, estimated: true } };
    answer({ "/memory/status": { status: 200, body: { ...status, pass: { ...status.pass, lastRun }, waiting: 32, backlog } } });
    const html = await tab("Timeline", "Falling behind");
    expect(html).toContain("Falling behind: nix 0.7 a day, nouva 10 a day over the 3 day(s) since the first conversation, and the pass");
    expect(html).toContain("Set Conversations per night to 15 in Settings to file the 32 waiting");
    expect(html).toContain("51,200 tokens (estimated)");
  });

  test("says nothing of it while the pass keeps up, or to a daemon too old to send it", async () => {
    // The card's line on what waits comes with the same answer as the note would: once it is there, so would the note be.
    expect(await tab("Timeline", "conversation(s) waiting")).not.toContain("Set Conversations per night");
    const { backlog: _backlog, ...older } = status as Record<string, unknown>;
    answer({ "/memory/status": { status: 200, body: older } });
    expect(await tab("Timeline", "conversation(s) waiting")).not.toContain("Set Conversations per night");
  });

  test("the night's budget is set beside the count", async () => {
    expect(await tab("Settings", "Tokens per night")).toContain("Conversations per night");
  });
});

describe("the nightly pass, above every Memory tab", () => {
  const status = RESPONSES["/memory/status"] as { pass: Record<string, unknown> };
  const page = async (until: string) => {
    let html = "";
    await renderPage("/memories", async (host) => {
      await eventually(() => host.innerHTML.includes(until), 4_000, `the line above the tabs to show "${until}"`);
      html = host.innerHTML;
    });
    return html;
  };
  const night = (hh: number, mm: number) => Date.UTC(2026, 9, 23, hh - 7, mm); // Friday 23 Oct on the daemon's clock, Asia/Jakarta
  const pass = (extra: Record<string, unknown>) => ({ "/memory/status": { status: 200, body: { ...status, pass: { ...status.pass, timeZone: "Asia/Jakarta", ...extra } } } });

  test("while one runs: a spinner, since when, and what is left to file", async () => {
    answer(pass({ running: true, runningSince: night(1, 0) }));
    (overrides["/memory/status"]!.body as { waiting: number }).waiting = 7;
    const html = await page("The nightly pass is running");
    expect(html).toContain("loading-spinner");
    expect(html).toContain("since Fri 23 Oct, 01:00");
    expect(html).toContain("7 conversation(s) left to file");
  });

  test("between runs: when the last one ran, how long it took and what it did, and when the next one is", async () => {
    const lastRun = { startedAt: night(1, 0), finishedAt: night(1, 5), scheduled: true, cut: 14, filed: 14, failed: 2, problems: [], applied: 9, proposed: 0, dropped: 0, tidied: 0, compacted: 0, restored: 0, waiting: 0 };
    answer(pass({ running: false, lastRun, next: { at: Date.now() + 200 * 60_000, due: false } }));
    const html = await page("last pass");
    expect(html).toContain("last pass Fri 23 Oct, 01:05 (took 5 min): 14 filed, 2 failed");
    expect(html).toContain("(in 3 h 20 min)");
  });

  test("its hour gone by and turns still running: due now, and why it waits", async () => {
    answer(pass({ running: false, next: { at: Date.now() - 60_000, due: true } }));
    expect(await page("next pass due now")).toContain("it waits for the turns running to end");
  });
});

describe("transcripts kept forever", () => {
  test("no days to set, and archiving is off with the reason beside it", async () => {
    answer({ "/memory/settings": { status: 200, body: { ...(RESPONSES["/memory/settings"] as object), transcriptDays: 0, archive: true } } });
    let timeline = "";
    await renderPage("/memories", async (host) => {
      const tab = [...host.querySelectorAll('[role="tablist"] > [role="tab"]')].find((t) => t.textContent?.startsWith("Timeline")) as HTMLElement;
      tab.click();
      for (let i = 0; i < 6; i += 1) await sleep(10);
      timeline = host.innerHTML;
    });
    expect(timeline).toContain("Keep transcripts forever");
    expect(timeline).not.toContain("Keep for");
    expect(timeline).toContain("Off while transcripts are kept forever");
  });

  test("the archive's size is shown beside it, and a daemon that does not send it breaks nothing", async () => {
    const timelineOf = async () => {
      let html = "";
      await renderPage("/memories", async (host) => {
        const tab = [...host.querySelectorAll('[role="tablist"] > [role="tab"]')].find((t) => t.textContent?.startsWith("Timeline")) as HTMLElement;
        tab.click();
        for (let i = 0; i < 6; i += 1) await sleep(10);
        html = host.innerHTML;
      });
      return html;
    };
    expect(await timelineOf()).toMatch(/The archive holds 3 transcripts, [\d.]+ K?B\./);
    const { archive: _archive, ...older } = RESPONSES["/memory/status"] as Record<string, unknown>;
    answer({ "/memory/status": { status: 200, body: older } });
    const html = await timelineOf();
    expect(html).toContain("Keep transcripts forever");
    expect(html).not.toContain("The archive holds");
  });
});

/**
 * The setup wizard's last step. `/setup/state` above says the install has a provider and an agent,
 * which is exactly where a person lands after creating their first one.
 */
describe("the setup wizard", () => {
  test("ends on memory, in plain words: remember, learn about you, shared knowledge, a time, and a way to skip", async () => {
    const html = await renderPage("/setup");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Let your agent get to know you");
    for (const label of ["Remember conversations", "Learn about you", "Learn shared knowledge"]) expect(html).toContain(label);
    expect(html).toContain('type="time"');
    expect(html).toContain("Dashboard → Memory");
    expect(html).toContain("Finish setup");
    expect(html).toContain("Skip for now");
    // Plain words: none of the engine's own.
    for (const word of ["Semantic search", "nightly pass", "Proposals", "facts"]) expect(html).not.toContain(word);
  });

  test("suggests the pass on, though a new install's config has it off until this step answers", async () => {
    answer({ "/memory/settings": { status: 200, body: { ...(RESPONSES["/memory/settings"] as object), pass: false } } });
    const html = await renderPage("/setup");
    expect((html.match(/<input[^>]*toggle[^>]*checked=""/g) ?? []).length).toBe(3);
    expect(html).toContain('type="time"');
  });
});

describe("what the wizard's memory step saves", () => {
  test("learning about a person is kept at once; shared knowledge waits for approval; nothing is learned without the pass", async () => {
    const { memorySettingsFor } = await import("../src/modules/setup/MemoryStep");
    expect(memorySettingsFor({ remember: true, at: "02:30", learn: true, shared: true })).toEqual({ pass: true, passAt: "02:30", facts: "auto", proposeShared: true });
    expect(memorySettingsFor({ remember: true, at: "01:00", learn: false, shared: false })).toEqual({ pass: true, passAt: "01:00", facts: "off", proposeShared: false });
    expect(memorySettingsFor({ remember: false, at: "01:00", learn: true, shared: true })).toEqual({ pass: false, facts: "off", proposeShared: false });
  });
});

/**
 * The login page, signed out — the one state the loop above cannot reach.
 *
 * `/auth/me` answers as an admin there, so `/login` redirects to the dashboard and the login page is
 * never the page that renders. That matters now that it has a branch: the OAuth button is drawn from
 * a field on `/setup/state`, and "the daemon says yes and nothing appears" is invisible to a test
 * that only checks the tree is non-empty.
 */
describe("the login page, signed out", () => {
  const SIGNED_OUT = { "/auth/me": { status: 401, body: { error: "unauthorized" } } };

  test("draws the external sign-in button when the daemon offers one", async () => {
    answer({
      ...SIGNED_OUT,
      "/setup/state": {
        status: 200,
        body: { complete: true, hasUser: true, hasProvider: true, hasAgent: true, oauth: { available: true, label: "Nouverse" } },
      },
    });

    const html = await renderPage("/login");

    expect(html).toContain("Continue with Nouverse");
    // A link, not a form control: the flow is a browser navigation to the provider the whole way.
    expect(html).toContain('href="/api/control/auth/oauth/start"');
    // And the password form is still there — an external provider being available never removes the
    // way in that does not depend on it.
    expect(html).toContain("Sign In");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
  });

  test("draws no button when the daemon does not offer one", async () => {
    answer({
      ...SIGNED_OUT,
      "/setup/state": {
        status: 200,
        body: { complete: true, hasUser: true, hasProvider: true, hasAgent: true, oauth: { available: false, label: "Nouverse" } },
      },
    });

    const html = await renderPage("/login");

    expect(html).not.toContain("Continue with");
    expect(html).toContain("Sign In");
  });

  test("hides the password form when the daemon accepts no password", async () => {
    answer({
      ...SIGNED_OUT,
      "/setup/state": {
        status: 200,
        body: {
          complete: true, hasUser: true, hasProvider: true, hasAgent: true,
          passwordLogin: false,
          oauth: { available: true, label: "Nouverse" },
        },
      },
    });

    const html = await renderPage("/login");

    expect(html).toContain("Continue with Nouverse");
    expect(html).not.toContain("Sign In");
    expect(html).not.toContain('type="password"');
    // No divider above a single button: "OR" with nothing on the other side
    // reads as a missing option.
    expect(html).not.toContain(">or<");
  });

  test("says so rather than showing nothing when there is no way in at all", async () => {
    // The daemon refuses to boot into this state — but a browser holding a stale
    // answer must still explain itself rather than render an empty card.
    answer({
      ...SIGNED_OUT,
      "/setup/state": {
        status: 200,
        body: {
          complete: true, hasUser: true, hasProvider: true, hasAgent: true,
          passwordLogin: false,
          oauth: { available: false, label: "Nouverse" },
        },
      },
    });

    const html = await renderPage("/login");

    expect(html).toContain("no way to sign in");
    expect(html).toContain("config.toml");
  });

  test("a daemon that does not know the field at all is the same as no", async () => {
    // An older daemon answers `/setup/state` without `oauth`. That has to read as "no button" rather
    // than as a crash on `.available`.
    answer({ ...SIGNED_OUT });

    const html = await renderPage("/login");

    expect(html).not.toContain("Continue with");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
  });
});

/**
 * Where a queue is *reported* and where it is *decided* are different pages, on purpose.
 *
 * Overview is a glance. An earlier version put Approve buttons on it, next to somebody's name, on a
 * page people skim — and approving a stranger is not undoable by looking away. So Overview says how
 * many and where, and the answer is given on the page that shows the whole request.
 *
 * Asserted on rendered output rather than on the component, because the mistake this guards against
 * is a button being put back, and a unit test of the component nobody edited would not see it.
 */
describe("pending work is announced on Overview and answered elsewhere", () => {
  test("Overview counts both queues and links out, and carries no decision", async () => {
    const html = await renderPage("/");

    expect(html).toContain("1 pending pairing request.");
    expect(html).toContain("1 skill waiting for review.");
    // The two words that must not be on this page. `Deny` would be worse, but `Approve` is the one
    // that was actually there.
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Deny<");
  });

  test("the Access page is where a pairing request is answered — and the sidebar says one is waiting", async () => {
    const html = await renderPage("/access");

    expect(html).toContain("Waiting to be approved (1)");
    // Its platform, from the connection's prefix, beside the agent it wrote to.
    expect(html).toMatch(/badge-ghost[^"]*">Telegram</);
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Block<");
    // On every page, beside Access, because the code expires.
    expect(html).toMatch(/<span>Access<\/span><span[^>]*badge[^>]*>1<\/span>/);
  });

  test("the Agents page carries no decision any more: one place answers every agent's requests", async () => {
    const html = await renderPage("/agents");
    expect(html).not.toContain("Waiting to be approved");
    expect(html).not.toContain(">Approve<");
  });
});

/**
 * Deny is "no, this time" and Block is "until unblocked" — two answers, so two tabs, each with its own
 * way back: Reset for a denial, Unblock for a block.
 */
describe("access: kept out, and the way back", () => {
  const ok = (body: unknown) => ({ status: 200, body });
  const sender = (senderId: string, status: string, extra: Record<string, unknown> = {}) => ({
    gatewayId: "telegram:nouva",
    senderId,
    senderName: `Sender ${senderId}`,
    status,
    code: null,
    chatId: "1",
    requestedAt: 0,
    expiresAt: null,
    resolvedAt: Date.now() - 60 * 60_000,
    resolvedBy: "tester",
    ...extra,
  });

  test("a denial counts down to when they may ask again, and can be reset; a block can be lifted", async () => {
    answer({
      "/access": ok({
        mode: "pair",
        editable: true,
        allowlist: [],
        senders: [sender("111", "denied", { expiresAt: Date.now() + 23 * 3_600_000 }), sender("222", "blocked")],
      }),
    });
    const denied = await renderPage("/access?tab=denied");
    expect(denied).toContain("Denied (1)");
    expect(denied).toContain("may ask again in 23 h");
    expect(denied).toMatch(/>\s?Reset</);
    expect(denied).not.toContain("Sender 222");
    // Every tab draws the platform beside the agent, as Pending does.
    expect(denied).toMatch(/badge-ghost[^"]*">Telegram</);

    const blocked = await renderPage("/access?tab=blocked");
    expect(blocked).toContain("Blocked (1)");
    expect(blocked).toMatch(/>\s?Unblock</);
    expect(blocked).not.toContain("Sender 111");
    expect(blocked).toMatch(/badge-ghost[^"]*">Telegram</);
  });

  test("a person's morning line: off until turned on, and turned on at 07:00 (0.8.0)", async () => {
    answer({ "/people": ok({ people: [{ key: "mira", name: "Mira", ids: ["telegram:555"] }, { key: "alex", name: "Alex", morning: "06:30" }] }) });
    let sent: { path: string; body: unknown }[] = [];
    let page = "";
    await renderPage("/people", async (host) => {
      await eventually(() => host.textContent?.includes("Morning line: off") === true, 2_000, "the people");
      page = host.textContent ?? "";
      const record = recordPosts({ "/people/mira/morning": { status: 200, body: { ok: true, at: "07:00" } } });
      [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Morning line: off"))!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(page).toContain("Morning line at");
    expect(sent).toEqual([{ path: "/people/mira/morning", body: { at: "07:00" } }]);
  });

  test("ids the config lets in are named by People, and said to be nobody else", async () => {
    answer({
      "/access": ok({ mode: "pair", editable: true, allowlist: ["telegram:nouva:5550003333", "discord:nix:999"], senders: [] }),
      "/people": ok({ people: [{ key: "alex", name: "Alex", ids: ["telegram:5550003333"] }] }),
    });
    const html = await renderPage("/access?tab=approved");
    expect(html).toContain("Always allowed");
    expect(html).toContain("nobody else is");
    expect(html).toMatch(/telegram:nouva:5550003333<span[^>]*> · Alex<\/span>/);
  });

  test("a config id blocked on the page says so — the block wins — and no list, no card", async () => {
    answer({
      "/access": ok({ mode: "pair", editable: true, allowlist: ["telegram:nouva:111"], senders: [sender("111", "blocked")] }),
    });
    expect(await renderPage("/access?tab=approved")).toContain("blocked on telegram:nouva");

    answer({ "/access": ok({ mode: "pair", editable: true, allowlist: [], senders: [] }) });
    expect(await renderPage("/access?tab=approved")).not.toContain("Always allowed");
  });

  test("each approved account says which person in People it is, or that nobody is", async () => {
    answer({
      "/access": ok({ mode: "pair", editable: true, allowlist: [], senders: [sender("333", "approved"), sender("444", "approved")] }),
      "/people": ok({ people: [{ key: "alex", name: "Alex", ids: ["telegram:333"] }] }),
    });
    const html = await renderPage("/access?tab=approved");
    expect(html).toMatch(/<a[^>]*href="\/dashboard\/people"[^>]*>.*?Alex<\/a>/s);
    expect(html).toContain("not in People");
  });

  test("an agent's Access tab counts its senders and links to the page, filtered to it", async () => {
    answer({
      "/status": ok({
        status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nouva",
        agents: [{ id: "nouva", displayName: "Nouva", enabled: true, state: "running", provider: "ollama", model: "m", tools: ["read"], approvals: "careful" }],
      }),
      "/gateways": ok({ gateways: [{ id: "telegram:nouva", platform: "telegram", name: "Nouva", enabled: true, tokenSecret: "t", agent: "nouva", status: "connected", hasCredential: true }] }),
      "/access": ok({ mode: "pair", editable: true, allowlist: [], senders: [sender("111", "denied"), sender("222", "blocked"), sender("333", "approved")] }),
    });
    const html = await renderPage("/agents/nouva/access");

    expect(html).toMatch(/>\s?Denied</);
    expect(html).toMatch(/href="\/dashboard\/access\?tab=denied&amp;agent=nouva"/);
    expect(html).toMatch(/href="\/dashboard\/access\?tab=blocked&amp;agent=nouva"/);
  });

  test("an agent's second look says what following the daemon means, and Off is sent as off (0.8.0)", async () => {
    answer({
      "/status": ok({
        status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nouva",
        agents: [{ id: "nouva", displayName: "Nouva", enabled: true, state: "running", provider: "ollama", model: "m", tools: ["read"], approvals: "careful", secondLook: { own: null, install: "" } }],
      }),
    });
    let sent: { path: string; body: unknown }[] = [];
    const html = await renderPage("/agents/nouva/access", async (host) => {
      await eventually(() => host.textContent?.includes("Second look") === true, 2_000, "the card");
      const record = recordPosts({ "/agents/nouva/model_guard": { status: 200, body: { ok: true, value: "off" } } });
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Off"))!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(html).toContain("on at Careful and Balanced, off at Trusted. A scheduled or webhook run is never Trusted, so it looks.");
    expect(html).toContain("another model first checks that the send fits the work. If it does not, you are asked before it goes.");
    expect(sent).toEqual([{ path: "/agents/nouva/model_guard", body: { value: "off" } }]);
  });
});

/**
 * The default agent is listed first everywhere, can be changed on its page, and a new agent starts
 * from a preset — Pilot unless another is picked — instead of the two checkboxes that were there.
 */
describe("agents: orchestrator first, presets, and tools", () => {
  const TWO = {
    "/status": {
      status: 200,
      body: {
        status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nouva",
        agents: [
          { id: "nix", displayName: "Nix", enabled: true, state: "running", provider: "ollama", model: "m", tools: ["read", "ask_agent"], approvals: "careful" },
          { id: "nouva", displayName: "Nouva", enabled: true, state: "running", provider: "ollama", model: "m", tools: ["read", "exec"], approvals: "careful" },
        ],
      },
    },
  };

  test("another agent's page offers to make it the orchestrator; its Settings tab switches its tools", async () => {
    answer(TWO);
    const switches: Record<string, boolean> = {};
    const html = await renderPage("/agents/nix/settings", async (host) => {
      for (let i = 0; i < 6; i += 1) await sleep(10);
      for (const input of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"].checkbox')) switches[input.parentElement?.textContent ?? ""] = input.checked;
    });
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toContain("Make orchestrator");
    expect(html).toContain("Save tools");
    // Its own tool is on, every other this daemon offers is off, and `ask_agent` — which follows the daemon — has no switch.
    expect(Object.entries(switches).filter(([, on]) => on)).toEqual([["read", true]]);
    expect(switches.exec).toBe(false);
    expect(Object.keys(switches)).not.toContain("ask_agent");
  });

  test("the orchestrator's page says so instead", async () => {
    answer(TWO);
    expect(await renderPage("/agents/nouva/model")).not.toContain("Make orchestrator");
  });

  test("the Model tab is only the model; budgets and tools are under Settings", async () => {
    answer(TWO);
    const model = await renderPage("/agents/nix/model");
    expect(model).toContain("Settings");
    expect(model).not.toContain("Save tools");
    const settings = await renderPage("/agents/nix/settings");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(settings).toContain("Save tools");
  });

  test("Settings has the agent's limit for helpers in the background, following the daemon's until it has its own (0.7.15)", async () => {
    answer({ ...TWO, "/policy/delegate": { status: 200, body: { maxBackground: 2, max: 4, editable: true } } });
    const settings = (await renderPage("/agents/nix/settings")).replace(/<[^>]*>/g, "");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(settings).toContain("Helpers in the background");
    expect(settings).toContain("Follows the default (currently 2, and it tracks changes to it)");
    expect(settings).toContain("Up to 2 at once: one for a task that takes a while, more only for independent pieces.");
  });

  test("the Model tab says the window its turns are budgeted at and where that comes from, and lists its fallbacks in order (G2, 0.8.0)", async () => {
    // The engine's own answer for an agent on a model nothing knows (fixtures/wire.json): the guess, said as one.
    const guessed = await renderPage("/agents/nouva/model");
    expect(guessed).toContain("Reads up to 32,000 tokens at a time (a guess)");
    expect(guessed).toContain("Fallbacks");
    expect(guessed).toContain("None: a turn whose model cannot answer ends with what its provider said.");
    expect(guessed).not.toContain("Remove fallback 1");

    const status = WIRE["/status"] as { agents: Record<string, unknown>[] };
    const fallbacks = [{ provider: "test", model: "spare-model" }, { provider: "elsewhere", model: "far-model" }];
    answer({
      "/status": {
        status: 200,
        body: { ...status, agents: status.agents.map((agent) => ({ ...agent, fallbacks, contextWindow: { tokens: 1_000_000, source: "gateway" } })) },
      },
    });
    const stated = await renderPage("/agents/nouva/model");
    expect(stated).toContain("Reads up to 1,000,000 tokens at a time (as its provider says)");
    // Each a provider and a model, in order: the second's provider shown though no profile lists it any more.
    expect(stated.indexOf('value="spare-model"')).toBeLessThan(stated.indexOf('value="far-model"'));
    expect(stated).toContain('aria-label="Fallback 2 provider"><option value="elsewhere">elsewhere</option>');
    expect(stated).toContain('aria-label="Remove fallback 2"');
    expect(stated).toContain("Tried from the top; each once.");
  });

  test("a fallback added on the Model tab saves the whole list, in order, as provider and model (0.8.0)", async () => {
    const status = WIRE["/status"] as { agents: Record<string, unknown>[] };
    answer({ "/status": { status: 200, body: { ...status, agents: status.agents.map((agent) => ({ ...agent, fallbacks: [{ provider: "test", model: "spare-model" }] })) } } });
    let sent: { path: string; body: unknown }[] = [];
    await renderPage("/agents/nouva/model", async (host) => {
      await eventually(() => host.textContent?.includes("Save Fallbacks") === true, 2_000, "the fallbacks");
      const record = recordPosts();
      press(host, "Add fallback");
      await eventually(() => host.querySelector('[aria-label="Remove fallback 2"]') !== null, 2_000, "a second row");
      const inputs = [...host.querySelectorAll('input[role="combobox"]')] as HTMLInputElement[];
      type(inputs.at(-1)!, "last-resort");
      await enabled(host, "Save Fallbacks");
      press(host, "Save Fallbacks");
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(sent).toEqual([{ path: "/agents/nouva/fallbacks", body: { fallbacks: [{ provider: "test", model: "spare-model" }, { provider: "test", model: "last-resort" }] } }]);
  });

  test("an agent's three model tiers on its Model tab, inheriting until it names its own; the install's and each helper's on Models (0.8.0)", async () => {
    const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    // The engine's own answer (fixtures/wire.json): nothing named anywhere, so both follow the agent's model.
    const inheriting = text(await renderPage("/agents/nouva/model"));
    expect(inheriting).toContain("Model Tiers");
    expect(inheriting).toContain("Inherits test-model.");
    expect(inheriting).not.toContain("Inherit both");

    const status = WIRE["/status"] as { agents: Record<string, unknown>[] };
    const tiers = { small: { own: "own-small", inherits: "m-small" }, high: { own: null, inherits: "m-high" } };
    answer({ "/status": { status: 200, body: { ...status, agents: status.agents.map((agent) => ({ ...agent, tiers })) } } });
    const own = await renderPage("/agents/nouva/model");
    expect(own).toContain('value="own-small"');
    expect(text(own)).toContain("Set for this agent; inherits m-small when cleared.");
    expect(text(own)).toContain("Inherits m-high.");
    expect(text(own)).toContain("Inherit both");

    answer({});
    const models = text(await renderPage("/models"));
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(models).toContain("Model tiers");
    expect(models).toContain("all three are the default model");
    for (const helper of ["[llm.context] summary_model", "[memory] pass_model", "[queue] steer_reply_model", "[media] image_model", "[skills.learning] model"]) {
      expect(models).toContain(helper);
    }
    expect(models).toContain("Small tier (the cheapest)");
    expect(models).toContain("High tier (the strongest)");
  });

  test("the mention hop limit is advanced: behind its disclosure on Agent Settings, not on the card's first line (0.8.0)", async () => {
    answer({ "/mentions": { status: 200, body: { mentionsEnabled: true, mentionMaxHops: 5, editable: true } } });
    const html = await renderPage("/agents/settings");
    expect(errors.filter((line) => /Error|error boundary|Cannot read/.test(line))).toEqual([]);
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Advanced.*?a chain stops after 5 hops.*?aria-label="Max mention hops"/s);
    // Nothing but the switch before it.
    expect(html.indexOf('aria-label="Max mention hops"')).toBeGreaterThan(html.indexOf(">Advanced"));
  });

  test("an agent's Access page decides for itself whether new senders are taken, following the default until it does", async () => {
    answer(TWO);
    const html = await renderPage("/agents/nix/access");
    expect(html).toContain("Accept new senders");
    expect(html).toContain("Follow the default");
    expect(html).toMatch(/<input[^>]*radio[^>]*checked=""[^>]*>\s*<span[^>]*>Follow the default/);
  });

  test("signing out asks first, and a no leaves you signed in", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    let dialogShown = false;
    let stayIsPrimary = false;
    await renderPage("/", async (host) => {
      const spy = globalThis.fetch;
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        if (url.includes("/auth/logout")) calls.push(url);
        return (spy as typeof fetch)(input as RequestInfo, init as RequestInit);
      }) as typeof fetch;
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="Sign out"]')!;
      button.click();
      for (let i = 0; i < 4; i += 1) await sleep(10);
      dialogShown = document.body.innerHTML.includes("Sign out?");
      // Staying is the primary, blue answer; leaving is the plain one.
      const buttons = [...document.querySelectorAll("dialog button")] as HTMLButtonElement[];
      stayIsPrimary = buttons.find((b) => b.textContent?.trim() === "Stay")?.className.includes("btn-primary") === true && buttons.find((b) => b.textContent?.trim() === "Sign out")?.className.includes("btn-ghost") === true;
      const stay = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Stay") as HTMLButtonElement | undefined;
      stay?.click();
      for (let i = 0; i < 4; i += 1) await sleep(10);
      globalThis.fetch = spy;
    });
    globalThis.fetch = realFetch;
    expect(dialogShown).toBe(true);
    expect(stayIsPrimary).toBe(true);
    expect(calls).toEqual([]);
  });

  test("deleting a secret asks first, naming everything that uses it — a no deletes nothing, a yes deletes it once", async () => {
    answer({ "/secrets": { status: 200, body: { secrets: [{ name: "nougate", origin: "store", usedBy: ["provider nougate", "gateway discord:nox", "agent nouva's commands"], shadowed: false }] } } });
    const deletes: string[] = [];
    const realFetch = globalThis.fetch;
    let question = "";
    let afterNo = -1;
    await renderPage("/secrets", async (host) => {
      const spy = globalThis.fetch;
      globalThis.fetch = ((input: unknown, init?: unknown) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        if ((init as RequestInit | undefined)?.method === "DELETE") deletes.push(url);
        return (spy as typeof fetch)(input as RequestInfo, init as RequestInit);
      }) as typeof fetch;
      // Every page has dialogs of its own (signing out asks too), and one answered keeps its words while it closes: the
      // question asked is the one in the open dialog.
      const dialogs = () => [...document.querySelectorAll("dialog[open]")].map((d) => d.textContent ?? "").join(" ");
      // The row's Delete, not the dialog's: both read "Delete" once the question is open.
      const rowDelete = () => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete" && !b.closest("dialog")) as HTMLButtonElement;
      const answer = (label: string) => ([...document.querySelectorAll("dialog button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement).click();
      rowDelete().click();
      await eventually(() => dialogs().includes("Delete nougate?"), 2_000, "the question");
      question = dialogs();
      answer("Cancel");
      await eventually(() => !dialogs().includes("Delete nougate?"), 2_000, "the question to close");
      // Read once the dialog is gone: a no that deleted would have sent its request by then, in the same tick as the answer.
      afterNo = deletes.length;
      rowDelete().click();
      await eventually(() => dialogs().includes("Delete nougate?"), 2_000, "the question again");
      answer("Delete");
      await eventually(() => deletes.length > 0, 2_000, "the delete");
      globalThis.fetch = spy;
    });
    globalThis.fetch = realFetch;
    expect(question).toContain("Delete nougate?");
    // In plain words (0.8.19): what needs it, as the rest of the dashboard names those things.
    expect(question).toContain("AI provider nougate, connection discord:nox, agent nouva's commands need it, and stop working without it");
    expect(question).toContain("cannot be brought back from here");
    expect(afterNo).toBe(0);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toEndWith("/secrets/nougate");
  });

  test("New Agent offers the five presets, Pilot chosen, and none of the old checkboxes", async () => {
    let html = "";
    await renderPage("/agents", async (host) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("New Agent")) as HTMLElement;
      button.click();
      for (let i = 0; i < 6; i += 1) await sleep(10);
      html = host.innerHTML;
    });
    for (const label of ["Pilot", "Researcher", "Assistant", "Developer", "Custom"]) expect(html).toContain(label);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*><span[^>]*>Pilot</);
    expect(html).not.toContain("Allow Terminal Command Execution");
    expect(html).not.toContain("Auto-Approval");
  });

  test("the setup wizard's agent step asks only for a name, an id, a model and a prompt", async () => {
    answer({ "/setup/state": { status: 200, body: { complete: false, hasAdmin: true, hasUser: true, hasProvider: true, hasAgent: false } } });
    const html = await renderPage("/setup");
    expect(html).toContain("Create your first agent");
    expect(html).not.toContain("Execution Capabilities");
    expect(html).not.toContain('type="checkbox"');
  });
});


/**
 * The model picker's list is drawn on `document.body`, not inside its card.
 *
 * Every card is `backdrop-blur`, which makes a stacking context, so a list inside one was drawn under
 * the next card whatever its z-index: on an agent's Model tab the suggestions opened behind the budget
 * card below them.
 */
describe("the model picker's suggestions", () => {
  test("open above every card, on the page itself", async () => {
    answer({
      "/status": {
        status: 200,
        body: {
          status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nix",
          agents: [{ id: "nix", displayName: "Nix", enabled: true, state: "running", provider: "ollama", model: "m", tools: [], approvals: "careful" }],
        },
      },
    });
    // Collected rather than assigned: a `let` set inside the callback is narrowed to its initial `null` below it.
    const where: { inBody: boolean; inCard: boolean }[] = [];
    await renderPage("/agents/nix/model", async (host) => {
      for (let i = 0; i < 6; i += 1) await sleep(10);
      const input = host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
      setter.call(input, "gemini");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      for (let i = 0; i < 6; i += 1) await sleep(10);
      const list = document.querySelector('[role="listbox"]');
      if (list) where.push({ inBody: list.parentElement === document.body, inCard: host.contains(list) });
    });
    expect(where).toEqual([{ inBody: true, inCard: false }]);
  });
});

/**
 * Semantic search says how to get an embedding model when there is nothing that can make one — the
 * card used to offer "Choose a provider" from a list that could not embed, and stop there.
 */
/** The Memory page on its Settings tab, as drawn — what the two blocks below look at. */
const settingsTab = async () => {
  let html = "";
  await renderPage("/memories", async (host) => {
    const tab = [...host.querySelectorAll('[role="tablist"] > [role="tab"]')].find((t) => t.textContent?.startsWith("Settings")) as HTMLElement;
    tab.click();
    for (let i = 0; i < 6; i += 1) await sleep(10);
    html = host.innerHTML;
  });
  return html;
};

describe("semantic search without an embedder", () => {
  test("an Anthropic profile is not offered, and the ways to get one are shown open", async () => {
    answer({ "/providers": { status: 200, body: { editable: true, providers: [{ name: "claude", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKeySecret: "claude", hasCredential: true, builtIn: false }] } } });
    const html = await settingsTab();
    expect(html).toContain("You need a provider that makes embeddings");
    for (const model of ["bge-m3", "text-embedding-3-small", "gemini-embedding-001"]) expect(html).toContain(model);
    expect(html).not.toContain('<option value="claude">');
  });

  test("with one that can, it is offered and the others are one line, not the whole guide", async () => {
    const html = await settingsTab();
    expect(html).toContain('<option value="ollama">');
    expect(html).toContain("Want another?");
    expect(html).not.toContain("You need a provider that makes embeddings");
  });
});

/**
 * The model the nightly pass and compaction share (0.7.26): live, it went away and both failed for hours with nothing on
 * this page to say so. Its card says what it is for, which model summarizes instead when `summary_model` names one, and
 * what `/status` counted against it in the last day.
 */
describe("the helper model card", () => {
  const status = RESPONSES["/status"] as Record<string, unknown>;
  const settings = RESPONSES["/memory/settings"] as Record<string, unknown>;

  test("says what the model is for, and that it works when nothing failed", async () => {
    const html = await settingsTab();
    expect(html).toContain("Runs the nightly pass, and summarizes conversations that get too long");
    expect(html).toContain("Working, nothing is failing.");
    expect(html).not.toContain("summary_model");
  });

  test("names summary_model when it is set, and says what failed, how often, when, why — and who stands in", async () => {
    const at = (ago: number) => Date.now() - ago;
    const helpers = [
      { job: "compaction", count: 2, model: "claude/claude-haiku-4-5", last: "overloaded", at: at(40 * 60_000) },
      { job: "memory pass", count: 4, model: "nougate/gemini-old", last: "404 model not found", at: at(2 * 3_600_000) },
      { job: "fallback", count: 3, model: "nougate/gemini-old", last: "429 quota exceeded", at: at(5 * 60_000) },
    ];
    answer({
      "/memory/settings": { status: 200, body: { ...settings, passProvider: "ollama", passModel: "gemini-old", summaryModel: "claude-haiku-4-5" } },
      "/status": { status: 200, body: { ...status, helpers } },
    });
    const html = await settingsTab();
    expect(html).toContain("Long conversations are summarized with <b");
    expect(html).toContain("claude-haiku-4-5</b> instead");
    expect(html).toContain("Summarizing a long conversation failed 2 time(s) in the last 24 h, most recently 40 min ago, on claude/claude-haiku-4-5.");
    expect(html).toContain("The nightly pass could not ask its model 4 time(s) in the last 24 h, most recently 2 h ago, on nougate/gemini-old.");
    expect(html).toContain("nougate/gemini-old could not answer in 3 hour(s) of the last 24, most recently 5 min ago; each agent's own model is standing in for it.");
    for (const said of ["overloaded", "404 model not found", "429 quota exceeded"]) expect(html).toContain(said);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Working, nothing is failing");
  });

  test("a pass on a tier says it runs on each agent's own model of that tier, set on the Models page (0.8.0)", async () => {
    answer({ "/memory/settings": { status: 200, body: { ...settings, passProvider: "", passModel: "small" } } });
    const html = (await settingsTab()).replace(/<[^>]*>/g, "");
    expect(html).toContain("Runs on each agent's own small-tier model, set under Model tiers on the Models page.");
  });

  test("a daemon too old to count says neither", async () => {
    const { helpers: _helpers, ...older } = status;
    answer({ "/status": { status: 200, body: older } });
    const html = await settingsTab();
    expect(html).toContain("Helper model");
    expect(html).not.toContain("Working, nothing is failing");
    expect(html).not.toContain("in the last 24 h");
  });
});

/** Every page's tabs are the same segmented bar — Memory, Skills, System Logs and an agent's page. */
describe("one tab bar", () => {
  test("Memory, Skills and System Logs draw the segmented bar, not daisyUI's tabs", async () => {
    for (const path of ["/memories", "/skills", "/logs"]) {
      const html = await renderPage(path);
      expect({ path, segmented: html.includes('role="tablist" class="inline-flex max-w-full flex-nowrap gap-0.5') }).toEqual({ path, segmented: true });
      expect({ path, daisy: html.includes("tabs-box w-fit") }).toEqual({ path, daisy: false });
    }
  });
});


/** An agent's Skills tab says a skill the operator switched off everywhere is off, though the agent's own switch is on. */
describe("an agent's skills", () => {
  test("a globally-off skill is drawn as not carried, and says why", async () => {
    const row = (name: string, offGlobally: boolean) => ({
      name, description: `about ${name}`, scope: "shared", path: `/p/${name}/SKILL.md`, requires: [], missing: [],
      enabled: true, decided: false, offGlobally, toggleable: true,
    });
    answer({
      "/status": { status: 200, body: { status: "ready", gateways: [], providers: [], uptimeMs: 1000, agents: [{ id: "nouva", displayName: "Nouva", enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" }] } },
      "/agents/nouva/skills": { status: 200, body: { skills: [row("github", true), row("deploy", false)], editable: true } },
    });
    const html = await renderPage("/agents/nouva/skills");
    expect(html).toContain("Off for every agent");
    expect(html).toMatch(/line-through[^"]*">github</);
    expect(html).not.toMatch(/line-through[^"]*">deploy</);
    expect(html).toContain("1 of 2 not carried by this agent.");
  });
});

/**
 * Schedule's Run says how it went. It said nothing: a refusal ("that job is already running") came back as a 200 and
 * read as success, a run longer than the 15 s request timeout greyed every Run button and then went quiet, and a
 * failed pause or delete left the row as it was without a word.
 */
describe("running a job by hand", () => {
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await sleep(10);
  };
  const job = (id: string, name: string) => ({
    id, agentId: "nouva", name, enabled: true, trigger: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce" }, target: { gatewayId: "telegram:nouva", chatId: "1" }, session: "isolated", createdBy: "tester",
    createdAt: 0, runCount: 0, failCount: 0, failStreak: 0, describes: "every day at 09:00",
  });
  const jobs = { "/cron": { status: 200, body: { jobs: [job("j1", "Morning report"), job("j2", "Backup")], timezone: "UTC" } } };
  const press = async (host: HTMLElement, row: string, label: string) => {
    const card = [...host.querySelectorAll("div.rounded-2xl")].find((el) => el.querySelector("span.font-bold")?.textContent === row);
    const button = [...(card?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label) as HTMLElement | undefined;
    if (!button) throw new Error(`no ${label} on ${row}`);
    button.click();
    await settle();
  };

  test("a refusal is said, not taken for success", async () => {
    answer({ ...jobs, "/cron/j1/run": { status: 200, body: { outcome: { status: "unavailable", result: "that job is already running" } } } });
    const html = await renderPage("/schedule", (host) => press(host, "Morning report", "Run"));
    expect(html).toContain("Morning report did not start");
    expect(html).toContain("that job is already running");
  });

  test("a run that outlasts the wait says it is still going, and opens its runs to follow it", async () => {
    answer({
      ...jobs,
      "/cron/j1/run": { status: 202, body: { outcome: { status: "running" } } },
      "/cron/j1": { status: 200, body: { job: job("j1", "Morning report"), runs: [{ id: "r1", jobId: "j1", startedAt: 0, status: "running" }], timezone: "UTC" } },
    });
    const html = await renderPage("/schedule", (host) => press(host, "Morning report", "Run"));
    expect(html).toContain("Morning report is still running");
    expect(html).toContain("running…");
  });

  test("an outcome is said, and a pause that failed says so", async () => {
    answer({
      ...jobs,
      "/cron/j2/run": { status: 200, body: { outcome: { status: "success", result: "backed up 3 files" } } },
      "/cron/j2/disable": { status: 500, body: { error: "the store is locked" } },
    });
    const html = await renderPage("/schedule", async (host) => {
      await press(host, "Backup", "Run");
      await press(host, "Backup", "Pause");
    });
    expect(html).toContain("Backup ran");
    expect(html).toContain("backed up 3 files");
    expect(html).toContain("Could not pause Backup");
    expect(html).toContain("the store is locked");
  });

  test("a mission job is listed as one, and the form sends one that always reports to its chat (0.8.0)", async () => {
    answer({ "/cron": { status: 200, body: { jobs: [{ ...job("j3", "Weekly mail"), payload: { kind: "mission", goal: "Sum up the week's mail." } }], timezone: "UTC" } } });
    let sent: { path: string; body: unknown }[] = [];
    const html = await renderPage("/schedule", async (host) => {
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New job")!.click();
      await eventually(() => host.textContent?.includes("What should happen") === true, 2_000, "the form");
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Mission"))!.click();
      await eventually(() => host.querySelector('textarea[placeholder^="Sum up this week"]') !== null, 2_000, "the mission's fields");
      type(host.querySelector('input[placeholder="e.g. morning server report"]') as HTMLInputElement, "Customer mail");
      type(host.querySelector('textarea[placeholder^="Sum up this week"]') as HTMLTextAreaElement, "Sum up the customer mail.");
      type(host.querySelector('textarea[placeholder="test -s summary.md"]') as HTMLTextAreaElement, "test -s summary.md\n\n");
      type(host.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement, "-100team");
      const record = recordPosts({ "/cron": { status: 200, body: { job: job("j4", "Customer mail") } } });
      await enabled(host, "Schedule it");
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Schedule it")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(html).toContain("Mission: Sum up the week's mail.");
    expect(sent[0]?.path).toBe("/cron");
    expect(sent[0]?.body).toMatchObject({
      name: "Customer mail",
      payload: { kind: "mission", goal: "Sum up the customer mail.", checks: ["test -s summary.md"] },
      delivery: { mode: "announce" },
      every: "15m",
    });
  });

  test("where it goes is a chat by name — a one-to-one and with whom, a group and its name — not a bare id (0.8.0)", async () => {
    const chats = [
      { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: ["Gading"], lastActive: 2 },
      { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: ["Gading"], lastActive: 1 },
    ];
    answer({
      "/cron": { status: 200, body: { jobs: [{ ...job("j6", "Morning report"), target: { gatewayId: "telegram:nouva", chatId: "5550001111" } }], timezone: "UTC" } },
      "/chats": { status: 200, body: { chats } },
      "/gateways": { status: 200, body: { gateways: [{ id: "telegram:nouva", platform: "telegram", name: "Nouva", enabled: true, tokenSecret: "t", agent: "nouva", status: "connected", hasCredential: true }], editable: true } },
    });
    let card = "";
    let offered = "";
    let picked = "";
    await renderPage("/schedule", async (host) => {
      await eventually(() => host.textContent?.includes("DM · Gading") === true, 2_000, "the card's chat");
      card = host.textContent ?? "";
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New job")!.click();
      await eventually(() => host.querySelector('input[placeholder="Pick a chat, or type its id"]') !== null, 2_000, "the form");
      (host.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement).focus();
      // The list is drawn on the page's body, over every card, not inside the form.
      await eventually(() => host.ownerDocument.body.textContent?.includes("Group · Nouride") === true, 2_000, "the list");
      offered = host.ownerDocument.body.querySelector('[role="listbox"]')?.textContent ?? "";
      [...host.ownerDocument.body.querySelectorAll('[role="listbox"] button')].find((b) => b.textContent?.includes("Group · Nouride"))!.dispatchEvent(new (host.ownerDocument.defaultView as unknown as typeof globalThis).MouseEvent("click", { bubbles: true }));
      await eventually(() => host.textContent?.includes("Group · Nouride (-1005550002)") === true, 2_000, "the choice");
      picked = host.textContent ?? "";
    });
    expect(card).toContain("telegram:nouva · DM · Gading");
    expect(offered).toContain("DM · Gading5550001111");
    expect(offered).toContain("Group · Nouride-1005550002");
    expect(picked).toContain("Group · Nouride (-1005550002)");
  });

  test("a proposed job says who proposed it and waits: Turn on and Discard, not Run or Pause (0.8.0)", async () => {
    answer({ "/cron": { status: 200, body: { jobs: [{ ...job("j5", "Jemput Mira"), enabled: false, proposal: { by: "nouva", at: 0 } }], timezone: "UTC" } } });
    let sent: { path: string; body: unknown }[] = [];
    let labels: string[] = [];
    const html = await renderPage("/schedule", async (host) => {
      await eventually(() => host.textContent?.includes("Proposed by nouva") === true, 2_000, "the proposal");
      labels = buttons(host);
      const record = recordPosts({ "/cron/j5/enable": { status: 200, body: { job: job("j5", "Jemput Mira") } } });
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Turn on")!.click();
      await eventually(() => record.posts.length > 0, 2_000, "the answer");
      record.restore();
      sent = record.posts;
    });
    expect(html).toContain("It stays off until somebody turns it on.");
    expect(labels).toContain("Discard");
    expect(labels).not.toContain("Run");
    expect(labels).not.toContain("Pause");
    expect(sent.map((post) => post.path)).toEqual(["/cron/j5/enable"]);
  });

  test("a scheduler that did not answer is not called disabled", async () => {
    answer({ "/cron": { status: 503, body: { error: "nouride is starting: opening the database" } } });
    const html = await renderPage("/schedule");
    expect(html).toContain("nouride is starting");
    expect(html).not.toContain("not enabled");
  });
});

/**
 * Answering an approval says what happened — and a 409, the request answered elsewhere or expired, is not an Allow.
 *
 * The chat said nothing when an answer failed, and the card vanished on the next poll either way, so a tap on Allow
 * a second after the timeout read as allowed. Overview showed the error inside the card that same poll removed.
 */
describe("answering an approval", () => {
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await sleep(10);
  };
  const pending = { id: "ap1", agentId: "nouva", chatId: "web:usr_1", tool: "exec", params: { command: "ls" }, grantable: false, requestedAt: 0, timeoutMs: 60_000 };
  const allowOnce = async (host: HTMLElement) => {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Allow once")) as HTMLElement | undefined;
    if (!button) throw new Error("no Allow once button");
    button.click();
    await settle();
  };
  const stale = { "/approvals/ap1/allow-once": { status: 409, body: { error: "not pending", id: "ap1" } } };

  test("on Overview, a request that was no longer open says so, in a toast that outlives the card", async () => {
    answer({ "/approvals": { status: 200, body: { pending: [pending] } }, ...stale });
    const html = await renderPage("/", async (host) => {
      await allowOnce(host);
    });
    expect(html).toContain("already answered or has expired");
    expect(html).not.toContain("Allowed once");
  });

  test("in the chat as well — where nothing was said at all", async () => {
    const turn = { id: "t1", agentId: "nouva", chatId: "web:usr_1", status: "done", prompt: "list it", reply: "Asking first.", toolCalls: 1, startedAt: 0, endedAt: 1, steps: [] };
    answer({
      "/approvals": { status: 200, body: { pending: [pending] } },
      "/sessions/ses_1/turns": {
        status: 200,
        body: { session: { id: "ses_1", agentId: "nouva", chatId: "web:usr_1", gatewayId: "web:dashboard", updatedAt: 0, writable: true }, earlier: [], turns: [turn] },
      },
      ...stale,
    });
    const html = await renderPage("/chat/ses_1", async (host) => {
      await allowOnce(host);
    });
    expect(html).toContain("already answered or has expired");
  });

  test("an answer that landed says which it was", async () => {
    answer({ "/approvals": { status: 200, body: { pending: [pending] } }, "/approvals/ap1/allow-once": { status: 200, body: { ok: true, id: "ap1", decision: "allow-once" } } });
    const html = await renderPage("/", async (host) => {
      await allowOnce(host);
    });
    expect(html).toContain("Allowed once");
    expect(html).not.toContain("already answered");
  });
});

/**
 * A load that failed is said to have failed — not drawn as an empty install, or as a healthy one.
 */
describe("a failed load is not an empty or healthy page", () => {
  test("Agents says the daemon did not answer, not that there are no agents — and lists no connection as orphaned", async () => {
    answer({ "/status": { status: 503, body: { error: "nouride is starting: opening the database" } } });
    const html = await renderPage("/agents");
    expect(html).toContain("nouride is starting");
    expect(html).not.toContain("No agents configured");
    expect(html).not.toContain("unassigned connection");
  });

  test("Overview says everything is working only while it is", async () => {
    answer({ "/health": { status: 503, body: { status: "degraded", uptime: 10, version: "0.7.10", agents: 1, gateways: {} } } });
    const degraded = await renderPage("/");
    expect(degraded).toContain(">degraded<");
    expect(degraded).not.toContain("Everything is working");

    answer({ "/health": { status: 200, body: { status: "ok", uptime: 10, version: "0.7.10", agents: 1, gateways: {} } } });
    expect(await renderPage("/")).toContain("Everything is working");
  });
});

/**
 * Which pages scroll as a document and which fill the viewport — decided by the route, never by the address.
 *
 * `pathname.includes("/chat")` was true of `/agents/chatbot/settings`, and an agent id is any `[a-z][a-z0-9-]`: every
 * page of an agent called `chatbot`, `logs-bot` or `secrets` was drawn in the clipped, unpadded layout chat uses, with
 * its Save buttons below the fold and no way to scroll to them.
 */
describe("which pages own the viewport", () => {
  const SCROLLS = '<main class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">';
  const FILLS = '<main class="flex-1 min-h-0 flex flex-col overflow-hidden *:animate-fade">';
  const agent = (id: string) => ({ id, displayName: id, enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" });

  test("an agent named like one of those pages still scrolls, on every tab", async () => {
    answer({
      "/status": { status: 200, body: { status: "ready", gateways: [], providers: [], uptimeMs: 1000, agents: ["chatbot", "logs-bot", "secrets"].map(agent) } },
    });
    for (const path of ["/agents/chatbot/settings", "/agents/chatbot", "/agents/logs-bot/model", "/agents/secrets"]) {
      const html = await renderPage(path);
      expect({ path, scrolls: html.includes(SCROLLS), fills: html.includes(FILLS) }).toEqual({ path, scrolls: true, fills: false });
    }
  });

  test("chat, System Logs, Secrets and the LLM Gateway fill it", async () => {
    for (const path of ["/chat", "/chat/ses_1", "/chat/room/room_1", "/logs", "/secrets", "/llm-gateway"]) {
      const html = await renderPage(path);
      expect({ path, fills: html.includes(FILLS) }).toEqual({ path, fills: true });
    }
  });
});

/**
 * The daemon restarting under an open page — Overview's Restart, a save that needs one, an update installing. Every
 * `/api` path answers 503 while it boots. A refetch of who is signed in failing then was read as signed out: the page
 * went to the login form, and whatever was typed in it went too.
 */
describe("a restart under an open page", () => {
  const starting = { status: 503, body: { error: "nouride is starting" } };

  /**
   * Waited for as whichever of the two outcomes comes first, then asserted: the page saying it reconnects, or the page
   * gone to the login form, which is the bug. Eighty milliseconds of fixed sleep was the wait until CI's runner took
   * longer than that to draw the notice (2026-10-17).
   */
  test("signed in, the page stays and says it is reconnecting — and a 401 is what signs out", async () => {
    const seen: Record<string, { at: string; html: string }> = {};
    await renderPage("/agents", async (host, app) => {
      answer({ "/auth/me": starting });
      await app.queryClient.invalidateQueries({ queryKey: ["me"] });
      await eventually(() => host.innerHTML.includes("Reconnecting to Nouride") || app.location() === "/login", 4_000, "the page to answer the 503");
      seen.restarting = { at: app.location(), html: host.innerHTML };

      answer({ "/auth/me": { status: 401, body: { error: "sign in" } } });
      await app.queryClient.invalidateQueries({ queryKey: ["me"] });
      await eventually(() => app.location() === "/login", 4_000, "a 401 to sign out");
      seen.signedOut = { at: app.location(), html: host.innerHTML };
    });

    expect(seen.restarting?.at).toBe("/agents");
    expect(seen.restarting?.html).toContain("Reconnecting to Nouride");
    expect(seen.signedOut?.at).toBe("/login");
  });

  /**
   * The follower is one per tab, and a rollback stays on it to be said on the update page. The strip hid itself for it,
   * so an outage after a rollback showed nothing — what Linux's CI met, where another file's test left one behind.
   */
  test("a rollback said earlier does not hide an outage after it", async () => {
    const { follow, restartState } = await import("@/commons/lib/restart");
    const health = (uptime: number, version: string) => ({ status: "ok" as const, uptime, version, agents: 1, gateways: {} });
    const daemon = (looks: (ReturnType<typeof health> | null)[]) => {
      let at = 0;
      return {
        health: async () => (looks.length > 1 ? looks.shift()! : looks[0]!),
        answersForSession: async () => true,
        servedBuild: async () => null,
        pageBuild: () => null,
        setOnline: () => {},
        refetchAll: () => {},
        reload: () => {},
        now: () => at,
        sleep: async (ms: number) => {
          at += Math.max(ms, 2_000);
        },
      };
    };
    await follow(daemon([null, health(2, "0.7.10")]), { kind: "install", before: 3_600, expected: "v0.7.11", note: "installed" });
    expect(restartState().phase).toBe("rolled-back");
    try {
      let html = "";
      await renderPage("/agents", async (host, app) => {
        answer({ "/auth/me": starting });
        await app.queryClient.invalidateQueries({ queryKey: ["me"] });
        await eventually(() => host.innerHTML.includes("Reconnecting to Nouride") || app.location() === "/login", 4_000, "the page to answer the 503");
        html = host.innerHTML;
      });
      expect(html).toContain("Reconnecting to Nouride");
    } finally {
      // As a tab with nothing to follow: an outage that came back.
      await follow(daemon([health(9_000, "0.7.11")]), { kind: "outage", before: null, held: true });
    }
  });

  test("a first load while it boots waits for it, rather than offering a login form", async () => {
    answer({ "/auth/me": starting, "/setup/state": starting });
    let at = "";
    const html = await renderPage("/agents", async (_host, app) => {
      at = app.location();
    });
    expect(at).toBe("/agents");
    expect(html).toContain("Waiting for Nouride");
  });
});

/**
 * A tab left open across an update (`commons/lib/bundle.ts`): the bundle's stamp against what `/health` says the
 * daemon runs. The stamp is `vite.config.ts`'s `define`; here, a global of the same name.
 */
describe("a page older than its daemon", () => {
  const stamp = (version: string | undefined) => {
    if (version === undefined) delete (globalThis as Record<string, unknown>).__NOURIDE_VERSION__;
    else (globalThis as Record<string, unknown>).__NOURIDE_VERSION__ = version;
  };
  afterEach(() => stamp(undefined));
  const daemonRuns = (version: string) => ({ "/health": { status: 200, body: { status: "ok", version, agents: 1, gateways: {} } } });

  test("says the daemon was updated and offers the reload", async () => {
    stamp("0.7.7");
    answer(daemonRuns("0.7.8"));
    const html = await renderPage("/agents");
    expect(html).toContain("Nouride was updated to 0.7.8");
    expect(html).toContain("Reload");
  });

  test("says nothing when they match, or when the page carries no stamp", async () => {
    stamp("0.7.8");
    answer(daemonRuns("0.7.8"));
    expect(await renderPage("/agents")).not.toContain("Nouride was updated");
    stamp(undefined);
    answer(daemonRuns("0.7.8"));
    expect(await renderPage("/agents")).not.toContain("Nouride was updated");
  });
});

/**
 * The router's own error and not-found pages (`router.tsx`). Without them a page that threw replaced the whole app with
 * an unstyled "Something went wrong!", and a mistyped address showed a bare "Not Found" — no way back but the URL bar.
 */
describe("a page that is not there, or that throws", () => {
  test("an unknown address says so and links back to Overview", async () => {
    const html = await renderPage("/no-such-page");
    expect(html).toContain("No page here");
    expect(html).toContain("Go to Overview");
  });

  test("a page that throws while drawing shows what failed, with a way to reload", async () => {
    // A payload of the wrong shape — the class of crash this file exists to catch.
    answer({ "/status": { status: 200, body: { ...(RESPONSES["/status"] as object), agents: 42 } } });
    const html = await renderPage("/agents");
    expect(html).toContain("This page ran into an error");
    expect(html).toContain("Reload");
    expect(html).not.toContain("Something went wrong!");
  });
});

/**
 * Overview's Setup notes: what the last boot said about the setup (`GET /advisories`), folded away, nothing when
 * there is nothing. Said at warn once and at info after, it was otherwise only in the journal.
 */
describe("Overview's setup notes", () => {
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await sleep(10);
  };

  test("one line per thing said, with its agents and its hint, opened from the card", async () => {
    answer({
      "/advisories": {
        status: 200,
        body: { advisories: [{ message: "exec_secrets.github_token is unscoped", agents: ["nouva", "nix"], hint: "bind it to the commands that need it", since: 1_000 }] },
      },
    });
    let opened = "";
    const closed = await renderPage("/", async (host) => {
      const toggle = [...host.querySelectorAll("button")].find((button) => (button.textContent ?? "").includes("Setup notes")) as HTMLElement | undefined;
      toggle?.click();
      await settle();
      opened = host.innerHTML;
    });
    expect(closed).toContain("Setup notes");
    expect(opened).toContain("exec_secrets.github_token is unscoped");
    expect(opened).toContain("nix");
    expect(opened).toContain("bind it to the commands that need it");
  });

  test("nothing at all when the last boot said nothing", async () => {
    answer({ "/advisories": { status: 200, body: { advisories: [] } } });
    expect(await renderPage("/")).not.toContain("Setup notes");
  });
});

/** The Groups page (0.7.24): a room by its name, where it is and who talks there, and a rename put in the row. */
describe("Groups", () => {
  test("a room by its renamed name, its platform's name beside it, its agents and its people — and renamed in the row", async () => {
    const posts: unknown[] = [];
    let before = "";
    await renderPage("/groups", async (host) => {
      before = host.innerHTML;
      const spy = globalThis.fetch;
      globalThis.fetch = ((input: unknown, init?: RequestInit) => {
        const url = String(typeof input === "string" ? input : (input as Request).url);
        if (init?.method === "POST" && url.endsWith("/groups")) posts.push(JSON.parse(String(init.body)));
        return (spy as typeof fetch)(input as RequestInfo, init);
      }) as typeof fetch;
      ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Rename")) as HTMLElement).click();
      await eventually(() => Boolean(host.querySelector('input[aria-label="Room name"]')), 2_000, "the name box");
      const input = host.querySelector('input[aria-label="Room name"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "Arisan");
      input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
      for (let i = 0; i < 4; i += 1) await sleep(10);
      ([...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save") as HTMLElement).click();
      await eventually(() => posts.length > 0, 2_000, "the rename");
      globalThis.fetch = spy;
    });
    expect(before).toContain("Rumah");
    expect(before).toContain("on Telegram: Keluarga Besar");
    expect(before).toContain("nouva");
    expect(before).toContain("Gading, Tetangga");
    expect(posts).toEqual([{ gatewayId: "telegram:main", chatId: "-100200", title: "Arisan" }]);
  });
});

/** The chat's work notes (0.7.26): a conversation's header counts the tasks and opens them; a new chat and a room have none. */
describe("the chat's work notes", () => {
  const toggle = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label^="Work notes"]');
  const drawer = (host: HTMLElement) => host.querySelector<HTMLElement>('aside[aria-label="Work notes"]')!;

  test("the toggle counts the tasks and opens them beside the conversation, with Edit for an admin — the history drawer closes it", async () => {
    const seen: Record<string, string | boolean> = {};
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => toggle(host) !== null, 2_000, "the toggle");
      seen.label = toggle(host)!.getAttribute("aria-label") ?? "";
      seen.inertClosed = drawer(host).hasAttribute("inert");
      toggle(host)!.click();
      await eventually(() => toggle(host)!.getAttribute("aria-expanded") === "true" && !drawer(host).hasAttribute("inert"), 2_000, "the drawer to open");
      seen.opened = drawer(host).textContent ?? "";
      (host.querySelector('button[title="Show or hide past conversations"]') as HTMLElement).click();
      await eventually(() => toggle(host)!.getAttribute("aria-expanded") === "false", 2_000, "the history drawer to take its place");
    });
    expect(seen.label).toBe("Work notes, 1 task");
    expect(seen.inertClosed).toBe(true);
    for (const words of ["Clean the build", "Free space on the build disk.", "2 of 4 done", "Edit"]) expect(seen.opened).toContain(words);
  });

  test("a new chat and a room offer none", async () => {
    for (const path of ["/chat", "/chat/room/room_1"]) expect(await renderPage(path)).not.toContain('aria-label="Work notes');
  });

  test("the plan sits above the composer, a press from its steps, with the missions working from this chat (0.8.0)", async () => {
    const mission = (WIRE["/missions"] as { missions: Record<string, unknown>[] }).missions[0]!;
    const here = { gatewayId: "web:dashboard", chatId: "web-1" };
    overrides["/missions"] = {
      status: 200,
      body: {
        missions: [
          { ...mission, id: "msn_here", ...here, status: "running", checklist: { done: 1, total: 3, active: "Read the build logs" } },
          { ...mission, id: "msn_asks", ...here, status: "waiting", waitKind: "input", reason: "Which disk?", checklist: null },
          { ...mission, id: "msn_over", ...here, status: "done", checklist: null },
          { ...mission, id: "msn_else", gatewayId: "web:dashboard", chatId: "web-2", status: "running", checklist: null },
        ],
      },
    };
    let strip = "";
    let steps = "";
    let links: string[] = [];
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.textContent?.includes("Read the build logs") === true, 2_000, "the strip");
      strip = host.textContent ?? "";
      links = [...host.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? "").filter((href) => href.includes("/missions/msn_"));
      const plan = [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Plan"));
      plan!.click();
      await eventually(() => plan!.getAttribute("aria-expanded") === "true", 2_000, "the plan opened");
      steps = plan!.parentElement?.textContent ?? "";
    });
    expect(strip).toContain("2 of 4");
    expect(strip).toContain("1 of 3");
    expect(strip).toContain("needs you: Which disk?");
    // Ended, or started from another chat: not here.
    expect(links.map((href) => href.split("/").at(-1))).toEqual(["msn_here", "msn_asks"]);
    expect(steps).toContain("2 of 4 done");
  });

  test("a plan rewritten mid-turn is read again then, not when the turn ends", async () => {
    const live = WIRE["/sessions/ses_1/live"] as { turn: { steps: Record<string, unknown>[] } };
    overrides["/sessions/ses_1/live"] = {
      status: 200,
      body: { ...live, turn: { ...live.turn, steps: [...live.turn.steps, { seq: 5, at: 0, kind: "tool_done", text: "plan step 3 of 4", callId: "c5", name: "plan", ms: 0 }], cursor: 5 } },
    };
    let reads = 0;
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(typeof input === "string" ? input : (input as Request).url).includes("/sessions/ses_1/notes")) reads += 1;
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      await renderPage("/chat/ses_1", async () => {
        await eventually(() => reads >= 2, 3_000, "the notes read again");
      });
    } finally {
      globalThis.fetch = spy;
    }
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Missions (0.8.0), from the engine's own answers (`fixtures/wire.json`: nouva's mission at work, its checklist part
 * done, and one stopped): the list in the order a person acts on it, a mission's page with its meters and checklist,
 * the "now" line read from its conversation's live feed, and what a person can say to one — each only when it applies.
 */
describe("missions", () => {
  const MISSION = (WIRE["/missions/msn_1"] as { mission: Record<string, unknown> }).mission;
  /** The page's answer for msn_1 with the mission changed — a state the fixture's install does not hold. */
  const detail = (mission: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: { ...(WIRE["/missions/msn_1"] as object), mission: { ...MISSION, ...mission }, ...extra },
  });
  test("the list: working before finished, each with its checklist's count and the step it is on — or how it ended", async () => {
    const html = await renderPage("/missions");
    expect(html.indexOf('aria-label="Working"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Working"')).toBeLessThan(html.indexOf('aria-label="Finished"'));
    expect(html).not.toContain('aria-label="Needs you"');
    for (const words of ["Write a report on the disk usage of the build box", "1 of 3 steps", "Write report.md", "Tidy the old logs", "Ended · stopped", "stopped by tester"]) {
      expect(html).toContain(words);
    }
    expect(html).toContain('href="/dashboard/missions/msn_1"');
  });

  test("the list's tabs count each group, the search narrows it, and it scrolls inside its card", async () => {
    const seen: Record<string, string> = {};
    await renderPage("/missions", async (host) => {
      const tabs = () => [...host.querySelectorAll('[role="tab"]')] as HTMLElement[];
      const tab = (label: string) => tabs().find((el) => el.textContent?.startsWith(label))!;
      seen.tabs = tabs().map((el) => el.textContent?.trim()).join(" | ");
      seen.all = host.innerHTML;
      // How it finished, a tab each (0.8.0): the stopped one under Stopped, and nothing under Done.
      tab("Done").click();
      await eventually(() => host.textContent?.includes("Nothing done in the last 3 days") === true, 2_000, "the done tab");
      tab("Stopped").click();
      await eventually(() => host.textContent?.includes("1 stopped") === true, 2_000, "the stopped tab");
      seen.finished = host.textContent ?? "";
      tab("Needs you").click();
      await eventually(() => host.textContent?.includes("Nothing needs you") === true, 2_000, "the needs-you tab");
      tab("All").click();
      // The words of why it ended, as its row shows them.
      type(host.querySelector('input[type="search"]') as HTMLInputElement, "tester");
      await eventually(() => !host.textContent?.includes("Write a report on the disk usage"), 2_000, "the search");
      seen.searched = host.textContent ?? "";
      type(host.querySelector('input[type="search"]') as HTMLInputElement, "no such words");
      await eventually(() => host.textContent?.includes("Nothing matches") === true, 2_000, "no match");
    });
    expect(seen.tabs).toBe("All2 | Needs you0 | Working1 | Done0 | Failed0 | Stopped1");
    // Held to the window (`fillsViewport`) from a laptop's width up, the list scrolling inside its card, so the tabs stay put.
    expect(seen.all).toContain("mx-auto flex w-full max-w-6xl flex-col px-4 pt-4 sm:px-6 sm:pt-6 lg:h-full lg:p-8");
    expect(seen.all).toMatch(/lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);
    // Its search and agent filter wrap under each other on a phone rather than run past the card's edge.
    expect(seen.all).toMatch(/<div class="flex min-w-0 max-w-full flex-wrap items-center gap-2"><div class="flex flex-wrap items-center gap-2"><label class="input/);
    expect(seen.finished).toContain("Tidy the old logs");
    expect(seen.finished).not.toContain("Write a report on the disk usage");
    expect(seen.searched).toContain("Tidy the old logs");
  });

  test("the agent filter is the address's ?agent=: that agent's list, and Every agent asks for all of them again", async () => {
    const asked: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
      if (url.pathname.endsWith("/missions")) asked.push(url.search);
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    let chosen = "";
    try {
      await renderPage("/missions?agent=nouva", async (host) => {
        const select = host.querySelector('select[aria-label="Agent"]') as HTMLSelectElement;
        chosen = select.value;
        select.value = "";
        select.dispatchEvent(new (host.ownerDocument.defaultView as unknown as typeof globalThis).Event("change", { bubbles: true }));
        // With the 3 days the list shows of what finished unless chosen (0.8.8): `days` goes with every ask.
        await eventually(() => asked.includes("?days=3"), 2_000, "every agent's list");
      });
    } finally {
      globalThis.fetch = spy;
    }
    expect(chosen).toBe("nouva");
    expect(asked[0]).toBe("?agent=nouva&days=3");
  });

  test("a mission's page: four meters against its limits, the checklist with each step's note, how it is judged done — and only Stop while it works", async () => {
    const seen: { html?: string; buttons?: string[] } = {};
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.textContent?.includes("Checklist") === true, 2_000, "the page");
      seen.html = host.innerHTML;
      seen.buttons = buttons(host);
    });
    for (const words of ["1 of 3", "0 of 50", "0m of 8h", "0 of 50M", "du in sizes.txt — build/ is 41 GB", "test -s report.md", "/srv/nouride/workspace/shared/report"]) {
      expect(seen.html).toContain(words);
    }
    expect(seen.buttons).toContain("Stop");
    expect(seen.buttons!.some((label) => /^(Continue|Accept|Answer)/.test(label))).toBe(false);
  });

  test("now: the call running this moment, read from the conversation's live feed — and its turn, headed by why it started", async () => {
    const running = {
      id: "turn_m1",
      agentId: "nouva",
      chatId: "msn_1",
      sessionId: "ses_msn_1",
      system: true,
      cause: { via: "mission" },
      status: "running",
      prompt: "MISSION msn_1 — turn 1 of at most 50\nWhy this turn: the mission starts. Write the checklist with `plan` first, then begin.",
      reply: "",
      toolCalls: 1,
      startedAt: Date.now() - 3_000,
      cursor: 2,
      steps: [{ seq: 1, at: 1, kind: "tool", text: "exec du -sh build", ms: 0, callId: "c1", name: "exec" }],
    };
    answer({ "/sessions/ses_msn_1/live": { status: 200, body: { turn: running, jobs: [] } } });
    let html = "";
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.querySelector('[aria-live="polite"]')?.textContent?.includes("exec du -sh build") === true, 3_000, "the now line");
      html = host.innerHTML;
    });
    // Headed in the timeline's words for why it started (0.8.8, `lib/timeline.ts`), not the page's line to the model.
    expect(html).toContain("the mission started");
  });

  test("a question it waits on: shown, answered from the box, and the answer sent as the person's", async () => {
    answer({
      "/missions/msn_1": detail({ status: "waiting", seen: "needs_you", waitKind: "input", reason: "Which branch should it target?", answers: [{ question: "Which branch should it target?", at: 1 }] }),
    });
    let sent: { path: string; body: unknown }[] = [];
    let labels: string[] = [];
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => Boolean(host.querySelector('textarea[placeholder="Your answer"]')), 2_000, "the answer box");
      labels = buttons(host);
      const record = recordPosts();
      type(host.querySelector('textarea[placeholder="Your answer"]') as HTMLTextAreaElement, "main, please");
      await enabled(host, "Answer");
      press(host, "Answer");
      await eventually(() => record.posts.length > 0, 2_000, "the answer");
      record.restore();
      sent = record.posts;
    });
    expect(labels).toEqual(expect.arrayContaining(["Answer", "Stop"]));
    expect(labels).not.toContain("Continue");
    expect(sent).toEqual([{ path: "/missions/msn_1/answer", body: { text: "main, please" } }]);
  });

  test("an agent's draft starts on Start it — no Continue beside it; a limit reached offers Continue and Accept as it is, not Accept", async () => {
    answer({ "/missions/msn_1": detail({ status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null, reason: "nouva proposes this" }) });
    let labels: string[] = [];
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => buttons(host).includes("Start it"), 2_000, "the start");
      labels = buttons(host);
    });
    expect(labels).not.toContain("Continue");
    answer({ "/missions/msn_1": detail({ status: "waiting", seen: "needs_you", waitKind: "limit", reason: "its 50 turns" }) });
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => buttons(host).includes("Continue"), 2_000, "the continue");
      labels = buttons(host);
    });
    expect(labels.filter((label) => label.startsWith("Accept"))).toEqual(["Accept as it is"]);
  });

  test("a call it parked is answered from its own card, as the chat answers one", async () => {
    const parked = { id: "apr_m1", agentId: "nouva", chatId: "msn_1", tool: "exec", params: { command: "rm -rf build/cache" }, preview: { kind: "command", command: "rm -rf build/cache", clipped: false }, requestedAt: 1, timeoutMs: 86_400_000 };
    answer({ "/missions/msn_1": detail({}, { parked: [parked] }) });
    let sent: { path: string; body: unknown }[] = [];
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.textContent?.includes("rm -rf build/cache") === true, 2_000, "the parked call");
      const record = recordPosts();
      press(host, "Deny");
      await eventually(() => record.posts.length > 0, 2_000, "the denial");
      record.restore();
      sent = record.posts;
    });
    expect(sent.map((post) => post.path)).toEqual(["/approvals/apr_m1/deny"]);
  });

  test("New mission sends the agent and the goal, and opens the mission it started", async () => {
    let sent: { path: string; body: unknown }[] = [];
    let landed = "";
    await renderPage("/missions", async (host, app) => {
      press(host, "New mission");
      await eventually(() => buttons(host).includes("Start mission"), 2_000, "the form");
      const record = recordPosts({ "/missions": { status: 201, body: { mission: MISSION } } });
      type(host.querySelector('textarea[placeholder^="Upgrade the API"]') as HTMLTextAreaElement, "Summarise last week's logs");
      await enabled(host, "Start mission");
      press(host, "Start mission");
      await eventually(() => app.location() === "/missions/msn_1", 2_000, "the mission's page");
      landed = app.location();
      record.restore();
      sent = record.posts;
    });
    expect(sent).toEqual([{ path: "/missions", body: { agent: "nouva", goal: "Summarise last week's logs" } }]);
    expect(landed).toBe("/missions/msn_1");
    expect(errors.filter((line) => /Error|Cannot read/.test(line))).toEqual([]);
  });

  test("the limits show their bounds and save only what changed", async () => {
    let sent: { path: string; body: unknown }[] = [];
    let limits = "";
    await renderPage("/missions", async (host) => {
      press(host, "Limits");
      await eventually(() => host.textContent?.includes("of work before it asks to go on") === true, 2_000, "the limits");
      limits = host.textContent ?? "";
      const record = recordPosts();
      type([...host.querySelectorAll('input[type="number"]')][3] as HTMLInputElement, "20");
      await enabled(host, "Save");
      press(host, "Save");
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(sent).toEqual([{ path: "/policy/missions", body: { limitTurns: 20 } }]);
    expect(limits).toContain("1–4");
    expect(limits).toContain("0.25–168, fractions allowed");
  });

  test("the limits show each default, empty where it is in force; tokens are millions; Back to defaults empties what was set", async () => {
    // Six agents on, the box's slots set by hand to 5 and the hours to 12.
    const defaults = { perAgent: 1, maxRunning: 3, limitHours: 8, limitTurns: 50, limitTokens: 50_000_000 };
    const bounds = {
      perAgent: { min: 1, max: 4, integer: true },
      maxRunning: { min: 1, max: 6, integer: true },
      limitHours: { min: 0.25, max: 168, integer: false },
      limitTurns: { min: 1, max: 1000, integer: true },
      limitTokens: { min: 100_000, integer: true },
    };
    overrides["/policy/missions"] = { status: 200, body: { ...defaults, maxRunning: 5, limitHours: 12, auto: false, defaults, bounds, editable: true } };
    let sent: { path: string; body: unknown }[] = [];
    let limits = "";
    let fields: { value: string; placeholder: string }[] = [];
    try {
      await renderPage("/missions", async (host) => {
        press(host, "Limits");
        await eventually(() => host.textContent?.includes("of work before it asks to go on") === true, 2_000, "the limits");
        limits = host.textContent ?? "";
        fields = [...host.querySelectorAll('input[type="number"]')].map((input) => ({ value: (input as HTMLInputElement).value, placeholder: (input as HTMLInputElement).placeholder }));
        const record = recordPosts();
        press(host, "Back to defaults");
        await enabled(host, "Save");
        press(host, "Save");
        await eventually(() => record.posts.length > 0, 2_000, "the save");
        record.restore();
        sent = record.posts;
      });
    } finally {
      delete overrides["/policy/missions"];
    }
    expect(fields).toEqual([
      { value: "", placeholder: "1" },
      { value: "5", placeholder: "3" },
      { value: "12", placeholder: "8" },
      { value: "", placeholder: "50" },
      { value: "", placeholder: "50" },
    ]);
    expect(limits).toContain("default 3 (half the agents, at most 8)");
    expect(limits).toContain("default 50M");
    expect(limits).toContain("0.1M or more");
    expect(limits).toContain("1–6");
    // Only what was set goes back: the rest is at its default already.
    expect(sent).toEqual([{ path: "/policy/missions", body: { maxRunning: null, limitHours: null } }]);
  });
});

/**
 * Whether a webhook can arrive from the internet (0.8.0): each card says local network only, reachable or unknown,
 * with why; Send a test goes to the hook's test route and runs nothing; the old Test, a run by hand, is Run now.
 */
describe("webhooks", () => {
  const hook = (id: string, extra: Record<string, unknown>) => ({
    id,
    agentId: "nouva",
    name: id,
    enabled: true,
    trigger: { kind: "webhook" },
    payload: { kind: "agentTurn", message: "look at it" },
    delivery: { mode: "announce" },
    target: { gatewayId: "telegram:nouva", chatId: "1" },
    session: "fresh",
    createdBy: "tester",
    createdAt: 0,
    runCount: 0,
    failCount: 0,
    failStreak: 0,
    webhookToken: `tok-${id}`,
    path: `/hooks/tok-${id}`,
    ...extra,
  });

  test("each says whether a call from outside can arrive; Send a test posts to its test route", async () => {
    overrides["/webhooks"] = {
      status: 200,
      body: {
        webhooks: [
          hook("github", { url: "https://box.example.com/hooks/tok-github", urlGuessed: false, reach: { state: "unknown", why: "Not tested yet. Send a test to find out." } }),
          hook("lan", { url: "http://localhost:18254/hooks/tok-lan", urlGuessed: true, reach: { state: "local", why: "No public address is set, so only this network can call it." } }),
        ],
      },
    };
    let page = "";
    let sent: { path: string; body: unknown }[] = [];
    let tests = 0;
    await renderPage("/webhooks", async (host) => {
      await eventually(() => host.textContent?.includes("Reach unknown") === true, 2_000, "the hooks");
      page = host.textContent ?? "";
      tests = buttons(host).filter((label) => label === "Send a test").length;
      const record = recordPosts({ "/webhooks/github/test": { status: 200, body: { webhook: hook("github", { url: "https://box.example.com/hooks/tok-github", urlGuessed: false, reach: { state: "internet", why: "A test sent through the public address arrived (arrived in 40 ms)." } }) } } });
      press(host, "Send a test");
      await eventually(() => record.posts.length > 0, 2_000, "the test");
      record.restore();
      sent = record.posts;
    });
    expect(page).toContain("Local network only");
    expect(page).toContain("No public address is set");
    expect(page).toContain("this server needs an address the internet can reach");
    // The public address when one is set — what a service outside is handed, and what the test goes through.
    expect(page).toContain("https://box.example.com/hooks/tok-github");
    // Only a hook with a public address has something to test through.
    expect(tests).toBe(1);
    expect(page).toContain("Run now");
    expect(sent).toEqual([{ path: "/webhooks/github/test", body: {} }]);
    expect(errors.filter((line) => /Error|Cannot read/.test(line))).toEqual([]);
  });

  test("a delivery that started a mission links to it (0.8.0)", async () => {
    const github = hook("github", { url: "https://box.example.com/hooks/tok-github", urlGuessed: false, reach: { state: "unknown", why: "Not tested yet." }, payload: { kind: "mission", goal: "Look into the new issue." } });
    overrides["/webhooks"] = { status: 200, body: { webhooks: [github] } };
    overrides["/cron/github"] = { status: 200, body: { job: github, runs: [{ id: "r1", jobId: "github", startedAt: 0, finishedAt: 1, status: "success", result: "started mission msn_1a2b" }] } };
    let links: string[] = [];
    let page = "";
    await renderPage("/webhooks", async (host) => {
      await eventually(() => host.textContent?.includes("Mission: Look into the new issue.") === true, 2_000, "the hook");
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Recent deliveries")!.click();
      await eventually(() => host.textContent?.includes("started mission") === true, 2_000, "the deliveries");
      page = host.textContent ?? "";
      links = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((href) => href.includes("msn_"));
    });
    expect(page).toContain("started mission msn_1a2b");
    expect(links).toEqual([expect.stringContaining("/missions/msn_1a2b")]);
  });
});
