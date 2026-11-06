/**
 * A mission's goal in full, under its name (0.8.0). The name is the goal's first sentence (`missionTitle`); the goal was
 * the page's title before, and a paragraph of it — a job's run, an agent's own — was a wall of large type. Here it is
 * reading size, three lines of it until opened — and the press to open it only where three lines cut it: a count of
 * characters offered it under a goal a wide window showed whole.
 */

import { useLayoutEffect, useRef, useState } from "react";

export function Goal({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const shown = text.current;
    if (!shown || open) return;
    const measure = () => setCut(shown.scrollHeight > shown.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [goal, open]);

  return (
    <div className="space-y-1">
      <p ref={text} className={`whitespace-pre-wrap text-sm leading-relaxed text-base-content/80 [overflow-wrap:anywhere] ${open ? "" : "line-clamp-3"}`}>
        {goal}
      </p>
      {(cut || open) && (
        <button type="button" className="btn btn-ghost btn-xs -ml-2 rounded-lg" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          {open ? "Show less" : "Show the whole goal"}
        </button>
      )}
    </div>
  );
}
