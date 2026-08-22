# Cagiral Schedule

A weekly lab planner that works the same on iPhone, MacBook and Windows: one web app, one data
file, and a calendar feed that keeps Apple Calendar up to date by itself.

- **App:** `https://<account>.github.io/cagiral-schedule/`
- **Calendar feed:** `https://<account>.github.io/cagiral-schedule/schedule.ics`

There is a **second, unrelated app** in here too — [Wardrobe](#wardrobe), which picks what to wear.
It shares this repository's plumbing (Pages hosting, the GitHub token, the PWA shell) and nothing
else: its own page, its own data file, its own service worker. See [`wardrobe/`](wardrobe/).

## How it fits together

| Piece | What it does |
|---|---|
| `claudeAgent.json` | **The source of truth.** Every event lives here. Nothing else is authoritative. |
| `index.html` | The app. Reads the JSON from GitHub, writes it back through the GitHub API. |
| `schedule.ics` | Generated. Apple Calendar subscribes to this and refreshes itself. Never edit by hand. |
| `workflows.md` | How Umut actually runs each protocol — durations, volumes, what blocks what. Kept up to date from conversations, and what the schedule is built from. |
| `protocols/western-blot.md` | Consensus timings from a survey of published Western blot protocols, with sources. The outside reference `workflows.md` is measured against. |
| `tools/build-ics.mjs` | Builds `schedule.ics` from `claudeAgent.json`. |
| `.github/workflows/ics.yml` | Runs that generator automatically on every schedule change. |
| `tools/make-icons.mjs` | Regenerates the app icons. Only needed if the icon design changes. |
| `sw.js` | Lets the app open instantly, and open at all with no signal (read-only). |
| `wardrobe/` | The **other** app — see [Wardrobe](#wardrobe). Nothing in it touches the schedule. |

Data flow: edit in the app (or have Claude edit the JSON) → commit lands on `main` → the workflow
rebuilds `schedule.ics` → Apple Calendar picks it up on its next refresh.

## Event shape

```json
{
  "id": "e-miniprep",
  "date": "2026-08-10",
  "start": "09:15",
  "end": "10:45",
  "title": "Miniprep",
  "category": "experiment",
  "type": "active",
  "status": "pending",
  "group": "Virus prep",
  "notes": "From overnight bacterial culture."
}
```

- `category`: `experiment` · `meeting` · `writing` · `personal` · `other`
- `type`: `active` (needs you there, blocks time) · `passive` (runs unattended, doesn't block time) ·
  `reminder` (no fixed hour — a flag for the day, not a booking)
- `status`: `pending` · `done` · `cancelled` — cancelled events stay in the file as a record but
  disappear from the app and stop alarming.

### Reminders

A `reminder` has no `start` or `end` — those keys are simply absent, not zeroed. It shows as a
small pinned chip above the timed grid (week view) or at the top of the day, ahead of anything
timed (day view), always in a fixed neutral colour rather than its category or group colour, so it
never gets mistaken for a booking. It can still be ticked done and moved between days; it just has
nothing to drag along a time axis, so it's edited through the dialog rather than dragged.

In the calendar feed it still needs a concrete time to hang a notification on, so `build-ics.mjs`
gives it one — a fixed 10:00 slot, invented purely for the feed and never written back to
`claudeAgent.json`. The alarm fires once, right at that time, instead of the 15-minutes-before lead
time active work gets.
- `group` (optional): ties related work together so it shares one colour across the week — e.g. HEK
  seeding, virus medium change and harvest all reading as one thread. The colour comes from the
  group's *name*, so it's identical on every device with nothing to keep in sync. Groups also become
  `CATEGORIES` values in the feed, so Apple Calendar can filter by them.
- `autoDone` (optional): `true` marks the event `done` by itself once its **end time** has passed —
  for commitments that are finished simply by the hour arriving, like the standing Wednesday Zoom.
  Two guards: only a device that can save will flip anything, so a read-only phone can't disagree
  with the file; and an `autoDoneAt` stamp records that it happened, so un-ticking one by hand
  sticks instead of being flipped straight back.
- Anything still `pending` with a date in the past shows up in the app's "Carried over" list until
  it's done, cancelled, or moved. Nothing is auto-deleted.

An optional top-level `_groups` map pins a specific colour to a group, overriding the automatic one:

```json
"_groups": { "Virus prep": { "color": "#14b8a6" } }
```

Entries for groups no longer used by any event are dropped automatically when the app saves.

## Using the app

- **Week grid (desktop):** drag empty grid to create an event; **drag an existing event to move it**
  to another day or time — it snaps to 5 minutes, keeps its length, and shows the new times as you
  drag. Escape cancels. Click an event to edit it.
- **Week grid on a touch screen:** an ordinary swipe scrolls the page, even when it starts on an
  event. To move one, **press and hold it for about a third of a second first** — it lifts and
  buzzes, and from then on the drag moves the event instead of scrolling.
- **Day list (phones):** tap to edit, tick to complete, and use **−15 min / +15 min** and
  **◀ day / day ▶** to move things — a list has no time axis to drag along.
- Moving an event that lands within 10 minutes of another active event, or overlapping one, shows a
  warning. It's advisory: the move is still saved.
- **Zooming the week grid:** pinch (touchscreen) or Ctrl/Cmd+scroll (trackpad or mouse wheel) to
  stretch or compress the hourly rows — vertically only, day columns stay the same width. The time
  under your fingers/cursor stays put on screen as you zoom, the same way a map zooms toward the
  cursor. A plain scroll or a pinch without the modifier key is untouched — only the intercepted
  gesture zooms. The level is remembered per device (not synced, not saved to the schedule data
  itself) and only applies to the week grid — the phone day list has no time axis to zoom.

There is no recurrence engine: repeating commitments are stored as individual dated events, so they
need regenerating when they run past their last date (currently 2026-12-31).

## Reminders

Alarms fire 15 minutes before **active, pending, future** events only — so subscribing doesn't
bury you in notifications for work already finished. `done` events show a `✓` and don't alarm;
passive incubations appear but don't mark you busy.

Times are Europe/Istanbul, declared as a fixed UTC+3 offset (Turkey has had no DST since 2016).

## Add it as a widget

Neither iOS, macOS nor Windows lets a website register a true home-screen or desktop widget — that
capability is native-app-only. But since the schedule is already subscribed as a calendar feed
(above), each platform's own **Calendar** app can show it as a widget today, with no extra setup:

- **iPhone**: long-press the Home Screen → **+** → **Calendar** → pick a size → add.
- **Mac**: Notification Center → **Edit Widgets** → **Calendar** (macOS Sonoma and later can also
  place it directly on the desktop).
- **Windows**: the Calendar app can't subscribe to an ICS URL directly, so there's an extra hop —
  subscribe via **Outlook.com** first (Calendar → Add calendar → Subscribe from web → paste the
  feed URL); that then flows into the Windows Calendar app and the Widgets board. **Outlook's
  refresh on a subscribed web calendar can lag over 24 hours** — much slower than Apple's roughly
  hourly refresh, worth knowing going in rather than discovering later.

For something closer to the app's own look — a compact "today" view rather than a generic calendar
widget — see [`widgets/`](widgets/), which has a small free helper-app build for each platform.

## Project Planning

**Plan Project** button in the header breaks research goals into phases and auto-generates calendar
events. It's the "elevator" to your calendar: describe your goal once, and the planner maps each phase
into a week's worth of concrete lab tasks.

1. Write your project in `projects.md` with phases and sub-steps as `- [ ]` checkboxes
2. Click **Project** → select your project and phase
3. Tick off anything already done — the tick is saved back to `projects.md`
4. Review the events proposed for what's left, then confirm
5. Events land in your calendar with a shared group colour

Proposed events are placed around what's already booked: never overlapping an active block, never
before tomorrow, never past 18:00. Durations come from `protocols/durations.md`; a step with no
researched duration gets a placeholder hour and is flagged as such rather than passed off as real.

Example: "GATA6 KO HEK293T cells" breaks into 6 phases (guide design → cloning → virus → transduction
→ validation → further work). Each phase becomes a week of events. As you mark events done, you can
re-run the planner to generate the next phase.

See `projects.md` for the template and a worked example.

## Setting up a new device

**Just looking:** open the app URL. Nothing to install, nothing to sign in to.

**Editing too:** the app needs a GitHub token, once per device.

1. github.com → your avatar → **Settings** → **Developer settings** (bottom of the left menu)
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
3. **Repository access** → *Only select repositories* → this repository
4. **Permissions** → *Repository permissions* → **Contents: Read and write**
5. Generate, copy, then paste it into the app's **Connect** button

The token is stored only in that device's browser. Set an expiry you're comfortable with; when it
lapses the app says so and drops to read-only rather than losing anything.

## Installing it as an app

The app is a full PWA — `manifest.webmanifest` declares `display: standalone` with 192 and 512 px
maskable icons, and `sw.js` registers a service worker with a fetch handler. So every platform can
install it as a standalone app with its own icon and window, no browser tabs and no extra code. It
is the same web app either way; installing only changes how it is launched and framed.

**macOS — Safari, no Chrome needed** (macOS Sonoma 14 or newer):

1. Open the app URL in Safari
2. Menu bar → **File** → **Add to Dock** (or the Share button → **Add to Dock**)
3. Name it, click **Add**

It lands in `~/Applications` and opens from the Dock or Spotlight. It keeps its own cookies and
storage, separate from Safari — so its GitHub token is stored per app, not shared with the browser.

**Windows — Chrome or Edge:**

1. Open the app URL
2. Click the install icon at the right of the address bar — or ⋮ menu → **Install**
3. Confirm

It appears in the Start menu and can be pinned to the taskbar. Manage or remove installed apps at
`chrome://apps`.

**macOS with Chrome:** same as Windows. It installs into Launchpad and the Applications folder.

**iPhone:** open the URL in Safari → Share → **Add to Home Screen**.

Installing is per device — it isn't something iCloud can carry across machines, since iCloud Drive
syncs files rather than installed apps. Nothing is lost by that: the schedule itself syncs through
GitHub, so every device reads the same `claudeAgent.json` regardless of how the app was launched.
The GitHub token is per device either way.

## Editing by hand or from a script

`claudeAgent.json` is plain JSON — edit, commit, push. The feed rebuilds itself. Keep `_meta` at the
end of the file; it records who saved last and when, and is not used for anything load-bearing.

To rebuild the feed locally: `node tools/build-ics.mjs` (Node 18+, no dependencies).

## Deliberate limitations

- **This repository is public**, so the schedule is readable by anyone who finds it. Writing still
  requires the token.
- Offline is read-only — the app shows the last schedule it downloaded and refuses to save rather
  than pretending to.
- Devices without a token poll a CDN copy, so they can trail a couple of minutes behind.
- Apple refreshes calendar subscriptions on its own schedule (roughly hourly), so reminders reflect
  changes with a delay. The app itself is immediate.

---

## Wardrobe

- **App:** `https://<account>.github.io/cagiral-schedule/wardrobe/`

A second app, sharing this repository and nothing else. It photographs your clothes, cuts the
backgrounds out, and picks an outfit for the weather — learning what you actually like as you
swipe. Install it separately: Safari → Share → **Add to Home Screen**, same as the schedule.

### How it fits together

| Piece | What it does |
|---|---|
| `wardrobe/wardrobe.json` | **The source of truth.** Every garment, what you wore, every swipe, the learned model, your settings. |
| `wardrobe/engine.js` | Every decision the app makes, as pure functions. The browser loads it with a `<script>` tag and `tools/wardrobe-selftest.mjs` runs the same file in node — one copy of the rules, tested where it runs. |
| `wardrobe/index.html` | The app. Reads and writes the JSON through the GitHub API. |
| `wardrobe/items/` | Each garment twice: the cutout sticker, and the original photo so the cutout can be redone later from another device. |
| `wardrobe/demo/` | Seventeen CC0 garments so the app works before you have photographed anything. See [`demo/SOURCES.md`](wardrobe/demo/SOURCES.md). |
| `tools/wardrobe-agent.mjs` | Works out what the wardrobe doesn't know about its own clothes. |
| `protocols/clothing-insulation.md` | Why the warmth numbers are what they are, with sources. |
| `protocols/outfit-matching.md` | The colour and formality rules, with sources. |

### Adding a garment

Photograph it, name it, done — **the name is the only thing that is required.**

The background comes out in your browser: a segmentation model is fetched once (about 45 MB, cached
afterwards, so the second garment onwards works offline), and a brush fixes whatever it got wrong.
A photo that already has transparency — a subject lifted out in iOS Photos — skips the model
entirely. The cutout then gets a **white outline**, so a black coat doesn't disappear into a dark
background.

Everything else — thickness, formality, pattern — starts as a guess, and the app says so wherever it
relies on one, including on the outfit card itself: *"8 °C outfit · 2 items' thickness is a guess"*.
**Fill the gaps** on the Wardrobe screen lists what is still guessed, worst first.

### Warmth

Insulation is measured in **clo**, the real unit — see
[`protocols/clothing-insulation.md`](protocols/clothing-insulation.md). You give each garment a
1–5 thickness step and the app maps it onto that garment type's published range: a "very thick"
t-shirt and a "very thick" parka are nowhere near the same number.

You cannot check a clo value by looking at it, so the app shows the consequence instead — *"good
down to 8 °C"* — which you can. And because no formula knows how warm *you* run, one tap after
wearing an outfit (cold / just right / too warm) shifts a personal offset. After a couple of weeks
it is fitted to you rather than to a textbook.

### What an outfit looks like

One row per part of the body, top down: anything on your head, then the tops and outerwear side by
side, then the bottom, then the shoes. Empty rows take no space. Nothing overlaps, so nothing is
hidden — and every garment can be grabbed anywhere, which an earlier scattered version could not
manage.

There is one backdrop behind the whole outfit and no box around any garment. That backdrop is
load-bearing: the white outline is baked into each cutout at upload time and cannot change with the
theme, so with nothing behind it a white shirt disappears on a white card.

**Drag one garment to change just that garment.** Left throws it away and asks for another with
everything else held exactly as it is; right keeps it and rebuilds the rest around it. Dragging the
card itself, away from any garment, still judges the whole outfit. Tapping a garment names it and
offers the same swap, how long you are keeping it, and a way to set it aside.

### When you turn a garment down

Rejecting one piece is the sharpest opinion you can give, and the app used to waste it twice over.
A rejection moved every garment in the outfit, so swiping away the shoes punished the trousers you
kept. And the learned model carried about 1% of the decision on the day you gave it, so a rejected
t-shirt came back in eight of the next eight cards — and still did after twenty more rejections.
Feedback that changes nothing you can see is worse than no feedback.

Both are fixed, and they pull in different directions on purpose:

- **A rejection is about a context, not just a garment.** It is stored with the rest of the outfit,
  and that piece never returns while the company is the same. "The same" is not "identical": white
  cotton trousers and white fabric ones are the same context, navy ones are not. Colour and
  formality count; fabric and cut do not.
- **The model now has a say while your opinion is still fresh.** A handful of rejections visibly
  moves the ranking, and a garment you keep turning down drops out of the deck within about eight.
  One rejection still doesn't banish anything — it was one opinion about one context.

### Two screens, two jobs

- **Today** picks for the actual weather (Open-Meteo, no key), the actual forecast (rain means a
  waterproof shell and no suede), and the actual day — it reads `claudeAgent.json` to know a lab day
  from a meeting. On a day that warms up more than 6 °C it dresses for the morning and names the
  layer to take off at midday.
- **Deck** ignores the weather completely. Its job is to learn taste, and only ever showing today's
  weather-appropriate outfits would teach it nothing about the other three seasons.

Nothing you pass on is ever deleted. When a deck runs out there is a screen that says which rule
filtered what, and offers to drop the rules one at a time, clear what you passed on, or let you set
the criteria by hand.

### Wearing things more than once, and setting things aside

There is no laundry tracking. Asking how many wears every garment gets before washing is a lot of
questions to solve a problem that only comes up for the few things worn several days running — so
those are the only ones you say anything about. Tap a piece on Today and say how long you are
keeping it: a number of days, or the rest of this week (through Sunday, however far into the week
you are). It then appears in every outfit until that date, exempt from the don't-repeat rule.

When something goes wrong — you spill on the trousers you had pinned for the week — tap the piece
and **set it aside**. It leaves every suggestion and loses its pin until you say otherwise. It is a
switch, not a counter, and nothing asks you about it: it exists for the rare day it is needed, and
the wardrobe grid badges it so it is not quietly forgotten.

The only thing keeping the same t-shirt off the card two days running is the don't-repeat window:
three days by default, adjustable in Settings. Logging what you wore today does not count against
today — that used to blank the screen on a narrow day the moment you said what you had on.

### Pairs

A tab of nothing but one top and one bottom: swipe right if they go together, left if they don't.
The pairs it asks about are the ones the app is already inclined to suggest and you haven't rated,
so the minutes you spend here change what you actually see. It's a strong preference rather than a
rule — an unrated pair can still turn up, which matters once a wardrobe is big enough that rating
every combination is out of the question.

### Telling it how the day went

Say you wore something and the verdict appears straight away, on the same screen: **too cold / just
right / too warm**, which is what fits the personal offset to you. Next to it is a box for whatever
those three words cannot hold — the wind cut through the coat, the jumper itched, those two never
worked together.

### The agent

**Analyze wardrobe** does two jobs. It looks at the clothes with gaps and works them out from the
photo and the name — how thick that jumper is, what it is made of, whether that shell is waterproof.
And it reads the notes you left on what you wore, turning them into concrete corrections.

Those two land in different places on purpose. Gap-filling refuses to touch anything you answered
yourself, and that promise is worth keeping exactly as it is. A note saying the coat was not warm
enough is by definition a contradiction of an answer you gave, so it appears as a suggestion instead
— quoting the sentence it came from, labelled as disagreeing, and doing nothing until you accept it.

Either way it cannot overwrite anything you entered. Two things are needed once:

1. `ANTHROPIC_API_KEY` as a repository secret (Settings → Secrets and variables → Actions).
2. **Actions: Read and write** on your token, on top of Contents — the schedule app never needed it.
   Without it the button explains what is missing; you can also run it from the Actions tab with no
   token change at all.

It runs only when asked. There is no schedule: it costs money per run and only has work to do just
after you add clothes.

### Checking it

```
node tools/wardrobe-selftest.mjs           # 98 checks on the rules
node tools/wardrobe-browser-test.mjs       # 77 checks on the app, in a real browser
node tools/wardrobe-agent.mjs --dry-run    # what the agent would ask, without calling anything
```

The first suite is the claims worth distrusting about the rules: no sweater at 30 °C, no bare outfit
at 5 °C, a pinned bottom in every outfit and its rivals in none, everything inside the insulation
tolerance, a rejected garment never returning while the company is the same but still turning up
somewhere genuinely different, a per-piece rejection leaving the pieces you kept untouched, logging
today's outfit not emptying today's suggestions, undo restoring the taste model exactly, and the
agent leaving a fully specified garment byte for byte identical when handed a reply built to rewrite
all of it.

The second drives the actual app in chromium with GitHub and the weather stood in for locally — and
the GitHub stand-in implements the real git data API, so what the app commits is checked as bytes
rather than as intent. It needs playwright; without it, it says so and exits without failing.

### What it deliberately doesn't do

- **This repository is public**, so the clothes and their photos are readable by anyone who finds
  it. Moving them to a private repository later only means pointing the app at a different one.
- The cutout model is [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4), licensed for
  non-commercial use. Fine for a personal wardrobe; not for anything sold.
- No travel or packing mode, no picking tomorrow's outfit tonight, no bulk upload.
- Weather comes from a free service with no key. If it cannot be reached the app dresses for a mild
  day and says so rather than guessing silently.
- Both apps are served from one origin, so they share a Cache Storage and the schedule's service
  worker scope covers this one. Each worker therefore clears only caches carrying its own name
  prefix, and the schedule's worker ignores `/wardrobe/` entirely — without that, opening one app
  wipes the other's offline copy and can leave it serving the wrong shell. `tools/wardrobe-browser-test.mjs`
  guards both.
