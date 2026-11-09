/**
 * The switch, shown as the server's: where the server's own settings say whether Nougate runs, the page shows which
 * way and that it is theirs, and offers nothing that would not stick. `compact` for the page's header bar, where the
 * sentence is the tooltip.
 */

const WHO = "Whoever runs the server can change it there.";

export function SetByServer({ on, compact = false }: { on: boolean; compact?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-xs text-base-content/70" title={WHO}>
      <input type="checkbox" className="toggle toggle-xs sm:toggle-sm" checked={on} disabled readOnly aria-label={on ? "Nougate is on" : "Nougate is off"} />
      <span className={compact ? "hidden sm:inline" : undefined}>
        {compact ? "Set on the server" : `${on ? "On" : "Off"}, set on the server itself. ${WHO}`}
      </span>
    </label>
  );
}
