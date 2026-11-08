/**
 * Every tool this daemon has, grouped, each one a switch — for a Custom agent on the New Agent form
 * and for an existing agent's tools on its Settings tab. One component, so choosing tools at creation and
 * changing them later look the same.
 */

import type { AgentPresets } from "@nouride/wire";

export function ToolPicker({
  groups,
  selected,
  disabled,
  onChange,
}: {
  groups: AgentPresets["groups"];
  selected: ReadonlySet<string>;
  disabled?: boolean;
  onChange: (next: Set<string>) => void;
}) {
  const toggle = (tool: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(tool);
    else next.delete(tool);
    onChange(next);
  };
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {groups.map((group) => (
        <fieldset key={group.label} className="space-y-1.5">
          <legend className="text-base-content/65 mb-1.5 text-[11px] font-bold uppercase tracking-wider font-mono">{group.label}</legend>
          {group.tools.map((tool) => (
            <label key={tool} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-primary checkbox-xs"
                checked={selected.has(tool)}
                disabled={disabled}
                onChange={(event) => toggle(tool, event.target.checked)}
              />
              <span className="font-mono text-xs">{tool}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
