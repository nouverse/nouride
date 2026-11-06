/**
 * `person_record` — writing down who you are talking to.
 *
 * ## Why this exists as a tool and not as advice
 *
 * It was advice. The identity section of the prompt has told agents for a while to run
 * `nouride people set <id> --name <name>`, and it says plainly that memory is not a substitute. On
 * 2026-09-02 somebody introduced themselves to `ren` on Telegram and the audit log shows exactly one
 * call: `memory_write` with `## User\n\n- **Name:** Gading`. The agent had the `nouride` tool. It
 * had read the sentence. It reached for the typed tool sitting in its list instead.
 *
 * That is not the model being careless, it is the shape of the choice. `memory_write` is one
 * argument away and the memory section of the harness says "write a fact about the person"; the
 * alternative was a clause in a paragraph asking it to compose a shell invocation through a generic
 * CLI tool. A typed tool beats prose about a command every time, so the fix is to make the right
 * thing a typed tool rather than to write a firmer sentence.
 *
 * ## Why it is not memory
 *
 * `[[people]]` is what the *harness* reads to open a turn with "You are talking to Gading". Memory is
 * never consulted for that, so a name written there leaves the next conversation still saying "I do
 * not know who you are" — which is what was actually observed. And `MEMORY.md` lives in a persona
 * pack that is usually a git repository: a household's platform ids do not belong in one.
 *
 * ## Not approval-gated
 *
 * It writes a name and a note into the daemon's own config, granting nobody anything — `[[people]]`
 * is identity, never permission, and the approval gate is still what decides what anyone may do.
 * Stopping a turn to ask before writing down a name somebody just volunteered would make the agent
 * hesitate to do the one thing this exists to make automatic.
 *
 * Except after outside content (S13): the name and the note open every later turn with that person,
 * so in a turn that read a page, a forwarded message or a webhook's payload first, a person says yes
 * before they are written (`Tool.keepsInPrompt`) — unless the approval level is `trusted`.
 */

import { createLogger, type Person, type Tool, type ToolResult } from "@nouride/shared";
import { savePerson, updatePersonNotes, type PeopleWriteDeps } from "@/modules/config/settings/people.ts";
import { canonicalPersonId, idFormsFor, idsOf } from "@/modules/people/match.ts";
import { editNotes, type NotesChange, type NotesEdit } from "@/modules/people/notes.ts";

const log = createLogger("tools.people");

export interface PeopleToolOptions {
  /**
   * Everything needed to write one person, and nothing else.
   *
   * The same three fields `SettingsService` uses for this, so the dashboard's writes and the agent's
   * land in the same file and the same in-memory copy — a second writer that disagreed with the first
   * about either would leave the running daemon and `config.toml` describing different households.
   */
  deps: PeopleWriteDeps;
  /** Whether `memory_write` takes about=person here — where a fact goes once a person has notes. */
  memory?: boolean;
}

/**
 * The id to record against, when the model does not name one.
 *
 * Derived here rather than passed in as an argument, from the same `idFormsFor` the prompt's identity
 * line and the `[[people]]` matcher both use — so the id this writes is by construction the id the
 * matcher will look for. A model asked to reconstruct `telegram:5550001111` from context will
 * eventually reconstruct it wrong, and a wrong id writes a name onto nobody, silently.
 *
 * The platform-qualified form (`telegram:…`) over the gateway-qualified one (`telegram:ren:…`),
 * matching `personRefPlatform`: recognised whichever of this install's bots the person talks to next.
 */
function senderId(ctx: { gatewayId: string; senderId: string }): string {
  return idFormsFor(ctx).at(-1) ?? "";
}

export function createPersonRecordTool(options: PeopleToolOptions): Tool {
  return {
    requiresApproval: false,
    // The name and note open every turn with them: written after outside content, a person says yes first (S13).
    keepsInPrompt: true,
    definition: {
      name: "person_record",
      description:
        "Write down who you are talking to, so every future conversation opens already knowing them. Do not ask for a name. If they give it, record it here at once, not in memory: identity is read from this record, never from memory. Also takes a one-line note, for somebody nobody has described yet.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "What to call them, as they gave it.",
          },
          note: {
            type: "string",
            description:
              "Optional, one line shown on every turn with them: how to address them and their role. Written only while they have no notes; after that, `person_notes` changes them.",
          },
        },
        required: ["name"],
      },
    },

    async execute(args, ctx) {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return fail("`name` is required: this records who somebody is.");

      /**
       * This records the person speaking, and there is no way to name somebody else.
       *
       * There used to be an `id` argument for that — "only with an id you were actually given",
       * which is prose, and prose lost. Observed live: a person tagged an agent in a channel, the
       * message text therefore contained that agent's own mention token, and a second agent called
       * this tool with that token as the id and the *person's* name. The result was one of this
       * daemon's own bots sitting in `[[people]]` as a human, and it took the operator two
       * conversations to work out what the extra entry even was.
       *
       * That was not carelessness. The doc comment on `senderId` above already says why the default
       * is derived from the context — "a model asked to reconstruct `telegram:5550001111` from
       * context will eventually reconstruct it wrong, and a wrong id writes a name onto nobody,
       * silently" — and the argument was a door back to exactly that. Every id a model types is
       * reconstructed from what it happens to be reading, and what it is reading is full of ids
       * belonging to somebody else.
       *
       * A stray value is still refused rather than ignored, because a model that sent one meant
       * something by it and deserves to be told where that belongs.
       */
      const supplied = typeof args.id === "string" ? args.id.trim() : "";
      const id = senderId({ gatewayId: ctx.gatewayId, senderId: ctx.senderId });
      if (!id) return fail("There is no id to record this against on this connection.");
      if (supplied && !idFormsFor({ gatewayId: ctx.gatewayId, senderId: ctx.senderId }).includes(supplied)) {
        return fail(
          `This records whoever is speaking to you, and ${supplied} is not them: it writes ` +
            `${id}. An id read out of a conversation is a guess, and the ids in a conversation ` +
            "usually belong to somebody else: a mention token names the agent being tagged, not " +
            "the person tagging it. To record somebody who is not here, use `people set <id> " +
            "--name <name>` through the `nouride` tool, where the id you chose is visible in the " +
            "command rather than hidden behind a name.",
        );
      }

      const note = typeof args.note === "string" ? args.note.replace(/\s+/g, " ").trim() : "";

      /**
       * Notes somebody already has are a page, and a note from here never replaces them.
       *
       * It did: the note went to `savePerson` as `notes`, which means "set it", so an agent recording
       * a name with a one-line note erased whatever the operator had written about that person — on a
       * household install, a page of it (what USER.md was). A note is now the first line for somebody
       * nobody has described yet. After that, a line changes through `person_notes`, which never sends
       * the page; and what changes over time goes to their memory profile.
       */
      const described = Boolean(
        options.deps.config.people.find((candidate) => idsOf(candidate).includes(canonicalPersonId(id)))?.notes?.trim(),
      );
      const skipped = Boolean(note) && described;
      /**
       * Found by the account the message came from: whoever holds it is renamed, keeping every other
       * account they have; nobody, and a new person holds it, under a key made from their name that
       * nobody else holds.
       */
      const result = await savePerson(options.deps, {
        person: { name, ...(note && !described ? { notes: note } : {}) },
        account: id,
        // The agent, not the person: the audit row answers "who caused this", and a name arriving
        // through a model is a different provenance from one the operator typed into the dashboard.
        actor: ctx.agentId,
      });
      if (!result.ok) return fail(`Could not record them: ${result.error}`);

      log.info("person recorded by an agent", { agent_id: ctx.agentId, person: id, name, ...(skipped ? { note_skipped: true } : {}) });
      return {
        content:
          `Recorded ${name} as ${id}. Every agent here will know them from the next message, so you do not need to write this to memory as well.` +
          (skipped
            ? " Your note was not written: they already have notes. Add a line to them with `person_notes`." +
              (options.memory ? " What changes over time goes to `memory_write` with about=person." : "")
            : ""),
        isError: false,
        metadata: { person: id, name, ...(skipped ? { noteSkipped: true } : {}) },
      };
    },
  };
}

/**
 * `person_notes` — the person you are talking to, keeping their own notes.
 *
 * Notes are who somebody is and what does not change about them: their full name, what to call them,
 * who they are to whom, a birthday, an allergy. The operator writes them on the People page. Until this
 * an agent could only write a first line, for somebody nobody had described, so a person saying "my
 * birthday is 12 May" had it filed in memory beside what they were working on that week. Now they can
 * have it kept where it belongs.
 *
 * ## Only theirs
 *
 * Nobody's notes change at another person's word — the operator's included, through an agent. Notes
 * are read on every turn with that person, so a line somebody else put there would be said about them
 * in every conversation they have, and all a chat proves is which account a message came from. So no
 * argument says whose notes these are: they are the speaker's, found from the context the way
 * `person_record`'s id is, and an argument naming anybody else is refused out loud rather than ignored.
 * An admin changes anyone's on the People page, signed in.
 *
 * ## A line at a time
 *
 * An agent never sends the page — see `modules/people/notes.ts` — so it cannot reword what the operator
 * wrote while rewriting the page around the line it meant. And the read, the change and the write are
 * one turn of `[[people]]` writes (`updatePersonNotes`), so a dashboard save is never lost under it.
 *
 * ## Not approval-gated
 *
 * Like `person_record`: what somebody says about themselves, written into their own entry. It grants
 * nothing, and the audit row says who asked, through which agent, and what the line read before.
 */
export function createPersonNotesTool(options: PeopleToolOptions): Tool {
  return {
    requiresApproval: false,
    // Said to the agent on every turn with them: changed after outside content, a person says yes first (S13). Read freely.
    keepsInPrompt: (args) => args.change !== undefined,
    definition: {
      name: "person_notes",
      description:
        "The notes of the person you are talking to: who they are and what does not change (full name, what to call them, who they are to whom, birthday, where they live, allergies). Without `change`, returns them. When they tell you such a fact about themselves, or correct one, keep it here, a line at a time. Only ever theirs: nobody's notes change at somebody else's request, the operator's included. An admin edits those on the People page." +
        (options.memory ? " What changes over time (work, plans, tastes) goes to `memory_write` with about=person." : ""),
      parameters: {
        type: "object",
        properties: {
          change: {
            type: "string",
            enum: ["add", "update", "remove"],
            description: "Leave out to read them. add a line, or update or remove the line named by `current`.",
          },
          content: { type: "string", description: "For add and update: the line as it should read, one fact, in the language their notes are in." },
          current: { type: "string", description: "For update and remove: the line as it reads now, word for word." },
          section: { type: "string", description: "For add: the heading to put it under (Family, Health…). Left out, it goes at the top." },
        },
      },
    },

    async execute(args, ctx) {
      const forms = ctx.senderId ? idFormsFor({ gatewayId: ctx.gatewayId, senderId: ctx.senderId }) : [];
      const speaker = options.deps.config.people.find((candidate) => idsOf(candidate).some((id) => forms.includes(id)));

      // Whose notes, in an argument the schema does not have: the speaker's is harmless, anybody else's
      // is the request this tool exists to refuse.
      const named = ["person", "name", "who", "key", "id", "target"].map((key) => args[key]).find((value) => typeof value === "string" && value.trim());
      if (typeof named === "string" && !(speaker && isSpeaker(speaker, named))) {
        return fail(
          `These are only ever the notes of the person you are talking to, changed at their word: nobody else's, ` +
            `whoever asks, the operator included. Somebody changes their own by asking an agent themselves; an ` +
            `admin changes anyone's on the People page.`,
        );
      }
      if (!speaker) {
        return fail(
          ctx.gateway === "web"
            ? "The account you are talking to is not linked to anybody in People, so there are no notes of theirs here. An admin links it on the People page."
            : "The person you are talking to is not in People, so there are no notes of theirs to keep. If they have told you who they are, record them with `person_record` first.",
        );
      }

      const notes = speaker.notes?.trim() ?? "";
      if (args.change === undefined) {
        return { content: notes ? `${speaker.name}'s notes:\n\n${notes}` : `${speaker.name} has no notes yet.`, isError: false };
      }
      const change = toChange(args);
      if (typeof change === "string") return fail(change);

      let edit: NotesEdit | undefined;
      const result = await updatePersonNotes(options.deps, {
        key: speaker.key,
        edit: (current) => {
          edit = editNotes(current, change);
          return edit.ok ? { ok: true, notes: edit.notes } : { ok: false, error: edit.error };
        },
        // Who caused it is the person who asked — the agent is the channel, and is named beside it.
        ...(forms.at(-1) ? { actor: forms.at(-1) } : {}),
        audit: () => ({
          action: "person_notes_changed",
          ...(forms.at(-1) ? { actor: forms.at(-1) } : {}),
          agentId: ctx.agentId,
          gatewayId: ctx.gatewayId,
          chatId: ctx.chatId,
          details: {
            key: speaker.key,
            name: speaker.name,
            change: change.change,
            ...(edit?.ok ? { line: edit.line, ...(edit.was ? { was: edit.was } : {}) } : {}),
          },
        }),
      });

      if (!result.ok) {
        const shown = edit && !edit.ok && (edit.reason === "not_found" || edit.reason === "ambiguous");
        return fail(`${result.error}${shown ? `\n\nTheir notes as they are now:\n\n${notes || "(none)"}` : ""}`);
      }
      const done = edit as Extract<NotesEdit, { ok: true }>;
      log.info("notes changed by an agent", { agent_id: ctx.agentId, person: speaker.key, change: change.change, ...(done.unchanged ? { unchanged: true } : {}) });
      const name = result.person.name;
      const content = done.unchanged
        ? change.change === "add"
          ? `Already in ${name}'s notes: ${done.line}`
          : `${name}'s notes already read that way: ${done.line}`
        : change.change === "add"
          ? `Added to ${name}'s notes: ${done.line}`
          : change.change === "update"
            ? `Changed in ${name}'s notes: "${done.was}" now reads "${done.line}".`
            : `Removed from ${name}'s notes: ${done.line}`;
      return { content, isError: false, metadata: { person: speaker.key, change: change.change, ...(done.unchanged ? { unchanged: true } : {}) } };
    },
  };
}

/** Whether a name the model sent is the speaker's own — their name, key or an id they hold. */
function isSpeaker(person: Person, named: string): boolean {
  const value = named.trim().toLowerCase();
  if (["me", "myself", "self", "speaker", "user", "them"].includes(value)) return true;
  if (value === person.name.trim().toLowerCase() || value === person.key?.toLowerCase()) return true;
  return idsOf(person).includes(canonicalPersonId(named));
}

/** The arguments as one change, or what is wrong with them. */
function toChange(args: Record<string, unknown>): NotesChange | string {
  const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (args.change) {
    case "add":
      return { change: "add", content: text("content"), ...(text("section").trim() ? { section: text("section") } : {}) };
    case "update":
      return { change: "update", current: text("current"), content: text("content") };
    case "remove":
      return { change: "remove", current: text("current") };
    default:
      return '`change` is "add", "update" or "remove", or left out to read their notes.';
  }
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}
