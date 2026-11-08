import { clip, plural } from "@nouride/shared";
import type {
  DraftListResponse,
  SkillCatalogResponse,
  SkillsByAgentResponse,
} from "@/cli/wire.ts";
import { approvedSentence, draftVerb } from "@/modules/reflection/moves.ts";
import type { SkillDraft } from "@/modules/reflection/types.ts";
import { BOLD, CYAN, DIM, GREEN, RED, RESET, fail, say, usageError, usageLines, YELLOW } from "@/cli/ui.ts";
import type { Client } from "@/cli/client.ts";
import { saidSaved } from "@/cli/saved.ts";
import { flagValue, hasFlag } from "@/cli/args.ts";

/**
 * `nouride skills` — what an agent is offered, what exists, and who has it.
 *
 * Three views because there are three questions. The default is per agent ("what does this one
 * know"). `--all` is the pool ("who has this skill, and does this host have what it needs") — the
 * view that matters now that every skill is shared by default and each agent only holds a switch.
 * `on` / `off` flips one switch without opening the dashboard, which is the whole reason the CLI
 * exists on a box reached over SSH.
 *
 * The last-used column is the half that changes decisions. A skill costs one line of the system
 * prompt on every single turn; twenty that nobody has ever opened is a budget nobody chose to spend.
 */
export async function skills(client: Client, args: string[]): Promise<void> {
  // The words, without the flags or `--source`'s value.
  const positional = args.filter((a, at) => !a.startsWith("-") && args[at - 1] !== "--source");

  if (positional[0] === "on" || positional[0] === "off") {
    return await toggle(client, positional[0] === "on", positional.slice(1));
  }
  // The RSI queue. A separate verb rather than a flag on the listing, because these are not skills
  // yet — they are proposals, and mixing them into the pool view would show the operator something
  // no agent has.
  if (positional[0] === "drafts") return await draftList(client);
  if (positional[0] === "draft") return await draftShow(client, positional[1]);
  if (positional[0] === "approve" || positional[0] === "deny") {
    return await decide(client, positional[0], positional[1]);
  }
  // The weekly review, now: what it proposes lands in `drafts`.
  if (positional[0] === "review") return await review(client);
  // Skills from elsewhere. `install` raises drafts — they land in `drafts`, decided the same way.
  if (positional[0] === "search") return await hubSearch(client, positional.slice(1).join(" "), args);
  if (positional[0] === "install") return await hubInstall(client, positional[1]);
  if (hasFlag(args, "--all")) return await catalog(client, args);

  const agent = positional[0];
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const { agents } = await client.get<SkillsByAgentResponse>(`/skills${query}`);
  if (!agents || agents.length === 0) return say(`${DIM}no agents${RESET}`);

  const SCOPE_MARK: Record<string, string> = {
    shared: `${CYAN}shared${RESET}`,
    builtin: `${DIM}builtin${RESET}`,
    project: `${YELLOW}project${RESET}`,
  };

  for (const entry of agents) {
    say(`${BOLD}${entry.agentId}${RESET} ${DIM}${entry.skills.length} skills${RESET}`);
    if (entry.skills.length === 0) {
      say(`  ${DIM}none: every skill in agents/skills/ is switched off for this agent${RESET}`);
      say();
      continue;
    }

    let unused = 0;
    for (const skill of entry.skills) {
      const used = skill.lastUsedAt
        ? new Date(skill.lastUsedAt).toISOString().slice(0, 10)
        : `${DIM}none on record${RESET}`;
      if (!skill.lastUsedAt) unused += 1;
      say(`  ${SCOPE_MARK[skill.scope] ?? skill.scope}  ${BOLD}${skill.name}${RESET}  ${DIM}last read ${used}${RESET}`);
      // Said on the agent's own view too, not only in `--all`: a skill whose `dot` is missing will
      // fail halfway through a task, and the operator reading this list is the person who can fix it.
      if (skill.missing?.length > 0) {
        say(`       ${RED}missing:${RESET} ${skill.missing.join(", ")}`);
      }
      // The tool axis. Per agent, so it belongs on the agent's own view rather than only in `--all`.
      if (skill.missingTools?.length > 0) {
        say(`       ${RED}no tool:${RESET} ${skill.missingTools.join(", ")} (this agent will fail partway through)`);
      }
      // Not a gap to fill (0.8.13): no coding CLI is given these, and its CLI is not given the skill.
      if ((skill.notForCli?.length ?? 0) > 0) {
        say(`       ${DIM}not its CLI's: needs ${skill.notForCli!.join(", ")}, which no coding CLI is given${RESET}`);
      }
      if (hasFlag(args, "-v")) say(`       ${DIM}${skill.description || "(no description)"}${RESET}`);
      if (hasFlag(args, "-v")) say(`       ${DIM}${skill.path}${RESET}`);
    }

    // Said as a number rather than left to be counted: the whole point of the column is the total.
    if (unused > 0) {
      say(
        // "No read on record", not "never read": reads before 0.7.27 are known only as far as the audit log kept them.
        `  ${DIM}${unused} of ${entry.skills.length} with no read on record, and each costs a line of every prompt${RESET}`,
      );
    }
    say();
  }

  say(`${DIM}nouride skills [agent] [-v] | --all | on|off <skill> <agent>${RESET}`);
  say(`${DIM}nouride skills drafts | draft <id> | approve <id> | deny <id>${RESET}`);
  say(`${DIM}nouride skills search <query> | install <source>${RESET}`);
}

interface HubSearchResponse {
  hits: { ref: string; source: string; name: string; description: string; url: string; installs?: number; stars?: number }[];
  errors: { source: string; error: string }[];
}

interface HubInstallResponse {
  ok: boolean;
  error?: string;
  drafts?: { id: string; name: string; description: string; source: string; notes: string[]; warnings: string[] }[];
  refused?: { name: string; reason: string }[];
  notes?: string[];
}

/** `nouride skills search <query> [--source=skills.sh,clawhub]` — every hub at once. */
async function hubSearch(client: Client, query: string, args: string[]): Promise<void> {
  if (!query.trim()) usageLines("nouride skills search <query> [--source skills.sh,clawhub,well-known]");
  // `--source=x` arrives as `--source x` (`normalizeArgv`), so it is read as a flag with a value: looking for the `=`
  // spelling found nothing, and the hub list went into the query as a word.
  const source = flagValue(args, "--source");
  const params = new URLSearchParams({ q: query, ...(source ? { source } : {}) });
  const { hits, errors } = await client.get<HubSearchResponse>(`/skills/hub/search?${params}`);
  if (hits.length === 0) say(`${DIM}nothing found for "${query}"${RESET}`);
  for (const hit of hits) {
    const count = hit.installs !== undefined ? ` ${DIM}${hit.installs.toLocaleString("en-US")} installs${RESET}` : "";
    say(`${BOLD}${hit.name}${RESET} ${DIM}[${hit.source}]${RESET}${count}`);
    if (hit.description) say(`  ${clip(hit.description, 140)}`);
    say(`  ${CYAN}nouride skills install ${hit.ref}${RESET}`);
  }
  for (const failure of errors) say(`${YELLOW}${failure.source}:${RESET} ${failure.error}`);
}

/** `nouride skills install <source>` — fetched, adjusted, and put in front of you as drafts. */
async function hubInstall(client: Client, ref: string | undefined): Promise<void> {
  if (!ref) {
    usageLines("nouride skills install <owner/repo[/path] | github URL | skills.sh:owner/repo/skill | clawhub:slug | well-known:https://site>");
  }
  say(`${DIM}fetching ${ref}…${RESET}`);
  // From an agent's turn (the `nouride` tool sets these), the install is the agent's: it is credited
  // to it, held to the agents' pending cap, and announced in the conversation that asked for it.
  const agentId = process.env.NOURIDE_AGENT_ID;
  const result = await client.post<HubInstallResponse>("/skills/hub/install", {
    ref,
    ...(agentId
      ? { agentId, gatewayId: process.env.NOURIDE_GATEWAY_ID ?? "", chatId: process.env.NOURIDE_CHAT_ID ?? "" }
      : {}),
  });
  if (result.error) fail(result.error);
  for (const draft of result.drafts ?? []) {
    say(`${GREEN}✓${RESET} ${BOLD}${draft.name}${RESET}${DIM}, waiting for approval (${draft.id})${RESET}`);
    say(`  ${DIM}${draft.source}${RESET}`);
    for (const line of [...draft.warnings, ...draft.notes]) say(`  ${YELLOW}·${RESET} ${line}`);
  }
  for (const refused of result.refused ?? []) say(`${RED}✗${RESET} ${refused.name}: ${refused.reason}`);
  for (const note of result.notes ?? []) say(`${DIM}${note}${RESET}`);
  if (result.drafts?.length) {
    say();
    say(`${DIM}Nothing is installed until you approve: nouride skills draft <id> · approve <id> · deny <id>${RESET}`);
  }
}

/** The pool: every skill, who has it switched on, and what the host is missing. */
async function catalog(client: Client, args: string[]): Promise<void> {
  const { skills: entries, software, poolDir } =
    await client.get<SkillCatalogResponse>("/skills/catalog");

  say(`${BOLD}skill pool${RESET} ${DIM}${poolDir}${RESET}`);
  if (!entries || entries.length === 0) {
    say(`  ${DIM}empty: an agent writes the first one with skill_create${RESET}`);
    return;
  }

  for (const skill of entries) {
    const on = skill.agents.filter((a: { enabled: boolean }) => a.enabled).map((a: { id: string }) => a.id);
    const off = skill.agents.filter((a: { enabled: boolean }) => !a.enabled).map((a: { id: string }) => a.id);
    const badge = skill.scope === "builtin" ? ` ${DIM}(builtin)${RESET}` : "";

    say(`  ${BOLD}${skill.name}${RESET}${badge}  ${DIM}${skill.description || "(no description)"}${RESET}`);
    say(
      `      ${on.length > 0 ? `${GREEN}on:${RESET} ${on.join(", ")}` : `${DIM}on: nobody${RESET}`}${
        off.length > 0 ? `   ${DIM}off: ${off.join(", ")}${RESET}` : ""
      }`,
    );
    if (skill.missing?.length > 0) say(`      ${RED}needs:${RESET} ${skill.missing.join(", ")} ${DIM}(not installed)${RESET}`);
    else if (skill.requires?.length > 0) say(`      ${DIM}needs: ${skill.requires.join(", ")} ✓${RESET}`);
    if (skill.needsTools?.length > 0) {
      const short = skill.agents.filter((a: { enabled: boolean; missingTools: string[] }) => a.enabled && a.missingTools.length > 0);
      say(
        short.length > 0
          ? `      ${RED}tools:${RESET} ${skill.needsTools.join(", ")} ${DIM}(missing for ${short.map((a: { id: string }) => a.id).join(", ")})${RESET}`
          : `      ${DIM}tools: ${skill.needsTools.join(", ")} ✓${RESET}`,
      );
    }
    if (hasFlag(args, "-v")) say(`      ${DIM}${skill.path}${RESET}`);
  }

  const absent = (software ?? []).filter((s: { present: boolean }) => !s.present);
  say();
  if (absent.length > 0) {
    say(`${RED}not installed on this host:${RESET} ${absent.map((s: { name: string }) => s.name).join(", ")}`);
  } else if ((software ?? []).length > 0) {
    say(`${GREEN}every program these skills ask for is installed${RESET}`);
  }
}

/** `nouride skills on <skill> <agent>` — one switch, one agent. */
async function toggle(client: Client, enabled: boolean, rest: string[]): Promise<void> {
  const [name, agent] = rest;
  if (!name || !agent) {
    // Both required, and the agent is not defaulted. A toggle that guessed which agent it meant
    // would be a switch flipped on somebody else's prompt.
    usageLines(`nouride skills ${enabled ? "on" : "off"} <skill> <agent>`);
  }

  const answer = await client.post<{ restartRequired?: boolean }>(`/skills/${encodeURIComponent(name)}/agents/${encodeURIComponent(agent)}`, { enabled });
  saidSaved(`${BOLD}${name}${RESET} is now ${enabled ? "on" : "off"} for ${BOLD}${agent}${RESET}`, answer);
}

/** The weekly review of the library, run now — `reflection/curator.ts` on the daemon. */
async function review(client: Client): Promise<void> {
  const report = await client.post<{ tighten: string[]; merge: { into: string; retire: string[] }[]; archive: string[]; declined: { skill: string; reason: string }[] }>("/skills/review", {});
  const proposals = report.tighten.length + report.merge.length + report.archive.length;
  if (proposals === 0 && report.declined.length === 0) return say(`${GREEN}✓${RESET} the library needs nothing this week`);
  for (const name of report.tighten) say(`  tighten  ${name}`);
  for (const group of report.merge) say(`  merge    ${group.retire.join(", ")} → ${group.into}`);
  for (const name of report.archive) say(`  archive  ${name}`);
  for (const declined of report.declined) say(`${DIM}  declined ${declined.skill}: ${declined.reason}${RESET}`);
  say(`${GREEN}✓${RESET} ${proposals} proposal(s) waiting: ${BOLD}nouride skills drafts${RESET}`);
}

/**
 * `nouride skills drafts` — what the agents have proposed and nobody has decided.
 *
 * Says the age and says that nothing expires, because "do I have to deal with this tonight" is the
 * question an operator has when they see a queue, and the answer here is no.
 */
async function draftList(client: Client): Promise<void> {
  const { enabled, pending, recent } = await client.get<DraftListResponse>("/skills/drafts");

  if (enabled === false) {
    return say(`${DIM}skill learning is off: set [skills.learning] mode = "ask" to turn it on${RESET}`);
  }

  if (!pending || pending.length === 0) {
    say(`${DIM}no skill drafts are waiting${RESET}`);
  } else {
    say(`${BOLD}${pending.length} ${plural(pending.length, "draft")} waiting${RESET}`);
    for (const draft of pending) {
      const verb = draftVerb(draft);
      say(`  ${verb ? `${YELLOW}${verb}${RESET} ` : ""}${BOLD}${draft.name}${RESET}  ${DIM}${draft.description}${RESET}`);
      say(`      ${DIM}${draft.id} · ${draft.agentId} · ${new Date(draft.createdAt).toISOString().slice(0, 16).replace("T", " ")}${RESET}`);
      say(`      ${DIM}${draft.triggerReason}${RESET}`);
      if (draft.requires) say(`      ${DIM}needs: ${draft.requires}${RESET}`);
      /**
       * How many earlier lessons this draft absorbed, before the reason that came with the last one.
       *
       * Printed first because it changes what the reason below *means*. A draft reading "lxc-attach
       * needs chmod +x" may also be carrying Headlamp and a macOS cleanup, and without this line the
       * operator approves three changes having read one.
       */
      if (draft.carries?.length > 0) {
        const n = draft.carries.length;
        say(`      ${YELLOW}also carries ${n} earlier ${plural(n, "lesson")}:${RESET}`);
        for (const lesson of draft.carries) say(`        ${DIM}· ${lesson}${RESET}`);
      }
      if (draft.files?.length > 0) {
        say(`      ${DIM}+ ${draft.files.map((f: { path: string }) => f.path).join(", ")}${RESET}`);
      }
    }
    say();
    say(`${DIM}nouride skills draft <id>  ·  approve <id>  ·  deny <id>${RESET}`);
  }

  const decided = (recent ?? []).slice(0, 5);
  if (decided.length > 0) {
    say();
    say(`${DIM}recently decided${RESET}`);
    for (const draft of decided) {
      const mark = draft.status === "approved" ? `${GREEN}approved${RESET}` : `${DIM}discarded${RESET}`;
      say(`  ${mark}  ${draft.name} ${DIM}by ${draft.decidedBy ?? "?"}${RESET}`);
    }
  }
}

/** One draft in full, transcript included — the terminal's Origin Trajectory Inspector. */
async function draftShow(client: Client, id: string | undefined): Promise<void> {
  if (!id) usageError(`usage: nouride skills draft <id>`);

  const draft = await client.get<SkillDraft>(`/skills/drafts/${encodeURIComponent(id)}`);
  say(`${BOLD}${draft.name}${RESET}  ${DIM}${draft.status}${RESET}${draft.target ? `  ${YELLOW}improves ${draft.target}${RESET}` : ""}`);
  say(`${DIM}${draft.description}${RESET}`);
  if (draft.requires) say(`${DIM}needs: ${draft.requires}${RESET}`);
  say(`${DIM}drafted by ${draft.agentId} · ${draft.triggerReason} · model ${draft.model ?? "?"}${RESET}`);
  // The full view shows every absorbed lesson, not a count: this is the screen somebody reads before
  // approving, and the body below is the sum of all of them.
  if (draft.carries?.length > 0) {
    say(`${YELLOW}This draft also carries ${draft.carries.length} earlier lesson(s):${RESET}`);
    for (const lesson of draft.carries) say(`${DIM}  · ${lesson}${RESET}`);
  }
  say();
  say(draft.body);
  for (const file of draft.files ?? []) {
    say();
    say(`${DIM}── ${file.path} ──${RESET}`);
    say(file.content);
  }
  if (draft.transcript) {
    say();
    say(`${DIM}── origin transcript (credentials masked) ──${RESET}`);
    say(`${DIM}${draft.transcript}${RESET}`);
  }
  say();
  if (draft.status === "pending") {
    say(`${DIM}nouride skills approve ${draft.id}  ·  nouride skills deny ${draft.id}${RESET}`);
  }
}

/**
 * Approve or discard, by id or by skill name.
 *
 * The name is accepted because the id is unmemorable and the operator is usually looking at a chat
 * message that named the skill. Ambiguity is refused by the daemon rather than guessed at here.
 */
async function decide(client: Client, verb: "approve" | "deny", reference: string | undefined): Promise<void> {
  if (!reference) usageError(`usage: nouride skills ${verb} <id|name>`);

  const { enabled, pending } = await client.get<DraftListResponse>("/skills/drafts");
  if (enabled === false) fail("skill learning is off, so there are no drafts to decide", 'Set [skills.learning] mode = "ask" to turn it on.');

  const list: SkillDraft[] = pending ?? [];
  const byId = list.find((draft) => draft.id === reference);
  const byName = list.filter((draft) => draft.name === reference);
  const target = byId ?? (byName.length === 1 ? byName[0] : undefined);

  if (!target) {
    fail(byName.length > 1 ? `more than one pending draft is called "${reference}": use the id` : `no pending draft "${reference}"`, "nouride skills drafts lists them");
  }

  // `approve` answers with the pooled skill's name and where it landed; `deny` answers `{ ok }`
  // and the CLI prints the name it already had.
  const result = await client.post<{ ok: boolean; skill?: string; path?: string }>(
    `/skills/drafts/${encodeURIComponent(target.id)}/${verb}`,
    {},
  );
  if (verb === "approve") {
    say(`${GREEN}✓${RESET} ${BOLD}${target.name}${RESET} ${approvedSentence(target)}`);
    if (result.path) say(`${DIM}${result.path}${RESET}`);
  } else {
    say(`${GREEN}✓${RESET} discarded ${BOLD}${target.name}${RESET}${DIM}: the draft and its transcript are gone${RESET}`);
  }
}
