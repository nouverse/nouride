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
scooter). Its poses are transparent images in `docs/design/mascot/` (`standing/`, `riding/`, `states/`) until the dashboard uses them; a pose it uses moves to `packages/shared/assets/`, where every file must be named by code (`brand-assets.test.ts`) and every pose in the dashboard's table drawn by a page (`mascot-poses.test.ts`). Each pose means one
state and is used for that state only. The table is `POSES` in the dashboard's `Mascot.tsx`; in short:

- waving: the greeting; good night: the Night greeting; pointing: what needs the person; holding a watch: a mission
  that waits for an answer;
- sleeping: a list that fills by itself and has nothing in it yet; standing by the scooter: a list that waits for the
  person to make the first (agents, people, providers);
- lost over a map: an address that leads nowhere; confused: something that was there and is gone; sad with a broken
  plug: an error or offline; under a crossed-out signal: no chat app connected;
- the magnifying glass held up: a search or a filter that finds nothing; walking with it: a record nothing is written
  in yet;
- typing on a laptop: an agent at work; the trophy: a mission done; pushing the scooter: a mission that ended short;
- a page's own subject: the shield (access, secrets), the calendar, the book, the star (skills), the paper plane
  (webhooks), the box, the delivery (connectors), the wrench (an update), headphones at a laptop (coding CLIs);
- riding the scooter: something on its way (the dashboard loading, missions moving on Home);
- the head alone: the logo, the favicon and the app icon.

Where the cat goes in the dashboard:

- **An empty list** that is what the page or the tab is about: `<EmptyState pose=…>`. A filter or a search that
  matches nothing is the magnifying glass, whatever the page. An empty card among others keeps its icon.
- **Beside a page's title**, in the pose that is the page's subject, while the page has something to show
  (`<PageHeader pose=…>`): empty, the same cat is the empty list's, so a view still has one. Not on a phone.
- **Home changes its second picture each visit**, so the page opened most is not the same every time: one of several
  resting poses when nothing waits and nothing moves, one of several riding poses beside what is moving
  (`modules/home/moments.ts`). The greeting's cat does not change. A new resting or riding pose is one line there.
  The resting cat stands after its words, at the card's far side, where the greeting's stands before them: two cats
  on one side of the page read as one picture twice.

`standing/15-parked` stays in the waiting set and is not drawn: it has two scooters in it. The cat parked by its
scooter is `standing/03-scooter-lean`.

The poses on the later sheets (`grids/nourider-4.jpeg`, `-5.jpeg`) are cut by `apps/site/scripts/cut-mascot-poses.ts`.

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
`docs/design/mascot/grids` by `apps/site/scripts/cut-mascot-motion.ts`. In the hero it waves only once it has stopped:
while it rides in, and when a click sends it off and back, it is the riding cat (`landing/HeroRiding.astro`).

Three poses are also cut into parts, for motion that moves the tail, an ear or the head where a pose can only be
moved whole: the cat standing as it does at the landing page's footer, the cat riding at speed, and the waving cat.
The parts are the pose's own pixels and never a redrawing: a cat drawn again by hand is another cat (tried and
refused, 2026-11-12). `apps/site/scripts/cut-mascot-pieces.ts` cuts them along the lines in `mascot-piece-cuts.ts`,
each on the pose's canvas, so laid over each other they are the pose, into `packages/shared/assets/mascot/pieces`;
`apps/site/src/components/mascot/rigs.mjs` says what hangs from what and where each part turns. The standing cat is
the docs' corner cat and the riding cat the hero's; the waving cat is cut and put together and waits for a page. What
the art does not hold cannot be cut: no pose shows the scooter without the cat, and the wheels are painted at an
angle, so they do not spin. `mascot-pieces.test.ts` holds the pieces to the cut and the pages to the pieces.

A pixel cat waits as well, for motion no painted pose holds: 32 pixels a side, placed by hand, in
`docs/design/mascot/pixel`. It keeps the helmet's letter, the sunglasses, the hoodie and the tail's white tip, and
not the painting, so it is a second look and is used only where the owner asks for it. `make-sprite.mjs` there holds
its pixels as rows of letters and its moves (standing, walking, waving, hopping) as frames, and writes the sheet: a
new move is a few rows and a list of frames, never a part turned or scaled, which breaks a pixel drawing's grid. Below
32 the letter and the sunglasses cannot both be read; much above it a frame is no longer cheap to draw again.
`mascot-pixel-sprite.test.ts` holds the sheet to the script.

At most one mascot per view, beside the content it explains and never on top of it; Home is the one
exception its mockup draws, a small one beside the card it explains. The landing page is the other: a chapter has
its own cat, and the rider at the window's foot is beside them. No mascot in a table, a form or a
dialog's body. A view that reads as plain information gets none. The docs are the exception to that (the owner's
call, 2026-11-12): one small cat at the foot of the window's right edge, under the table of contents, for company on
a long read (`apps/site/src/components/DocsCat.astro`). It is the footer's cat, standing and facing the reader,
drawn mirrored so that it looks at the page and not at the window's edge; the letter on its helmet is a piece of its
own, turned back so that it still reads. It explains nothing and covers nothing: it is drawn only where the window is wide enough for that corner to be empty,
it wags its tail faster when pointed at and hops when clicked. In the dashboard a pose is `<Mascot
pose=…>` or `<EmptyState pose=…>`; which state takes which pose is the table in v0.8.24's RFC
("The new look, as built").

## Layout

- Desktop: the sidebar. Phone (below 768px): a tab bar at the bottom (Home, Chats, Work, Agents, More),
  with Work holding missions, approvals and jobs under one badge. No sidebar drawer on a phone.
- The floating chat (`commons/components/floating-chat`): a round button with an agent's face on every page
  but Chats, 3.5rem across, and the panel it opens. Below a laptop's width the button stands above the tab
  bar, never over it; from a laptop up it is in the window's corner. Every page's foot leaves it room
  (`PAGE_BOTTOM`, and `HELD_BOTTOM` under a page held to the window), so it lies over no card. The panel is
  a card over the button from a tablet's width up, with the page under it in reach, and a sheet on a phone.
  It is the one floating button: a page adds no second.
- What can be pressed shows the hand: every enabled `<button>`, whatever it looks like (a card, a chip, a
  round face), by one rule in `main.css`. A class that says another cursor (a drag handle's) still wins.
- Home, in order: what needs the person, what is moving, Quick Chat, the agents. On a phone the floating
  chat's button stands in for Quick Chat: a floating button never covers a field.
- The menu by how often a page is opened: Home, Chats, Work, Agents; then Skills, Memory; everything set up
  once behind Settings, a page of grouped cards with a search. A section's other pages are tabs over it.
- An approval is answered where it is asked: in the chat as well as on its page.
- Every multi-column layout collapses explicitly below 768px.
- A height taken from the screen is `dvh` (`h-dvh`, `max-h-[90dvh]`), never `vh` or `h-screen`: a phone
  browser's `vh` is the screen with its toolbar put away, taller than what is seen. Two height classes on
  one element are not a fallback: the one written later in the stylesheet wins, whatever their order in
  the class.
- Nothing lies over the phone's tab bar: a toast stands above it.
- A page held to the window (`fillsViewport`, `FILL_PAGE`) has its padding inside the height it is held to,
  so what runs past the window has none under it. `FILL_PAGE` carries a foot for that; a tab that runs
  down the page as a document does adds `RUNS_DOWN`, on a root as tall as what it holds (no `flex-1`,
  no `min-h-0`), and ends with the room a scrolling page has.

## Implementation constraints

- Only the host project's dependencies: Tailwind CSS and daisyUI; nothing else without the owner's word.
- daisyUI for accessible primitives, the tokens above for the brand: default daisyUI theming does not
  define it.
- Motion in native CSS/Tailwind only, and only where something changed (the dashboard's motion
  conventions: keyframes in `main.css`, dialogs through `Leaving`, lists through `useMotionList`).
- What is loading is drawn as its shape, never a spinner in the middle of a blank page: `ListLoading` for a list,
  `DetailLoading`, `CardLoading` and `TextLoading` (`Skeleton.tsx`) for a page about one thing, a card and a file
  being read. A list never shows its empty state before the answer says it is empty. A spinner is for one thing
  being done in a button (`list-loading.test.ts`).

## Anti-slop pre-flight

- No repetitive split layouts, empty bento cells, excessive eyebrows, fake dashboards or fake precision
  metrics, and no decorative copy without product meaning.
- Playful means the mascot and the words, not more colours: one accent per job, as listed above.
- Re-read every visible string for clear grammar, honest claims and a plain voice.

## For a public page

A landing page or another public surface also takes the anti-slop design book in
`design-book/taste.md` beside this file, with these rules deciding where the two disagree.
