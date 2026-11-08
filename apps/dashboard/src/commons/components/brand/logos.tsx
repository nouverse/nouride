import { useId } from "react";
/**
 * The Nougate mark — the LLM gateway a Router build carries, on its LLM Gateway page and in setup.
 *
 * A gateway seen head-on: two arches drawn with the Nouverse "n" stroke, one inside the other, and
 * the nou mark's planet passing through. The same picture as nougate's own `favicon.svg` and
 * `internals/nougate/apps/frontend/src/components/brand/NougateMark.tsx`, which explain why it has
 * exactly these three elements; change one, change all three.
 *
 * Carries its own background, like the cat beside it, so it reads the same on both themes. The
 * gradient id is per instance: two marks on one page would otherwise both paint from the first.
 */
export function NougateMark({ className = "size-8" }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="Nougate">
      <defs>
        <linearGradient id={gradient} x1="6" y1="2" x2="42" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2EE6B0" />
          <stop offset=".5" stopColor="#0BAF90" />
          <stop offset="1" stopColor="#4338CA" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="11.5" fill={`url(#${gradient})`} />
      <rect x=".75" y=".75" width="46.5" height="46.5" rx="10.75" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth="1.5" />
      <path d="M11 36.5V22a13 13 0 0 1 26 0v14.5" fill="none" stroke="#fff" strokeOpacity=".42" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M17 36.5V24.5a7 7 0 0 1 14 0v12" fill="none" stroke="#fff" strokeWidth="4.2" strokeLinecap="round" />
      <circle cx="24" cy="30.8" r="3.2" fill="#fff" />
    </svg>
  );
}

/**
 * The same mark as a line glyph in the current colour, for a row among Lucide icons — the sidebar,
 * an empty state. Drawn larger in its box than the tile's glyph, because there is no tile around it,
 * and taking `size` like a Lucide icon so it drops into the same slots.
 */
export function NougateGlyph({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      <path d="M5 42.5V23a19 19 0 0 1 38 0v19.5" strokeOpacity=".45" strokeWidth="4" />
      <path d="M13.5 42.5V25.5a10.5 10.5 0 0 1 21 0v17" strokeWidth="5.2" />
      <circle cx="24" cy="34" r="4.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
