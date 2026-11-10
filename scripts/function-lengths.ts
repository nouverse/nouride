/**
 * The function-length check's table (`check-functions.ts`): the named functions over its cap when the rule began, by
 * file and name, each at its length in lines of code and with the one reason it stays whole, as a size budget is.
 *
 * A record may go down and may not go up without its reason rewritten; one that leaves the cap leaves the list. Most of
 * these are one of three shapes: a route table registered in one function, a factory returning one closure per
 * operation, and a dashboard component holding its page's state. Each names its seam, for the change that next grows it.
 */

import type { Budget } from "./size-budgets.ts";

/** A route registrar's reason: the same for each, as their shape is. */
const ROUTES = (what: string): string =>
  `the ${what} routes, registered together in the order Hono matches them; a resource's routes in a register function of their own is the seam`;

/** A dashboard component's reason, for the ones that are a page's or a form's state and markup together. */
const COMPONENT = (what: string): string => `${what}: its state, its handlers and its markup in one component; a part with state of its own, as a component beside it, is the seam`;

export const LONG_FUNCTIONS: Record<string, Record<string, Budget>> = {
  "apps/dashboard/src/commons/components/mcp/McpServerForm.tsx": { McpServerForm: { lines: 267, why: COMPONENT("the form that adds or edits one MCP server, by hand or from the catalog") } },
  "apps/dashboard/src/commons/components/ui/Combobox.tsx": { Combobox: { lines: 207, why: "a text field that suggests: the typed text, the filtered list, the whole list on its chevron and the keyboard over one open state, as one control every model picker uses" } },
  "apps/dashboard/src/commons/components/ui/Markdown.tsx": { Markdown: { lines: 235, why: "the markdown renderer: each block kind read in one pass over the lines, with the flushes that close a list, a quote, a table or a code block" } },
  "apps/dashboard/src/commons/components/ui/NotesModal.tsx": { NotesModal: { lines: 156, why: COMPONENT("the one dialog for notes, to read and to edit") } },
  "apps/dashboard/src/commons/hooks/use-conversation.ts": { useConversation: { lines: 294, why: "one conversation as the daemon sees it: the live feed's loop, its turns and its sends over two refs the loop and the page share" } },
  "apps/dashboard/src/modules/access/pending.tab.tsx": { PendingTab: { lines: 158, why: COMPONENT("who is waiting to be let in, and the answers to one") } },
  "apps/dashboard/src/modules/agents/components/NewAgentForm.tsx": { NewAgentForm: { lines: 200, why: COMPONENT("the form that creates an agent") } },
  "apps/dashboard/src/modules/agents/index.page.tsx": { AgentListPage: { lines: 173, why: COMPONENT("every agent and the state each is in") } },
  "apps/dashboard/src/modules/chat/components/Composer.tsx": { Composer: { lines: 174, why: COMPONENT("everything below the transcript: the box, two menus, files, send") } },
  "apps/dashboard/src/modules/chat/components/Conversation.tsx": { Conversation: { lines: 309, why: COMPONENT("one conversation: its data, two completion menus, scroll, send, people") } },
  "apps/dashboard/src/modules/integrations/index.page.tsx": { Tokens: { lines: 186, why: COMPONENT("the tokens other tools reach Nouride's MCP server with") } },
  "apps/dashboard/src/modules/login/index.page.tsx": { LoginPage: { lines: 153, why: COMPONENT("the sign-in page") } },
  "apps/dashboard/src/modules/memories/document-editor.tsx": { DocumentEditor: { lines: 185, why: COMPONENT("one knowledge document, read and edited") } },
  "apps/dashboard/src/modules/memories/graph/graph.page.tsx": { MemoryGraphPage: { lines: 190, why: COMPONENT("the memory graph page") } },
  "apps/dashboard/src/modules/memories/knowledge/collection-form.tsx": { CollectionForm: { lines: 159, why: COMPONENT("the form for a knowledge collection") } },
  "apps/dashboard/src/modules/memories/settings.tab.tsx": { SettingsTab: { lines: 194, why: COMPONENT("memory's settings") } },
  "apps/dashboard/src/modules/memories/timeline.tab.tsx": { TimelineTab: { lines: 188, why: COMPONENT("memory's timeline, its list while it loads") } },
  "apps/dashboard/src/modules/missions/mission.page.tsx": { MissionPage: { lines: 164, why: COMPONENT("one mission's page") } },
  "apps/dashboard/src/modules/missions/index.page.tsx": { MissionsPage: { lines: 151, why: COMPONENT("every mission, its filters and its empty states") } },
  "apps/dashboard/src/modules/office/index.page.tsx": { OfficePage: { lines: 159, why: COMPONENT("the Office, the agents at their desks") } },
  "apps/dashboard/src/modules/people/index.page.tsx": { PersonForm: { lines: 178, why: COMPONENT("the form for one person") } },
  "apps/dashboard/src/modules/schedule/components/JobForm.tsx": { JobForm: { lines: 238, why: COMPONENT("the form for a scheduled job") } },
  "apps/dashboard/src/modules/schedule/components/TriggerFields.tsx": { TriggerFields: { lines: 155, why: COMPONENT("a job's trigger fields, one set per kind") } },
  "apps/dashboard/src/modules/schedule/index.page.tsx": { SchedulePage: { lines: 304, why: COMPONENT("the schedule page: its title, its jobs, their runs and a job a link names") } },
  "apps/dashboard/src/modules/secrets/index.page.tsx": { SecretsPage: { lines: 164, why: COMPONENT("the secrets page, its list while it loads, empty and filled") } },
  "apps/dashboard/src/modules/setup/index.page.tsx": { KeyForm: { lines: 155, why: COMPONENT("setup's form for a provider's key") } },
  "apps/dashboard/src/modules/users/index.page.tsx": { UsersPage: { lines: 211, why: COMPONENT("the dashboard's users") } },
  "apps/dashboard/src/modules/web-search/index.page.tsx": { WebSearchPage: { lines: 172, why: COMPONENT("the web search settings: five services, and the key name each one keeps") } },
  "apps/dashboard/src/modules/webhooks/components/WebhookForm.tsx": { WebhookForm: { lines: 177, why: COMPONENT("the form for a webhook") } },
  "apps/engine/src/boot/control-plane.ts": { startControlPlane: { lines: 273, why: "boot's wiring of the control API and the dashboard: every port their routes take, built in the order they need each other" } },
  "apps/engine/src/boot/memory-pass.ts": { startMemoryPass: { lines: 154, why: "the nightly memory pass wired at boot: its clock, its model and its budget, and the run its timer starts" } },
  "apps/engine/src/boot/missions.ts": { buildMissions: { lines: 313, why: "boot's wiring of the missions: the service and every port it takes, the machine its slots follow among them, built where the stores and the turn machine are in reach" } },
  "apps/engine/src/cli/commands/chat.ts": { chat: { lines: 151, why: "the interactive chat: a line read, sent through the local gateway and its turn followed to the reply, in one loop over the terminal" } },
  "apps/engine/src/cli/commands/doctor.ts": { doctor: { lines: 256, why: "`nouride doctor`: every check that stops a fresh install from working, the config read against its secrets too, in the order its report reads them" } },
  "apps/engine/src/cli/commands/service.ts": { service: { lines: 152, why: "`nouride service`: status, diff, install and uninstall, branches of one dispatch over the supervisor and unit it finds first" } },
  "apps/engine/src/cli/main.ts": { main: { lines: 158, why: "the CLI's dispatch: one case per command, behind the flags every command shares" } },
  "apps/engine/src/cli/usage.ts": { usageText: { lines: 253, why: "the whole of `nouride help`, one template a person reads top to bottom: its lines are the help, not logic" } },
  "apps/engine/src/index.ts": { runDaemon: { lines: 183, why: "the boot order, one step after another; the stores, the timers, the turn machine, the machine's reading and each config brought forward are in `boot/`: what is left is the sequence" } },
  "apps/engine/src/modules/config/global/validate.ts": { validate: { lines: 193, why: "every refusal of the daemon's config that its schema cannot make, each naming its field, in one pass at load" } },
  "apps/engine/src/modules/config/toml-lines.ts": { readToml: { lines: 207, why: "a TOML file read as its lines in one pass: strings, arrays and inline tables tracked across lines, so editors get spans" } },
  "apps/engine/src/modules/external-agents/runner.ts": { "ExternalTurnRunner.run": { lines: 204, why: "one turn prompted to a coding CLI and read back as the executor's result, over the session and the updates the CLI streams" } },
  "apps/engine/src/modules/llm/executor/index.ts": { "TurnExecutor.run": { lines: 315, why: "the tool loop: room made, a model call, its tool calls, the next call, until the reply, over loop state every round reads; preparing and calling tools are beside it" } },
  "apps/engine/src/modules/llm/executor/prepare.ts": { prepareTurn: { lines: 165, why: "everything a turn's first model call needs, in its order: its skills, the system prompt, then the history compacted and cut to the window" } },
  "apps/engine/src/modules/llm/executor/tool-caller.ts": { "ToolCaller.attempt": { lines: 205, why: "one tool call from its checks and gate to its result: approval, the run raced against a stop, the mask and the record, in the order a call passes them" } },
  "apps/engine/src/modules/mcp-server/surface.ts": { createSurface: { lines: 175, why: "what Nouride's MCP server offers one token: each tool over the daemon's ports, held to the token's person, agents and scopes" } },
  "apps/engine/src/modules/memory/index.ts": { createMemory: { lines: 246, why: "memory's surface: one closure per operation over the stores it is built with; the operations' logic is in the files beside it" } },
  "apps/engine/src/modules/memory/knowledge/surface.ts": { createKnowledge: { lines: 231, why: "the knowledge base's surface: one closure per operation over its folder and its index" } },
  "apps/engine/src/modules/pipeline/job-turns.ts": { "JobTurns.run": { lines: 190, why: "one background job's turn, from its start to its report, over the job's row and the clock it runs under" } },
  "apps/engine/src/modules/pipeline/peer-turn.ts": { startPeerTurn: { lines: 213, why: "one peer turn as the peer, from its start to the answer handed back, with its move to the background and its clock" } },
  "apps/engine/src/modules/reflection/index.ts": { "ReflectionEngine.look": { lines: 168, why: "one reflection over a turn: what it records, the checks that hold a draft back, the skill synthesized and the draft written, in order" } },
  "apps/engine/src/modules/tools/builtins/attachment.ts": { createAttachmentReadTool: { lines: 175, why: "the `attachment_read` tool: its schema and its run over each kind of file it reads, one closure over its deps" } },
  "apps/engine/src/modules/tools/builtins/exec.ts": { createExecTool: { lines: 250, why: "the exec tool's gate and run: each check made in its order, and rechecked in `execute` in the same order" } },
  "apps/engine/src/modules/tools/builtins/harness.ts": { createAgentCreateTool: { lines: 167, why: "`agent_create`: its schema, the checks that refuse an existing or a broken pack, and the new pack written whole" } },
  "apps/engine/src/modules/tools/builtins/sessions.ts": { createSessionTool: { lines: 191, why: "the `session` tool: its schema and each action's run over the sessions it holds and what their output may show" } },
  "apps/engine/src/modules/web/control/routes/agents.ts": { registerAgentRoutes: { lines: 299, why: ROUTES("agents'") } },
  "apps/engine/src/modules/web/control/routes/auth.ts": { registerAuthRoutes: { lines: 186, why: ROUTES("sign-in") } },
  "apps/engine/src/modules/web/control/routes/chat.ts": { registerChatRoutes: { lines: 271, why: ROUTES("dashboard chat's") } },
  "apps/engine/src/modules/web/control/routes/cron.ts": { registerCronRoutes: { lines: 182, why: ROUTES("schedule's") } },
  "apps/engine/src/modules/web/control/routes/diagnostics.ts": { registerDiagnosticRoutes: { lines: 222, why: ROUTES("diagnostic") } },
  "apps/engine/src/modules/web/control/routes/external-agents.ts": { registerExternalAgentRoutes: { lines: 206, why: ROUTES("coding CLIs'") } },
  "apps/engine/src/modules/web/control/routes/knowledge.ts": { registerKnowledgeRoutes: { lines: 246, why: ROUTES("knowledge base's") } },
  "apps/engine/src/modules/web/control/routes/mcp.ts": { registerMcpRoutes: { lines: 154, why: ROUTES("MCP library's") } },
  "apps/engine/src/modules/web/control/routes/memory.ts": { registerMemoryRoutes: { lines: 176, why: ROUTES("memory") } },
  "apps/engine/src/modules/web/control/routes/missions.ts": { registerMissionRoutes: { lines: 157, why: ROUTES("missions'") } },
  "apps/engine/src/modules/web/control/routes/rooms.ts": { registerRoomRoutes: { lines: 207, why: ROUTES("rooms'") } },
  "apps/engine/src/modules/web/control/routes/skills.ts": { registerSkillRoutes: { lines: 265, why: ROUTES("skills'") } },
  "internals/pro/packages/appliance/src/core/index.ts": { createAppliance: { lines: 285, why: "the box's appliance surface (sync, claim link, setup, automatic updates): one closure per operation over its identity and licence" } },
  "internals/pro/packages/appliance/src/ui/features/wifi/WifiTab.tsx": { WifiTab: { lines: 243, why: COMPONENT("the Wi-Fi setup: a network, its password, the poll and why it failed") } },
  "packages/mcp/src/http.ts": { streamableHttpTransport: { lines: 156, why: "MCP's streamable HTTP transport: one endpoint, a JSON or event-stream answer per POST, and the session they share, in one closure" } },
  "packages/mcp/tests/fixtures/oauth-servers.ts": { oauthServers: { lines: 210, why: "a test fixture: an MCP server and the OAuth server in front of it, started together for the tests that sign in" } },
  "packages/persona/src/config.ts": { parseAgentConfig: { lines: 165, why: "a pack's `config.toml` mapped field by field, so each refusal names its file and field; its readers are helpers beside it already" } },
  "scripts/check-arch.ts": { main: { lines: 179, why: "the import rules over every file in one loop that reads each file once; a rule as a function of its own is the seam" } },
};
