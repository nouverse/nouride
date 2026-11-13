/**
 * What is kept, for the operator — the dashboard's Memory menu (`docs/SPEC.md` §12):
 *
 * - **People and shared knowledge**: a profile per person with a key, and `shared.md`, named by their
 *   subject (a key, or `shared`), read and edited with their history.
 * - **Conversations**: every episode, filtered, read whole (the archived transcript too), deleted.
 * - **Agent notes**: each agent's own `MEMORY.md`, read-only — it is the agent's, git-tracked beside
 *   its persona, and a text box in a browser is the one editor that leaves no record of who changed it.
 *
 * All an operator's: these are unfiltered by audience, which is what an operator is for. A browser
 * never names a path; `modules/memory/manage.ts` maps a subject to its file.
 */

import type { AgentNotes, Episode, EpisodeSummary, MemoryFacets, MemoryGraph, PersonSummary } from "@nouride/wire";
import { gzipText, join, readTextFileIfExists, statFile } from "@nouride/runtime";
import type { EpisodeStatus } from "@/modules/memory/index.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EPISODES_MAX = 500;
/** The graph's conversations: enough to see a shape by default, and a ceiling a small box answers fast. */
const GRAPH_DEFAULT = 300;
const GRAPH_MAX = 1500;
/** Values per filter kind — a checklist ticked by hand, so far past anything a person picks. */
const GRAPH_VALUES_MAX = 50;
const STATUSES: readonly EpisodeStatus[] = ["raw", "summarized", "compacted"];

/**
 * JSON, gzipped when the browser takes it — the graph and its facets are the two memory answers big
 * enough to matter on a phone link, a fifth of their size compressed. The daemon sits behind no proxy
 * that would do it.
 */
function jsonGzipped(c: { req: { header(name: string): string | undefined }; json(body: unknown): Response; body(data: Uint8Array<ArrayBuffer>, status: 200, headers: Record<string, string>): Response }, body: unknown): Response {
  if (!/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) return c.json(body);
  return c.body(gzipText(JSON.stringify(body)) as Uint8Array<ArrayBuffer>, 200, { "content-type": "application/json; charset=utf-8", "content-encoding": "gzip", vary: "accept-encoding" });
}

export function registerMemoryDocumentRoutes(control: ControlApp, deps: ControlDeps): void {
  function refusal(principal: Parameters<typeof atLeast>[0]): [string, 403 | 503] | null {
    if (!atLeast(principal, "operator")) return ["operator only", 403];
    if (!deps.memory) return ["memory is not wired in this process", 503];
    return null;
  }

  // ─── people and shared knowledge ───

  control.get("/memory/people", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({ people: deps.memory!.people() } satisfies { people: PersonSummary[] });
  });

  control.get("/memory/documents/:subject", async (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const result = await deps.memory!.readDocument(c.req.param("subject"));
    return "refused" in result ? c.json({ error: result.refused, plain: "Nouride keeps nothing under that name. Reload the page." }, 404) : c.json(result);
  });

  control.get("/memory/documents/:subject/versions/:version", async (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const result = await deps.memory!.readDocumentVersion(c.req.param("subject"), c.req.param("version"));
    return "refused" in result ? c.json({ error: result.refused, plain: "That earlier version is not kept any more." }, 404) : c.json(result);
  });

  control.put("/memory/documents/:subject", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = await jsonBody(c);
    if (typeof body?.content !== "string" || typeof body.expected !== "string") {
      return c.json({ error: "content and expected (the text the editor opened) are required" }, 400);
    }
    const subject = c.req.param("subject");
    const result = await deps.memory!.writeDocument(subject, body.content, body.expected);
    if ("refused" in result) return c.json({ error: result.refused, plain: "This was not saved: it changed since you opened it, or it is not one Nouride keeps. Reload it, and edit again." }, 409);
    if (result.status === "written") deps.audit?.record({ action: "memory_document_edited", actor: principal.actor, details: { subject } });
    return c.json(result);
  });

  control.post("/memory/documents/:subject/undo", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const subject = c.req.param("subject");
    const result = await deps.memory!.undoDocument(subject);
    if ("refused" in result) return c.json({ error: result.refused }, 404);
    if (result.restored) deps.audit?.record({ action: "memory_undone", actor: principal.actor, details: { subject } });
    return c.json({ subject, ...result });
  });

  // ─── conversations ───

  control.get("/memory/episodes", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const since = c.req.query("since");
    const until = c.req.query("until");
    for (const [name, value] of [["since", since], ["until", until]] as const) {
      if (value !== undefined && !DATE.test(value)) return c.json({ error: `${name} must be YYYY-MM-DD` }, 400);
    }
    const status = c.req.query("status") as EpisodeStatus | undefined;
    if (status !== undefined && !STATUSES.includes(status)) return c.json({ error: `status is one of ${STATUSES.join(", ")}` }, 400);
    const agent = c.req.query("agent");
    const person = c.req.query("person");
    const tag = c.req.query("tag");
    const query = c.req.query("q");
    const limit = Math.min(EPISODES_MAX, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    const episodes = deps.memory!.episodes(
      {
        ...(agent ? { agents: [agent] } : {}),
        ...(person ? { people: [person] } : {}),
        ...(tag ? { tags: [tag] } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        ...(status ? { statuses: [status] } : {}),
        ...(query ? { query } : {}),
      },
      limit,
    );
    return c.json({ episodes } satisfies { episodes: EpisodeSummary[] });
  });

  /**
   * Conversations and the people, tags and agents they link to — the dashboard's graph. Ids, short
   * labels and pairs only; the page opens a conversation through the route below. `knowledge=1` lays the
   * knowledge base's collections and documents over it (0.8.20), off unless asked for.
   */
  control.get("/memory/graph", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const since = c.req.query("since");
    const until = c.req.query("until");
    for (const [name, value] of [["since", since], ["until", until]] as const) {
      if (value !== undefined && !DATE.test(value)) return c.json({ error: `${name} must be YYYY-MM-DD` }, 400);
    }
    // Each may repeat — `?agent=nouva&agent=nix` — and matches any of its values. Sorted and
    // de-duplicated, so the same choice in another order is the same cached graph.
    const many = (name: string) => [...new Set((c.req.queries(name) ?? []).filter(Boolean))].sort().slice(0, GRAPH_VALUES_MAX);
    const agents = many("agent");
    const people = many("person");
    const tags = many("tag");
    const limit = Math.min(GRAPH_MAX, Math.max(1, Number(c.req.query("limit") ?? GRAPH_DEFAULT) || GRAPH_DEFAULT));
    const graph = deps.memory!.graph(
      {
        ...(agents.length ? { agents } : {}),
        ...(people.length ? { people } : {}),
        ...(tags.length ? { tags } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
      },
      limit,
      { knowledge: c.req.query("knowledge") === "1" },
    );
    return jsonGzipped(c, graph satisfies MemoryGraph);
  });

  /** Every agent, person and tag the graph can be filtered by, with how many conversations have each. */
  control.get("/memory/facets", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    return jsonGzipped(c, deps.memory!.graphFacets() satisfies MemoryFacets);
  });

  control.get("/memory/episodes/:id", async (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const result = await deps.memory!.episode(c.req.param("id"));
    return result ? c.json(result satisfies { episode: Episode; archived?: string }) : c.json({ error: "no such conversation" }, 404);
  });

  /** Delete one conversation, its archive copy and the facts it sourced. Final, and said so by the dashboard. */
  control.delete("/memory/episodes/:id", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal);
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const result = await deps.memory!.deleteEpisode(id);
    if (result.episodes === 0) return c.json({ error: "no such conversation" }, 404);
    deps.audit?.record({ action: "memory_episode_deleted", actor: principal.actor, details: { id, facts: result.facts } });
    return c.json({ id, ...result } satisfies { id: string; episodes: number; facts: number });
  });

  // ─── agent notes ───

  control.get("/memory/agents", (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({
      agents: deps.registry.all().map((agent) => {
        const stat = statFile(join(agent.dir, "MEMORY.md"));
        return { id: agent.config.id, name: agent.config.displayName, bytes: stat?.size ?? 0, updatedAt: stat ? Math.round(stat.mtimeMs) : null };
      }),
    } satisfies { agents: AgentNotes[] });
  });

  control.get("/memory/agents/:id", async (c) => {
    const no = refusal(c.get("principal"));
    if (no) return c.json({ error: no[0] }, no[1]);
    const agent = deps.registry.get(c.req.param("id"));
    if (!agent) return c.json({ error: "no such agent" }, 404);
    const content = await readTextFileIfExists(join(agent.dir, "MEMORY.md"));
    return c.json({ id: agent.config.id, name: agent.config.displayName, content: content ?? "", exists: content !== null } satisfies { id: string; name: string; content: string; exists: boolean });
  });
}
