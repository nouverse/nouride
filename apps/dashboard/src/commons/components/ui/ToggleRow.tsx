/**
 * A switch with what it does beside it — the shape the Box page's Updates card uses, so a toggle is
 * never a label with a pill stuck to its end.
 */

export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="toggle toggle-primary toggle-sm mt-0.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-base-content">{label}</span>
        {hint ? <span className="text-base-content/65 block text-xs leading-relaxed">{hint}</span> : null}
      </span>
    </label>
  );
}
