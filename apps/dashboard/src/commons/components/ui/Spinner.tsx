/**
 * Something is on its way. `Spinner` sits inside a button or a chip, in place of its icon, while that one thing is being
 * done; `ListLoading` stands where a list will be while it loads — so a click or a tab never looks like nothing happened.
 */

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`loading loading-spinner loading-xs ${className}`} aria-label="loading" />;
}

export function ListLoading() {
  return (
    <div className="flex justify-center py-10" aria-busy="true">
      <span className="loading loading-spinner loading-md text-primary opacity-60" aria-label="loading" />
    </div>
  );
}
