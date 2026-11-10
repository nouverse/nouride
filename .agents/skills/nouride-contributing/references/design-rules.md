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
- By day a pastel cannot carry text at AA on cream, so in `main.css` each daisyUI colour is its pastel's
  hue deepened until text in it does, and the pastel itself is a `--fill-*` for the few solid fills that
  make the look (the main button, a progress bar, the greeting's light). Write text in `text-primary` and
  the rest as usual; the main action is `btn-primary`, which takes the pastel.

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

What it stands for (the owner's reading, 2026-11-10), so a new pose or a line of copy keeps to it:

- **The rider.** The name holds "ride". Where other products call theirs an assistant or a copilot that waits in a
  corner for an order, this one drives: it runs the daemon on your machine, carries missions in the background and
  goes along on the long jobs. Draw it doing something, on its way somewhere.
- **The helmet is protection.** It is Nouride's core values worn on the head: safety, self-contained, kept apart on
  your own hardware with its own storage and no outside server to lean on. It also says tough: ready for whatever
  machine it is put on, a homelab server, a Mac, a cheap set-top box in a corner of the house. The cat never takes it
  off.
- **A relaxed cat in a protective helmet.** A cat is independent, easygoing and nimble; a helmet is functional and
  protective. Together: relaxed but tough. Keep both in a pose; neither a mascot that is only cute nor one that is
  only armoured.

On the landing page it also moves: it rides into the hero, rides along the window's foot as the page scrolls and wags
its tail at the footer. Those are the page's own (`apps/site/src/components/landing/`), cut from the sheets in
`docs/design/mascot/grids` by `apps/site/scripts/cut-mascot-motion.ts`.

At most one mascot per view, beside the content it explains and never on top of it; Home is the one
exception its mockup draws, a small one beside the card it explains. The landing page is the other: a chapter has
its own cat, and the rider at the window's foot is beside them. No mascot in a table, a form or a
dialog's body. A view that reads as plain information gets none. In the dashboard a pose is `<Mascot
pose=…>` or `<EmptyState pose=…>`; which state takes which pose is the table in v0.8.24's RFC
("The new look, as built").

## Layout

- Desktop: the sidebar. Phone (below 768px): a tab bar at the bottom (Home, Chats, Work, Agents, More),
  with Work holding missions, approvals and jobs under one badge, and a floating "+ Chat" on Home and
  Chats. No sidebar drawer on a phone.
- Home, in order: what needs the person, what is moving, Quick Chat, the agents. On a phone "+ Chat"
  stands in for Quick Chat: a floating button never covers a field.
- The menu by how often a page is opened: Home, Chats, Work, Agents; then Skills, Memory; everything set up
  once behind Settings, a page of grouped cards with a search. A section's other pages are tabs over it.
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
