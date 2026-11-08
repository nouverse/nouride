/**
 * The `/` menu over the composer.
 *
 * Slash commands have always worked in this chat — they are hooks, the local gateway carries them
 * like any other, and the daemon answers without a model call. What was missing is that nothing here
 * ever said so, so the whole set was discoverable only by knowing it already, or by typing `/help`
 * and reading a reply. Telegram has had this menu since the day the registry existed; the dashboard
 * is where the commands are most useful and was the one place they were invisible.
 *
 * Deliberately not a `Combobox`: that one owns an input and answers with a value. This is a hint over
 * a textarea somebody is writing a message in — it opens only while the first word is being typed,
 * highlights nothing until an arrow key asks it to, and never swallows the Enter that sends a
 * command already typed in full.
 */

import type { SlashCommand } from "@/commons/lib/api";

export interface SlashMenuProps {
  commands: SlashCommand[];
  /** Which row is highlighted; -1 for none, which is where it starts. */
  active: number;
  onPick: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

/**
 * The commands a half-typed token could still become.
 *
 * Matched on the description too, so `/appr` and `approve` both find `/approvals` — the name of a
 * command is not always the word somebody reaches for.
 */
export function matchCommands(commands: SlashCommand[], token: string): SlashCommand[] {
  const query = token.replace(/^\//, "").toLowerCase();
  if (!query) return commands;
  const starts = commands.filter((entry) => entry.command.slice(1).toLowerCase().startsWith(query));
  const rest = commands.filter(
    (entry) =>
      !starts.includes(entry) &&
      (entry.command.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query)),
  );
  return [...starts, ...rest];
}

/** Whether what is typed is still the command word — `/new` yes, `/model gpt-4o` no. */
export function slashToken(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? `/${match[1] ?? ""}` : null;
}

/**
 * What the composer holds after a command is chosen: the command, then whatever was already typed.
 *
 * A command has to be the first word of the message — the daemon parses `/model gpt-5.6-luna` and
 * nothing else — so picking one cannot be an insertion at the caret. Replacing the box outright was
 * the other option and it silently ate anything half-written; this keeps it as the argument, so
 * typing `gpt-5.6-luna` and then reaching for `/model` does the obvious thing, and an existing
 * command word is swapped rather than stacked.
 */
export function applyCommand(text: string, command: string): string {
  const typed = text.trim();
  const rest = typed.startsWith("/") ? typed.replace(/^\/\S*\s*/, "") : typed;
  // The trailing space when there is no argument: every command that takes one is then a keystroke
  // from it, and the ones that do not are unharmed — the daemon trims.
  return rest ? `${command} ${rest}` : `${command} `;
}

export function SlashMenu({ commands, active, onPick, onHover }: SlashMenuProps) {
  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-2 z-40">
      <ul className="bg-base-100 border border-base-content/10 max-h-72 list-none overflow-y-auto rounded-2xl p-1.5 shadow-xl space-y-0.5">
        <li className="menu-title text-[10px] uppercase font-bold text-base-content/65 px-2.5 py-1 font-mono">
          Commands · answered by Nouride itself, with no AI call
        </li>
        {commands.map((entry, index) => (
          <li key={entry.command}>
            <button
              type="button"
              className={`flex w-full items-baseline gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                index === active ? "bg-primary/10" : "hover:bg-base-200"
              }`}
              // Keeps the caret in the textarea: a mousedown that moved focus would close this menu
              // before the click that opened it landed.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(index)}
              onClick={() => onPick(entry)}
            >
              <span
                className={`font-mono text-xs font-semibold shrink-0 ${
                  index === active ? "text-primary" : "text-base-content/85"
                }`}
              >
                {entry.command}
              </span>
              <span className="text-[11px] text-base-content/65 truncate">{entry.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
