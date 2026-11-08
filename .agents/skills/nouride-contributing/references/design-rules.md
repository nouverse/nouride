# Nouride Design Rules

The visual and frontend standard for every Nouride surface: the dashboard, the desktop client, Nouride
Home, the site. Nouride has its own look since 2026-11-08 (the owner's call): soft and a little playful,
carried by its mascot. Other Nouverse products keep the Nouverse design rules; this file is Nouride's.

## Scope: which rule governs what

This file governs the **look**: palette, type, the mascot, motion, composition. `react-tailwind-daisyui`
governs the **mechanics**: the modules/commons layout, route files, component recipes, Lucide sizing,
accessibility. Where the two disagree about how something should look, this one wins.

The two theme blocks in `apps/dashboard/src/styles/main.css` are the tokens below in daisyUI's names.
Fonts are served from beside that stylesheet, since an offline box reaches no font CDN.
`apps/dashboard/tests/nouverse-look.test.ts` holds every pair that can carry text to WCAG AA in both themes.
Dashboard work keeps it that way:

- uses daisyUI semantic colours only (`base-*`, `primary`, `success`…), never a raw Tailwind palette
  class or hex, so a change of palette stays a change to `main.css` and not to every page;
- gives `primary` to the main action only: one per view. Lavender (`secondary`) marks where the person is
  and what is theirs: the page they are on, their chat bubble. Pink (`accent`) means "needs you" and
  nothing else;
- respects `prefers-reduced-motion`: one rule in `main.css` stops animations, transitions and the
  transforms a press or a hover applies, and spares the spinners. Motion of a new kind joins that rule;
  `tests/reduced-motion.test.ts` fails on one it does not reach.

## Palette ("soft semi-fun")

- **Day:** cream canvas `#faf7f2`, white cards, ink `#2b2838`, muted copy `#8a8597`, warm hairline borders.
- **Night:** a neutral violet grey `#1b1a24`, never black; cards one step lighter; the same accents,
  lifted until text in them reads at AA.
- **Accents:** peach `#f08a6c` (`primary`, the main action), lavender `#8c7ae6` (`secondary`), sage mint
  `#7fcdb4` (progress, done; `success` and `info`), pink `#ee7f9d` (`accent`, needs you). Red stays the
  error colour and is used for errors only.
- Lavender here is the brand's, chosen on purpose: the "purple-on-white default" warning in
  `design-book/taste.md` does not apply to it. Saturated purple gradients still do.
- Text on peach and on mint is ink, not white: white on these reads below AA.

## Type

- Headings: Fredoka, weight 500, a little tight (`letter-spacing: -0.01em`). Body and UI: Manrope.
  Identifiers, paths, code and versions: DM Mono.
- Never link a font CDN; every face is a local `woff2` beside `main.css`.

## Shape and depth

- Cards float: a hairline border in the theme's line colour and a soft, wide shadow (small offset, large
  blur, low alpha). No ink outlines, no solid offset shadows, no glass as a personality.
- Large radii: cards 22px, inputs 14px, buttons and chips fully rounded (pills).
- The main action may carry a faint glow of its own colour; nothing else glows.

## The mascot

The chibi tuxedo cat (helmet with the "N", see-through lavender sunglasses, lavender hoodie, cream
scooter). Its poses are transparent images in `docs/design/mascot/` (`standing/`, `riding/`, `states/`) until the dashboard uses them; a pose it uses moves to `packages/shared/assets/`, where every file must be named by code (`brand-assets.test.ts`). Each pose means one
state and is used for that state only:

- waving: the greeting; pointing: what needs the person; typing on a laptop: an agent at work;
- sleeping: an empty list; confused: a question or something unclear; sad with a broken plug: an error or
  offline; trophy or celebrating: a mission done; riding the scooter: something on its way (loading,
  an update, a delivery); good night: the Night greeting;
- the head alone: the logo, the favicon and the app icon.

At most one mascot per view, beside the content it explains and never on top of it. No mascot in a
table, a form or a dialog's body. A view that reads as plain information gets none.

## Layout

- Desktop: the sidebar. Phone (below 768px): a tab bar at the bottom (Home, Chats, Work, Agents, More),
  with Work holding missions, approvals and jobs under one badge, and a floating "+ Chat" on Home and
  Chats. No sidebar drawer on a phone.
- Home, in order: what needs the person, what is moving, Quick Chat, the agents.
- An approval is answered where it is asked: in the chat as well as on its page.
- Every multi-column layout collapses explicitly below 768px.

## Implementation constraints

- Only the host project's dependencies: Tailwind CSS and daisyUI; nothing else without the owner's word.
- daisyUI for accessible primitives, the tokens above for the brand: default daisyUI theming does not
  define it.
- Motion in native CSS/Tailwind only, and only where something changed (the dashboard's motion
  conventions: keyframes in `main.css`, dialogs through `Leaving`, lists through `useMotionList`).

## Anti-slop pre-flight

- No repetitive split layouts, empty bento cells, excessive eyebrows, fake dashboards or fake precision
  metrics, and no decorative copy without product meaning.
- Playful means the mascot and the words, not more colours: one accent per job, as listed above.
- Re-read every visible string for clear grammar, honest claims and a plain voice.

## For a public page

A landing page or another public surface also takes the anti-slop design book in
`design-book/taste.md` beside this file, with these rules deciding where the two disagree.
