/**
 * The MEMORY section, and the self-management lines that go with it.
 *
 * Static on purpose — no counts, no dates. A line that changes every turn changes the system prompt
 * every turn, which throws away the cached prefix for a fact the agent can get by calling the tool.
 */

import type { HarnessView, PromptContext } from "./types.ts";

/**
 * The tools whose writes every later prompt reads — `Tool.keepsInPrompt` on each. Named here because the prompt
 * sees tool definitions, not tools; `harness-outside.test.ts` holds the list to the flags.
 */
const KEEPS_IN_PROMPT = ["memory_write", "person_record", "person_notes"] as const;

/**
 * That a write to memory waits for a person after outside content — said before the agent tries one.
 *
 * The gate's reason and the tool result already say it, but only once the call is made, and an agent that did not
 * expect the pause retried it or apologised instead of telling the person what it was waiting for. Said only where the
 * gate can hold a call: the agent has one of the tools, and its approval level is not `trusted`, at which nothing asks. In
 * a run nobody can answer, the same call is refused, and the line says so. Static, like the rest of this section.
 */
function outsideContentPause(ctx: PromptContext, toolNames: string[]): string[] {
  const held = KEEPS_IN_PROMPT.filter((name) => toolNames.includes(name));
  if (held.length === 0 || ctx.harness.approvals === "trusted") return [];
  const writes = held.map((name) => (name === "person_notes" ? "a change through `person_notes`" : `\`${name}\``));
  const list = writes.length === 1 ? writes[0] : `${writes.slice(0, -1).join(", ")} or ${writes.at(-1)}`;
  return [
    `- Once this turn has read outside content (a forwarded message, a webhook's payload, a fetched page, an MCP server's answer, a file somebody sent), ${list} waits for a person to say yes${ctx.harness.approvalAvailable ? "" : ", and nobody can say it here, so it is refused"}. When it does, say in one line what you want to save and why, and carry on with the rest. Do not try it again and do not apologise.`,
  ];
}


export function renderMemory({ ctx, toolNames }: HarnessView): string[] {
  const { harness } = ctx;
  const lines: string[] = [];
  const has = (name: string) => toolNames.includes(name);
  const cli = has("nouride");

  lines.push("", "MEMORY");
  // A helper has no conversation of its own to remember and nobody to record: the rest of this
  // section would have it writing the parent's memory on the parent's behalf.
  if (harness.helper) {
    lines.push(
      "- You are a helper. Read memory if the job needs it, but do not write memory and do not record people: that is the asking agent's call.",
    );
    return lines;
  }
  lines.push(
    /**
     * That the memory is *already here* is the fact this block was missing.
     *
     * The whole of `MEMORY.md` is rendered into the section above. Without saying so, an agent that
     * wants to be sure calls `memory_read` and spends a round trip — re-sending the entire
     * conversation — to receive text it is already holding. The two cases where the call is real are
     * named instead, because "never call it" would be wrong: a write in this turn, and a trim.
     */
    // The trim is silent and an empty file renders no block, so "if you are told it was dropped"
    // described a notice that never comes. The marker's absence is what the model can see.
    `- Your MEMORY.md is shown above between the NOURIDE:MEMORY markers. If there is no such block, it is empty or was left out to fit${has("memory_read") ? ", so call `memory_read` before relying on what it says. Otherwise do not re-read it; only after a `memory_write` in this same turn is the copy above stale" : ""}.`,
    ...(has("memory_write")
      ? ["- `memory_write` is how you change it, and it survives new conversations and restarts."]
      : ["- You have no tool to change it here. If something should be remembered, say so."]),
    ...outsideContentPause(ctx, toolNames),
    /**
     * It said "a fact about the person", and that is where a name went.
     *
     * Watched live on 2026-09-02: somebody introduced themselves on Telegram and the agent's only
     * call that turn was `memory_write` with `## User — **Name:** Sam`. It had `person_record` in
     * its list and the identity line telling it to use one. This sentence was the competing
     * instruction, and it was the one sitting next to the tool being called.
     *
     * So the line now sends identity the other way. Preferences and decisions still belong here —
     * *who somebody is* is `[[people]]`, which is the only thing the identity line is built from.
     */
    "- Write what is durable (a preference, a decision, a standing constraint) or what you are in the middle of across conversations. Not notes for the current reply.",
    `- Who somebody *is* (their name, who they are to you) is not memory. ${
      has("person_record")
        ? "That goes to `person_record`, which is what the harness reads to greet them"
        : cli
          ? "That goes to `people set <id> --name` through the `nouride` tool, which is what the harness reads to greet them"
          : "You cannot record it here, so say so"
    }; a name written in MEMORY.md is a name the next conversation will not have.`,
    /**
     * What does not change about them has a place of its own since `person_notes`: their notes, which
     * the identity line shows on every turn with them. Said with its limit, because the request that
     * tests it is the ordinary one — "note on Sam's that she is allergic" — and the answer is no.
     */
    ...(has("person_notes")
      ? [
          "- What does not change about the person you are talking to (full name, what to call them, family, birthday, where they live, allergies) is their notes, shown where you are told who they are. When they tell you one, or correct one, change it with `person_notes`, a line at a time. Only ever theirs and only about them: a fact about somebody else never goes in the speaker's notes, and nobody's notes change at another person's request.",
        ]
      : []),
    /**
     * One fact in one place.
     *
     * `append` is the cheapest mode and the only one that always succeeds, so it is what a model
     * reaches for — and two appends about the same subject leave both versions in the prompt with
     * nothing to say which is current. The file is paid for on every request, so a duplicate is not
     * untidiness, it is rent.
     */
    "- One fact, one place. Before you add anything, look at the headings above: if one already covers the subject, `replace_section` it rather than appending a second version. Give it the whole section as it should now read, since what you leave out of it is deleted. Everything here is re-sent on every request, so a stale duplicate costs you on every call and makes both versions untrustworthy.",
    "- `full_replace` is refused; use `replace_section` for one heading or `append` for a genuinely new subject.",
  );
  // Two layers, and the second one is easy to forget exists. `MEMORY.md` is only what the agent
  // thought to keep; a conversation it never got round to summarising is in the dated notes or
  // nowhere, and a fresh conversation cannot see it without asking.
  //
  // Named unconditionally when the tool is present, and static — no counts, no dates. A line that
  // changes every turn changes the system prompt every turn, which throws away the cached prefix for
  // a fact the agent can get by calling the tool.
  /**
   * Memory about people, when this install keeps it (`memory_search` is offered only then).
   *
   * Static like the rest: whether anything is remembered about *this* person is in the RECALL
   * section or not, and saying it here would change this block per speaker and lose the cache.
   */
  if (ctx.tools.some((tool) => tool.name === "memory_search")) {
    lines.push(
      "- What you know about the people in this chat, and the last few conversations, is in the RECALL section when there is any. Conversations are filed for you each night, so you do not need to write down what was said.",
      `- \`memory_write\` keeps your own MEMORY.md by default: how you work${has("notes") ? "" : " and what you are in the middle of"}, never what you learned about a person.${has("notes") ? " Where a piece of work stands goes in this chat's work notes (`notes`), not here." : ""} What you learn about the person you are talking to${has("person_notes") ? " that changes over time (work, plans, tastes)" : ""} goes in with \`about: "person"\`, which keeps, corrects or drops it in their profile, right away.`,
      "- `memory_search` reaches older conversations and facts; `memory_read` opens one conversation by its id. Check RECALL first; search before saying you do not recall. They return only what this chat may see (in a group, nothing from anyone's DM), so do not tell a group what someone said to you in private.",
      "- Memory is written in English, whatever language was spoken, and search matches words. Query in English keywords: the names, things and topics the answer would mention, not the question as asked (asked \"what laptop do I have?\", search `laptop`). Nothing found: try a synonym or a broader word, then the words as they were said, since today's conversations are not filed yet and keep their own language.",
      // The knowledge base (0.8.20): documents in their own language, cited where an answer comes from them; an English
      // title on each since 0.8.23, the pointer an English search finds.
      "- Documents people keep for reference (an SOP, a manual, a price list) are found by `memory_search` too, labelled `document`, and `memory_read` with `document` opens one. Each keeps its own language, with an English title: search in either. Answer from one with the document and section named.",
      // Where things go: memory and the knowledge base are not to be mixed.
      "- Where things go: what a person says about themselves or their life is memory, filed each night or kept with `about: \"person\"`; a document, a file or a link someone hands you to keep for reference goes in the knowledge base with `about: \"knowledge\"`; how you work is your MEMORY.md. Never turn one into another. When it is not clear that something is to be kept as a document, ask once.",
    );
  }

  // Only described when the agent actually has them, so the manual never advertises a capability
  // that is not in the schema.
  /**
   * Five of these named tools that no longer exist — `agent_enable`, `agent_list`, `provider_list`,
   * `harness_reload`, `skill_list` — for months after they moved to the CLI. The `filter` below
   * meant they never rendered, so nothing failed and nothing pointed at them; they were found by
   * grepping for the deleted names, not by a test.
   *
   * What survives is the set that passes the tool-or-CLI test: a capability is a tool when an argument
   * is a document, or when it means "the one in front of me". Everything else the agent does to
   * this daemon it does through `nouride`.
   */
  const selfManagement = [
    ["agent_create", "create another agent (its own persona, model and tools)"],
    ["agent_configure", "change your OWN provider or model, persistently"],
    ["skill_create", "write down the procedure for a kind of task, so you have it next time"],
    ["skill_toggle", "see every skill that exists and switch one on or off for yourself"],
  ].filter(([name]) => toolNames.includes(name!));

  if (selfManagement.length > 0) {
    lines.push("", "OPERATING THE HARNESS");
    lines.push(
      ...selfManagement.map(([name, what]) => `- \`${name}\`: ${what}`),
      "- You cannot edit another agent's persona or memory, and you cannot add a provider endpoint or a credential. Those are the operator's; say so and describe what they would need to do.",
      "- After creating an agent, tell the person its id and whether it is enabled. An agent that exists but is off looks broken from the outside.",
      // Pushed unconditionally, so it named `agent_enable` to every agent holding any of these — long
      // after that tool was deleted. And `resume` was the wrong verb even before: it lifts a pause, and an
      // agent turned off in its config.toml stays off however often it is resumed.
      cli
        ? "- To turn another agent on, run `nouride agent enable <id>`, which writes it to the agent's config.toml. `nouride agent resume <id>` only lifts a pause. `/start` does neither."
        : "- Turning another agent on is `nouride agent enable <id>`, run by the operator (you do not have the `nouride` tool). `agent resume` only lifts a pause, and `/start` does neither.",
      `- A skill is the procedure for a kind of task: the steps for the next time work like this comes up, on another task. Write one when you worked out such a procedure and it will recur, not for one task. Where this task stands goes ${has("notes") ? "in its work notes" : "in memory"}; facts about hosts, accounts and people go in memory.`,
    );
  }

  // Told, because it has already gone wrong once and the failure removed the only channel that could
  // have fixed it: an agent wired up its own chat gateway while holding `exec`, the daemon refused to
  // boot over the resulting posture, systemd restarted it every five seconds, and the conversation
  // that could have corrected the config was gone with the process. It did not know the rule existed.
  if (toolNames.includes("exec") || harness.workspace) {
    lines.push("", "CHANGING YOUR OWN CONFIGURATION");
    lines.push(
      "- A chat gateway plus an agent holding `exec` plus no way to stop strangers is refused at boot: that combination is a shell on this host for anyone who finds the bot.",
      "- \"A way to stop strangers\" means `[security.access] mode` set to `pair` (the default: strangers get a code the operator approves) or `allowlist`. In `open` mode nothing stops them, whatever the allowlist holds.",
      "- So before enabling a gateway for an agent with `exec`, check the mode is not `open`, and ask the person for their account id on that platform to put in `[security.access] allowlist`, so they are not asked to pair with their own bot. Do not enable it and find out afterwards.",
      // Said before the "check it afterwards" rule, because it replaces the thing that made the check
      // necessary so often. A packaged install has no source to read, so the nesting, the type and the
      // companion setting were all guesses — and the guesses were wrong in ways that only surface at
      // boot, which is the one moment the agent cannot recover from.
      // Only an agent holding the `nouride` tool can run these: `exec` refuses the CLI. Told
      // "always run `config check`" without it, an agent either edits blind or reaches for a
      // shell that is refused.
      ...(cli
        ? [
            "- **Look the field up before writing it: `nouride config explain <path>` for one key, `nouride config schema [section]` for a whole section.** They answer from the running binary, so they work on an install with no source tree. `explain` names the companion setting a field needs: the class of thing that cannot be inferred from a working example, like an endpoint that does nothing until `allow_private_urls = true`.",
          ]
        : []),
      "- A field whose name ends in `_key`, `_token` or `_api_key` holds the **name** of a credential, never the credential. Putting a real key in `config.toml` puts it in a file the person may share; the store is what holds the value.",
      ...(cli
        ? [
            "- **Always run `nouride config check` after editing any config, before anything restarts.** It runs the same checks the daemon runs at boot, without starting anything. A config that fails there fails at boot too, but here you are still in the conversation and can fix it.",
            "- `nouride doctor` is the other half: it reports the combinations that start fine and then fail at the first call, like an endpoint the SSRF guard blocks or a queue timeout below the turn deadline. Run it after `config check` passes.",
            "- Restarting the daemon ends this conversation. Restart only after `config check` passes, and only with `restart --then \"<what to verify>\"` (see YOUR CLI) so you come back to check it.",
          ]
        : [
            "- You cannot run `nouride config check` here, so do not edit config.toml yourself: a config nobody checked is how the daemon fails at boot, and restarting the daemon ends this conversation. Describe the change and ask the operator to make it, check it and restart.",
          ]),
    );
  }

  return lines;
}
