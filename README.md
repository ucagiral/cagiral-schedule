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
  "notes": "From overnight bacterial culture."
}
```

- `category`: `experiment` · `meeting` · `writing` · `personal` · `other`
- `type`: `active` (needs you there, blocks time) · `passive` (runs unattended, doesn't block time)
- `status`: `pending` · `done` · `cancelled` — cancelled events stay in the file as a record but
  disappear from the app and stop alarming.
- Anything still `pending` with a date in the past shows up in the app's "Carried over" list until
  it's done, cancelled, or moved. Nothing is auto-deleted.

There is no recurrence engine: repeating commitments are stored as individual dated events, so they
need regenerating when they run past their last date (currently 2026-12-31).

## Reminders

Alarms fire 15 minutes before **active, pending, future** events only — so subscribing doesn't
bury you in notifications for work already finished. `done` events show a `✓` and don't alarm;
passive incubations appear but don't mark you busy.

Times are Europe/Istanbul, declared as a fixed UTC+3 offset (Turkey has had no DST since 2016).

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

**Home-screen app (iPhone):** open the URL in Safari → Share → Add to Home Screen. It then launches
without browser chrome.

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
