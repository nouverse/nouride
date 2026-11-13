/**
 * The knowledge base (0.8.20): its collections and their documents, for the dashboard's
 * Knowledge tab and `nouride knowledge`. Everything goes through `Memory.knowledge`, so a name is made safe and a
 * folder written in one place.
 *
 * Roles: reading is an operator's, as memory's reads are: a collection may be kept for one person, and a viewer reading
 * it through these routes read what its rule keeps from every chat but theirs. Making a collection and adding or
 * removing a document is an operator's too, the role memory's own writes need. Who may be answered from a collection beyond the person who made it, and deleting one, is an
 * admin's (opened on purpose, by someone who may).
 */

import type { KnowledgeCollection, KnowledgeDocument, KnowledgeHit, KnowledgeSection, PendingDocument, RelatedDocument, SavedDocument } from "@nouride/wire";
import { idsOf } from "@/modules/people/match.ts";
import { collectionIdOf, TITLE_MAX, type CollectionSettings, type CollectionView, type KnowledgeReaders } from "@/modules/memory/index.ts";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { notSaved } from "../plain.ts";

/** Files one upload may carry. */
const FILES_PER_UPLOAD = 20;

/** Each field of a collection's form a refusal names (0.8.23), as the form names it. The archive switch is none. */
const COLLECTION_FIELDS = {
  name: "the name",
  description: "what is in it",
  readers: "who may be answered from it",
  agents: "which agents look in it",
  about: "who it is about",
} as const;

/** Why a collection's settings cannot be, and in which field of its form. */
type SettingsRefused = { error: string; field?: keyof typeof COLLECTION_FIELDS };

/** Said in the chat a document waited from, once an admin approved it (0.8.23). */
function approvedLine(title: string, collection: string): string {
  return `An admin added "${title}" to ${collection}, so your agents can find it now.`;
}

/** Said there once an admin declined it. */
function declinedLine(title: string, collection: string): string {
  return `An admin did not add "${title}" to ${collection}, so it was not kept.`;
}

/** The dashboard's words for a change the knowledge folder refused, by why (`KnowledgeRefusal`). */
function refusedWords(why: "name" | "taken" | "missing"): string {
  if (why === "name") return "That name cannot be used. Use letters, digits and spaces.";
  if (why === "taken") return "There is already a collection with that name.";
  return "That collection is not there any more. Reload the page.";
}

/** A collection as the page and the command line read it. */
function viewOf(collection: CollectionView) {
  const { settings } = collection;
  return {
    id: collection.id,
    name: settings.name,
    description: settings.description,
    readers: settings.readers,
    agents: settings.agents,
    about: settings.about,
    archived: settings.archived,
    documents: collection.documents,
    sections: collection.sections,
    ...(collection.problem ? { problem: collection.problem } : {}),
  };
}

/** Readers as JSON sends them, or why not. */
function readersFrom(value: unknown, people: readonly string[]): KnowledgeReaders | string {
  if (!value || typeof value !== "object") return "readers must be an object with a kind";
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "everyone" || kind === "admins") return { kind };
  if (kind === "group") {
    const chat = (value as { chat?: unknown }).chat;
    return typeof chat === "string" && chat.trim() ? { kind, chat: chat.trim() } : "a group's readers name its chat";
  }
  if (kind === "people") {
    const keys = (value as { people?: unknown }).people;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === "string")) return "readers name at least one person";
    const unknown = keys.filter((key) => !people.includes(key));
    return unknown.length ? `nobody in People is called ${unknown.map((key) => `"${key}"`).join(", ")}` : { kind, people: keys };
  }
  return 'readers.kind is "everyone", "admins", "people" or "group"';
}

/** Whether these readers are only the person asking: an operator may keep a collection to themselves, no wider. */
function onlyThem(readers: KnowledgeReaders, person: string | null): boolean {
  return readers.kind === "people" && person !== null && readers.people.length === 1 && readers.people[0] === person;
}

export function registerKnowledgeRoutes(control: ControlApp, deps: ControlDeps): void {
  const memory = () => deps.memory!;
  const people = () => deps.ctx.config.people;

  /** The refusal for a route that needs this role and a knowledge base, or null to go on. */
  function refusal(principal: Principal, role: "operator" | "admin"): [string, 403 | 503] | null {
    if (!atLeast(principal, role)) return [`${role} only`, 403];
    if (!deps.memory?.knowledge.enabled()) return ["the knowledge base is not wired in this process", 503];
    return null;
  }

  /** The person whose dashboard account this is, by key: who a collection made here is for. */
  function personOf(principal: Principal): string | null {
    const account = principal.user?.id;
    if (!account) return null;
    return people().find((person) => idsOf(person).includes(`web:${account}`))?.key ?? null;
  }

  /** The settings a request asks for, over `base`, or why they cannot be. */
  function settingsFrom(body: Record<string, unknown>, base: CollectionSettings): CollectionSettings | SettingsRefused {
    const next = { ...base };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return { field: "name", error: "name is a line of at most 80 characters" };
      next.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string" || body.description.length > 300) return { field: "description", error: "description is at most 300 characters" };
      next.description = body.description.trim();
    }
    if (body.agents !== undefined) {
      if (body.agents === null) next.agents = null;
      else if (!Array.isArray(body.agents) || !body.agents.every((id) => typeof id === "string" && deps.registry.get(id))) return { field: "agents", error: "agents is null (every agent) or a list of agents this daemon has" };
      else next.agents = body.agents as string[];
    }
    if (body.about !== undefined) {
      const keys = people().map((person) => person.key);
      if (!Array.isArray(body.about) || !body.about.every((key) => typeof key === "string" && keys.includes(key))) return { field: "about", error: "about is a list of people's keys from People" };
      next.about = body.about as string[];
    }
    if (body.readers !== undefined) {
      const readers = readersFrom(body.readers, people().map((person) => person.key));
      if (typeof readers === "string") return { field: "readers", error: readers };
      next.readers = readers;
    }
    if (body.archived !== undefined) {
      if (typeof body.archived !== "boolean") return { error: "archived is true or false" };
      next.archived = body.archived;
    }
    return next;
  }

  control.get("/knowledge", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    return c.json({ collections: memory().knowledge.collections().map(viewOf) } satisfies { collections: KnowledgeCollection[] });
  });

  /**
   * A new collection. Who may be answered from it is the person who made it, unless an admin says wider; a person with
   * no one in People made it for the admins, as a folder made by hand is.
   */
  control.post("/knowledge", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);
    const maker = personOf(principal);
    const base: CollectionSettings = { name: "", description: "", agents: null, readers: maker ? { kind: "people", people: [maker] } : { kind: "admins" }, about: [], archived: false };
    const settings = settingsFrom(body, base);
    if ("error" in settings) return c.json({ error: settings.error, plain: notSaved(settings.field && COLLECTION_FIELDS[settings.field]) }, 400);
    if (!settings.name) return c.json({ error: "a collection needs a name", plain: notSaved(COLLECTION_FIELDS.name) }, 400);
    if (!atLeast(principal, "admin") && !onlyThem(settings.readers, maker) && settings.readers.kind !== "admins") {
      return c.json({ error: "only an admin opens a collection to more people than the one who made it" }, 403);
    }
    const made = await memory().knowledge.create(collectionIdOf(settings.name), settings);
    if ("refused" in made) return c.json({ error: made.refused, plain: refusedWords(made.why) }, 409);
    deps.audit.record({ action: "knowledge_collection_created", actor: principal.actor, details: { collection: made.id, readers: settings.readers.kind } });
    const view = memory().knowledge.collections().find((collection) => collection.id === made.id);
    return c.json({ collection: view ? viewOf(view) : null } satisfies { collection: KnowledgeCollection | null }, 201);
  });

  control.patch("/knowledge/:id", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const current = memory().knowledge.collection(c.req.param("id"));
    if (!current) return c.json({ error: `no collection "${c.req.param("id")}"` }, 404);
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "body must be a JSON object" }, 400);
    const settings = settingsFrom(body, current.settings);
    if ("error" in settings) return c.json({ error: settings.error, plain: notSaved(settings.field && COLLECTION_FIELDS[settings.field]) }, 400);
    if (body.readers !== undefined && !atLeast(principal, "admin") && !onlyThem(settings.readers, personOf(principal))) {
      return c.json({ error: "only an admin changes who may be answered from a collection" }, 403);
    }
    const written = await memory().knowledge.configure(current.id, settings);
    if ("refused" in written) return c.json({ error: written.refused, plain: refusedWords(written.why) }, 409);
    deps.audit.record({ action: "knowledge_collection_changed", actor: principal.actor, details: { collection: current.id, fields: Object.keys(body) } });
    const view = memory().knowledge.collections().find((collection) => collection.id === current.id);
    return c.json({ collection: view ? viewOf(view) : null } satisfies { collection: KnowledgeCollection | null });
  });

  control.delete("/knowledge/:id", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "admin");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    if (!(await memory().knowledge.removeCollection(id))) return c.json({ error: `no collection "${id}"` }, 404);
    deps.audit.record({ action: "knowledge_collection_deleted", actor: principal.actor, details: { collection: id } });
    return c.json({ ok: true } satisfies { ok: true });
  });

  control.get("/knowledge/:id/documents", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    if (!memory().knowledge.collection(id)) return c.json({ error: `no collection "${id}"` }, 404);
    return c.json({ documents: memory().knowledge.documents(id) } satisfies { documents: KnowledgeDocument[] });
  });

  /** One document and its sections, as search sees them. */
  control.get("/knowledge/:id/document", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    const document = memory().knowledge.document(id, path);
    if (!document) return c.json({ error: `no document "${path}" in "${id}"` }, 404);
    return c.json({ document, sections: memory().knowledge.sectionsOf(id, path) } satisfies { document: KnowledgeDocument; sections: KnowledgeSection[] });
  });

  /**
   * A document's nearest documents by meaning, three at most: the page's **Related documents**. None, with
   * `byMeaning` false, while search by meaning is off.
   */
  control.get("/knowledge/:id/related", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    if (!memory().knowledge.document(id, path)) return c.json({ error: `no document "${path}" in "${id}"` }, 404);
    return c.json(memory().knowledge.related(id, path) satisfies { byMeaning: boolean; related: RelatedDocument[] });
  });

  /** Files dropped on a collection, or a document written on the page (`name` and `text`). */
  control.post("/knowledge/:id/documents", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    if (!memory().knowledge.collection(id)) return c.json({ error: `no collection "${id}"` }, 404);
    const maxBytes = deps.ctx.config.attachments.maxSizeMb * 1024 * 1024;
    const incoming: { name: string; bytes: Uint8Array }[] = [];
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      let form: Record<string, unknown>;
      try {
        form = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
      } catch {
        return c.json({ error: "expected a multipart form" }, 400);
      }
      const raw = form.files ?? form.file;
      const files = (Array.isArray(raw) ? raw : [raw]).filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) return c.json({ error: "no files in the request" }, 400);
      if (files.length > FILES_PER_UPLOAD) return c.json({ error: `${files.length} files at once, over the limit of ${FILES_PER_UPLOAD}` }, 413);
      // The operator's own limit for a file sent in, the one every gateway's inbound files are held to.
      const big = files.find((file) => file.size > maxBytes);
      if (big) return c.json({ error: `${big.name} is larger than ${deps.ctx.config.attachments.maxSizeMb} MB` }, 413);
      for (const file of files) incoming.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    } else {
      const body = await jsonBody(c);
      if (!body || typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "send files, or a document's name with its text or its bytes" }, 400);
      if (typeof body.base64 === "string") {
        // A file the command line read on this machine (`nouride knowledge add`), its bytes as they are.
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(atob(body.base64), (char) => char.charCodeAt(0));
        } catch {
          return c.json({ error: "base64 is not base64" }, 400);
        }
        if (bytes.length > maxBytes) return c.json({ error: `${body.name} is larger than ${deps.ctx.config.attachments.maxSizeMb} MB` }, 413);
        incoming.push({ name: body.name.trim(), bytes });
      } else if (typeof body.text === "string" && body.text.trim()) {
        // A document written on the page: Markdown, named after its title.
        const name = /\.(md|markdown|txt)$/i.test(body.name.trim()) ? body.name.trim() : `${body.name.trim()}.md`;
        incoming.push({ name, bytes: new TextEncoder().encode(body.text) });
      } else return c.json({ error: "send files, or a document's name with its text or its bytes" }, 400);
    }
    const saved = [];
    for (const file of incoming) {
      const added = await memory().knowledge.add(id, file.name, file.bytes);
      if ("refused" in added) return c.json({ error: added.refused, plain: refusedWords(added.why) }, 400);
      saved.push({ path: added.path, status: added.document?.status ?? "indexed", ...(added.document?.reason ? { reason: added.document.reason } : {}) });
    }
    deps.audit.record({ action: "knowledge_documents_added", actor: principal.actor, details: { collection: id, documents: saved.map((file) => file.path) } });
    return c.json({ saved } satisfies { saved: SavedDocument[] }, 201);
  });

  control.delete("/knowledge/:id/documents", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    if (!(await memory().knowledge.remove(id, path))) return c.json({ error: `no document "${path}" in "${id}"` }, 404);
    deps.audit.record({ action: "knowledge_document_removed", actor: principal.actor, details: { collection: id, document: path } });
    return c.json({ ok: true } satisfies { ok: true });
  });

  /**
   * A document's title, what search finds it by in any language (0.8.23): `{ "title": "…" }` sets it, `null` or "" takes
   * it off. The file keeps its name.
   */
  control.patch("/knowledge/:id/documents", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const path = c.req.query("path") ?? "";
    const body = await jsonBody(c);
    if (!body || (body.title !== null && typeof body.title !== "string")) return c.json({ error: "title is a line of words, or null to take it off" }, 400);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : null;
    if (title && title.length > TITLE_MAX) return c.json({ error: `title is at most ${TITLE_MAX} characters`, plain: notSaved("the title") }, 400);
    const done = await memory().knowledge.retitle(id, path, title);
    if ("refused" in done) return c.json({ error: done.refused, plain: refusedWords(done.why) }, done.why === "missing" ? 404 : 400);
    deps.audit.record({ action: "knowledge_document_titled", actor: principal.actor, details: { collection: id, document: path, titled: title !== null } });
    return c.json({ document: done.document } satisfies { document: KnowledgeDocument | null });
  });

  /** Documents saved from a chat into a collection wider than that chat, waiting for an admin's yes. */
  control.get("/knowledge/:id/pending", (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    if (!memory().knowledge.collection(id)) return c.json({ error: `no collection "${id}"` }, 404);
    return c.json({ pending: memory().knowledge.pending(id) } satisfies { pending: PendingDocument[] });
  });

  control.post("/knowledge/:id/pending/:decision", async (c) => {
    const principal = c.get("principal");
    const no = refusal(principal, "admin");
    if (no) return c.json({ error: no[0] }, no[1]);
    const id = c.req.param("id");
    const decision = c.req.param("decision");
    if (decision !== "approve" && decision !== "decline") return c.json({ error: "approve or decline" }, 404);
    const body = await jsonBody(c);
    const path = typeof body?.path === "string" ? body.path : "";
    // Read before the answer moves or deletes it: the chat it came from is told, and its agent knows (0.8.23).
    const waiting = memory().knowledge.pending(id).find((document) => document.path === path);
    const collection = memory().knowledge.collection(id)?.settings.name ?? id;
    const tell = (said: string) => {
      if (!waiting?.chat || !deps.pipeline) return;
      const note = `An admin answered about the document "${waiting.title}" you kept for ${collection}, which waited for a yes. The line below was posted in this chat.`;
      void deps.pipeline.sayInChat(waiting.chat, said, note);
    };
    if (decision === "decline") {
      if (!memory().knowledge.decline(id, path)) return c.json({ error: `nothing called "${path}" waits in "${id}"` }, 404);
      deps.audit.record({ action: "knowledge_document_declined", actor: principal.actor, details: { collection: id, document: path } });
      if (waiting) tell(declinedLine(waiting.title, collection));
      return c.json({ ok: true } satisfies { ok: true });
    }
    const joined = await memory().knowledge.approve(id, path);
    if (!joined) return c.json({ error: `nothing called "${path}" waits in "${id}"` }, 404);
    deps.audit.record({ action: "knowledge_document_approved", actor: principal.actor, details: { collection: id, document: joined.path } });
    if (waiting) tell(approvedLine(waiting.title, collection));
    return c.json({ saved: { path: joined.path, status: joined.document?.status ?? "indexed", ...(joined.document?.reason ? { reason: joined.document.reason } : {}) } } satisfies { saved: SavedDocument });
  });

  /** The index brought in line with the folder: every collection, or one. */
  control.post("/knowledge/sync", async (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const body = (await jsonBody(c)) ?? {};
    const only = typeof body.collection === "string" && body.collection.trim() ? body.collection.trim() : undefined;
    if (only && !memory().knowledge.collection(only)) return c.json({ error: `no collection "${only}"` }, 404);
    return c.json(await memory().knowledge.sync(only));
  });

  /** The collections' sections that match, best first: what search finds in them, for whoever runs the box. */
  control.get("/knowledge/search", async (c) => {
    const no = refusal(c.get("principal"), "operator");
    if (no) return c.json({ error: no[0] }, no[1]);
    const query = c.req.query("q")?.trim() ?? "";
    if (!query) return c.json({ error: "q is the words to search for" }, 400);
    const only = c.req.query("collection")?.trim();
    return c.json({ hits: await memory().knowledge.search(query, only || undefined) } satisfies { hits: KnowledgeHit[] });
  });
}
