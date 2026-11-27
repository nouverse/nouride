/**
 * A coding CLI built in but not yet run on a real account: said where CLIs are listed and picked, so nobody takes
 * it for one that was tried. Its start and its sign-in were seen; a turn was not.
 */

/** The label, small, beside the CLI's name. */
export function ExperimentalBadge() {
  return (
    <span className="badge badge-xs badge-warning shrink-0 font-mono font-semibold" title="Not yet tried on a real account" data-cli-experimental>
      Experimental
    </span>
  );
}

/** The same, said in a line where there is room: what it means for the person choosing it. */
export function ExperimentalNote({ name }: { name: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-base-content/65" data-cli-experimental-note>
      <ExperimentalBadge /> {name} has not yet been tried on a real account here. It may not answer, or answer only in part.
    </p>
  );
}
