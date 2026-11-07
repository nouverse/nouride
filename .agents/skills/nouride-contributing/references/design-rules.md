# Nouverse Design Rules

Use this as the primary visual and frontend quality standard for Nouride and Nouverse interfaces.

## Scope: which rule governs what (decided 2026-10-17, 0.7.10)

This skill governs the **look** of every Nouride surface, the dashboard (`apps/dashboard`) included:
palette, type, motion, glass, composition. `react-tailwind-daisyui` governs the **mechanics**: the
modules/commons layout, route files, component recipes, Lucide sizing, accessibility. Where the two
disagree about how something should look, this one wins; its Apple HIG section describes tactile
feedback and layering, not the brand.

The dashboard follows it since 0.7.11 (`dash-practice-design-language-divergence`), in blue since 0.7.16 —
the owner's call, 2026-10-18: the mascot is blue, so a green brand read beside it as somebody else's. The two
theme blocks in `apps/dashboard/src/styles/main.css` are these tokens in daisyUI's names: cool paper and navy
ink, the mascot's blue as `primary` (lifted on dark, deepened on paper until it reads as text), mist, soft
peach and teal as `secondary`, `accent` and `info`. Manrope and DM Mono are served from beside that stylesheet, since an
offline box reaches no font CDN; the memory graph reads its colours from the theme; a live dot's glow is
the theme's own colour. `apps/dashboard/tests/nouverse-look.test.ts` holds every pair that can carry text
to WCAG AA in both themes. Dashboard work keeps it that way:

- uses daisyUI semantic colours only (`base-*`, `primary`, `success`…), never a raw Tailwind palette
  class or hex, so a change of palette stays a change to `main.css` and not to every page;
- gives `primary` to signals and actions only — a button, a link, the page you are on, something working.
  A surface that is neither takes `base-*` or `secondary`: a chat bubble is mist, inline code is ink;
- adds no neon or glow of its own: a live dot is daisyUI's `status` with the `halo` utility from `main.css`;
- respects `prefers-reduced-motion`: one rule in `main.css` stops animations, transitions and the transforms a
  press or a hover applies, and spares the spinners. Motion of a new kind joins that rule —
  `tests/reduced-motion.test.ts` fails on a press or hover transform it does not reach.

## Visual language
- Use generous editorial whitespace and one clear idea per viewport.
- Use a cool paper/off-white canvas, navy ink (the mascot's shadow, `#002448`, softened), muted blue-gray copy, mist/slate-blue surfaces, and quiet borders.
- The brand is the mascot's blue, azure `#0084fc`: use it only for signals and actions, lifted on dark and deepened on paper until text in it reads at WCAG AA. Teal and soft peach are secondary state accents. Green is a state — success — never the brand.
- Preserve space nuance through subtle radial gradients, orbit/ring lines, faint grids, and layered depth. Avoid literal starfields, busy galaxies, neon sci-fi, purple-on-white defaults, and generic AI imagery.
- Use `Manrope` for display/UI text and `DM Mono` for metadata, labels, navigation, status, and technical identifiers.
- Prefer pill navigation, floating cards, calm system-status surfaces, and real component previews.
- Glass should clarify relationships between layers, not become the brand personality; reduce blur on mobile.

## Implementation constraints
- Use only the host project's existing dependencies. Tailwind CSS and daisyUI are allowed; do not add other dependencies without explicit approval.
- Use daisyUI for accessible primitives, then apply Nouverse tokens and composition. Do not let default daisyUI theming define the brand.
- Implement motion with native CSS/Tailwind only. Motion must communicate hierarchy, feedback, storytelling, or state transition, and must respect `prefers-reduced-motion`.
- Keep navigation on one desktop line and below 80px tall. Keep hero copy focused: one headline, short supporting copy, one primary CTA, and at most one secondary action.
- Make every multi-column layout collapse explicitly below 768px.

## Anti-slop pre-flight
- Do not use repetitive split layouts, empty bento cells, excessive section eyebrows, dense fake dashboards, fake precision metrics, or decorative copy without product meaning.
- Product previews must be real component previews or supplied/generated assets, not decorative rectangle “screenshots”.
- Lock each page to one coherent theme; use tinted surfaces within it rather than random theme inversions.
- Re-read every visible string for clear grammar, honest claims, and a grounded engineering voice.

## For a public page

A landing page, a marketing site or another public surface also takes the anti-slop design book in
`design-book/taste.md` beside this file — composition, type, palette and a pre-flight check — with the Nouverse rules
above deciding where the two disagree.
