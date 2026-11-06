/**
 * What a new agent starts as: its tools, and a few lines on how it works.
 *
 * Chosen once, on the dashboard's New Agent form, and not kept: the pack it writes is an ordinary one,
 * and every tool can be switched afterwards on the agent's Settings tab. A preset stored beside the list
 * would be a second answer to "what may this agent do", and the two would drift.
 *
 * Approvals are not part of a preset: every agent is created with `[agent] approvals = "balanced"` —
 * nothing asks except what is destructive, touches the system, infrastructure or credentials — so
 * "full access" and "asks only before risky actions" are the same agent. Set on the agent rather than
 * left to follow each person, so it is one answer for everyone who talks to it.
 *
 * The first agent, from the setup wizard, is always `pilot`.
 *
 * Pure.
 */

const PRESET_IDS = ["pilot", "researcher", "assistant", "developer", "custom"] as const;

/**
 * The first agent's id and name when the person setting up gives none: a Pilot, named for it (the owner, 2026-11-06).
 * The dashboard's wizard fills its form with the same two.
 */
export const FIRST_AGENT = { id: "nouridepilot", name: "NouridePilot" } as const;
export type PresetId = (typeof PRESET_IDS)[number];

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

export interface AgentPreset {
  id: PresetId;
  label: string;
  /** One line, for the card that offers it. */
  summary: string;
  /** What it is for, said to its peers (`identity-headline.ts`) when the person creating it writes no headline. */
  headline: string;
  /** Its tools, or `all` of what this daemon has. `custom` names none: the person picks them. */
  tools: "all" | readonly string[];
  /** Written into `AGENTS.md`, under the starter procedure. Empty for `custom`. */
  guidance: string;
  /**
   * A starting SOUL.md: its personality and how it talks. The New Agent form fills it in, editable, so nobody has to
   * write one to make an agent; written when the form sends none.
   */
  soul: string;
}

const MEMORY = ["memory_read", "memory_write", "memory_search", "memory_analyze", "person_record", "person_notes"];

export const PRESETS: readonly AgentPreset[] = [
  {
    id: "pilot",
    label: "Pilot",
    summary: "Full access: files, terminal, web and the daemon itself. Asks before anything risky.",
    headline: "Takes a task to the end: files, terminal, web and this daemon",
    tools: "all",
    guidance:
      "You can work across files, the terminal, the web and this daemon. Take a task to the end: chain the steps you already know into one command, and report briefly what you did and what is left. Ask before anything destructive or hard to undo.",
    soul: "You are a capable, calm operator. You take a task from the first step to the last and say plainly what you did.\n\n- Be brief: lead with the result, then what is left.\n- Prefer doing over asking, but ask before anything destructive or hard to undo.\n- When you are unsure, check (read the file, run the command) rather than guess.\n- Answer in the language you are spoken to in.",
  },
  {
    id: "researcher",
    label: "Researcher",
    summary: "Searches and reads the web, and reads files. No terminal, writes nothing.",
    headline: "Research: searches the web and reads sources, with links; writes nothing",
    tools: ["read", "glob", "grep", "plan", "web_search", "web_fetch", ...MEMORY, "send_file", "session_status"],
    guidance:
      "You research. Check more than one source, say where each claim comes from with its link, and keep what you verified apart from what you infer. You have no terminal and write no files: when a task needs either, say so rather than work around it.",
    soul: "You are a careful researcher. You find out what is true and show where you found it.\n\n- Check more than one source and give each claim its link.\n- Keep what you verified apart from what you infer, and say how sure you are.\n- Summarise first, then the detail for whoever wants it.\n- Answer in the language you are spoken to in.",
  },
  {
    id: "assistant",
    label: "Assistant",
    summary: "Everyday help: remembers what matters, sets reminders, looks things up.",
    headline: "Everyday help: reminders, plans, remembering things, looking things up",
    tools: ["plan", "web_search", "web_fetch", ...MEMORY, "send_file", "session_status", "nouride"],
    guidance:
      "You are a personal assistant for everyday life. Be warm and brief. Remember the small things people tell you (preferences, plans, dates) and offer a reminder when a date comes up. You have no terminal: for anything technical, say what would be needed.",
    soul: "You are a warm, practical personal assistant. You make everyday life a little easier.\n\n- Be friendly and brief.\n- Remember what people tell you (preferences, plans, dates) and use it later.\n- Offer a reminder when a date or a promise comes up.\n- Answer in the language you are spoken to in.",
  },
  {
    id: "developer",
    label: "Developer",
    summary: "Code and servers: reads and edits files, runs commands and tests.",
    headline: "Code and servers: reads and changes code, runs commands and tests",
    tools: ["read", "glob", "grep", "write", "edit", "multi_edit", "exec", "session", "plan", "web_search", "web_fetch", "memory_read", "memory_write", "memory_search", "send_file", "session_status", "delegate"],
    guidance:
      "You work on code and servers. Read the code before changing it, change the smallest thing that fixes it, and run the tests or the command that proves it worked. Never guess an interface: read it. Report what you changed and how you checked.",
    soul: "You are a pragmatic software engineer. You change code carefully and prove it works.\n\n- Read the code before you change it; never guess an interface.\n- Make the smallest change that fixes the problem, then run the tests or the command that shows it.\n- Report what you changed, why, and how you checked it.\n- Answer in the language you are spoken to in.",
  },
  {
    id: "custom",
    label: "Custom",
    summary: "Pick the tools yourself.",
    headline: "Assistant",
    tools: [],
    guidance: "",
    soul: "You are a helpful, precise assistant.\n\n- Be clear and brief.\n- Say when you do not know, rather than guess.\n- Answer in the language you are spoken to in.",
  },
];

/** How the tool switches are grouped for a person. A tool in none of these is listed under Other. */
export const TOOL_GROUPS: readonly { label: string; tools: readonly string[] }[] = [
  { label: "Files", tools: ["read", "glob", "grep", "write", "edit", "multi_edit", "send_file"] },
  { label: "Terminal", tools: ["exec", "session", "secret_save"] },
  { label: "Web", tools: ["web_search", "web_fetch"] },
  { label: "Memory", tools: MEMORY },
  { label: "Planning and other agents", tools: ["plan", "delegate", "agent_create", "agent_configure"] },
  { label: "Skills and MCP", tools: ["skill_create", "skill_toggle", "skill_improve", "skill_search", "skill_install", "mcp_search"] },
  { label: "This daemon", tools: ["nouride", "session_status", "update"] },
];

export function presetOf(id: PresetId): AgentPreset {
  return PRESETS.find((preset) => preset.id === id)!;
}

/**
 * The tools a new agent gets, of those this daemon has — in the daemon's order, so the file reads the
 * same whichever preset wrote it. `custom` takes the person's own picks; a name the daemon does not
 * have is dropped rather than written as a line that does nothing.
 */
export function toolsFor(id: PresetId, available: readonly string[], chosen: readonly string[] = []): string[] {
  const preset = presetOf(id);
  if (preset.tools === "all") return [...available];
  const wanted = new Set(id === "custom" ? chosen : preset.tools);
  return available.filter((name) => wanted.has(name));
}
