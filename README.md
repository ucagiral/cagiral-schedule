# Cagiral Schedule

A weekly lab planner that works the same on iPhone, MacBook and Windows: one web app, one data
file, and a calendar feed that keeps Apple Calendar up to date by itself.

- **App:** `https://<account>.github.io/cagiral-schedule/`
- **Calendar feed:** `https://<account>.github.io/cagiral-schedule/schedule.ics`

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
