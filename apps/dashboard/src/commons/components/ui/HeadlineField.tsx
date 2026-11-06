/**
 * An agent's headline: one short line saying what it is for — what its peers read to decide whom to ask, and what the
 * Agents list shows (0.7.18). Not its system prompt: a sentence, capped where the daemon caps it.
 */

/** As `HEADLINE_MAX` in the engine's `setup/identity-headline.ts`. */
const HEADLINE_MAX = 150;

export function HeadlineField({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  /** What it will be if left empty: the preset's headline. */
  placeholder?: string;
  id?: string;
}) {
  return (
    <div className="space-y-1">
      <input
        {...(id ? { id } : {})}
        className="input w-full rounded-xl text-sm"
        value={value}
        maxLength={HEADLINE_MAX}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value.replace(/\s*\n\s*/g, " "))}
        aria-describedby={id ? `${id}-hint` : undefined}
      />
      <p {...(id ? { id: `${id}-hint` } : {})} className="flex justify-between gap-3 text-xs text-base-content/65">
        <span>One short line: what to bring this agent. Other agents read it to decide whom to ask; it is not its personality.</span>
        <span className="shrink-0 font-mono">
          {value.length}/{HEADLINE_MAX}
        </span>
      </p>
    </div>
  );
}
