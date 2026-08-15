# Widgets

Compact "today" views for iPhone, Mac and Windows — closer to the app's own look than a generic
calendar widget. See the main [README](../README.md#add-it-as-a-widget) first: if a plain calendar
widget is enough, it already works today with zero setup, because the schedule is already
subscribed as a feed. These are for when you want something that looks and behaves more like the
app itself.

**The real limitation behind why these exist as separate small helper-app builds, not a button in
the app**: none of iOS, macOS or Windows let a website register a true home-screen or desktop
widget — that's native-app-only on all three. Each of these instead uses a small, free, well
established third-party app that can run a script against a URL and render the result. All three
read `claudeAgent.json` straight from the public repo — the same read-only path any device without
a save token already uses. Nothing here writes anything back.

Colours are deliberately simplified compared to the app's week grid: status (active / passive /
reminder / done) is the signal that matters in a short "today" list, not full group-colour parity.
A group with an explicit colour pinned in `_groups` still gets it; one without falls back to a
status colour. This also means none of these need updating if the app's own colour palette ever
changes.

---

## iPhone — Scriptable

1. Install **[Scriptable](https://scriptable.app)** (free, App Store).
2. Open Scriptable → **+** → paste the whole contents of
   [`ios-scriptable/CagiralSchedule.js`](ios-scriptable/CagiralSchedule.js) → name the script
   **CagiralSchedule**.
3. Long-press the Home Screen → **+** → search **Scriptable** → pick small or medium → add.
4. Tap the new placeholder widget → **Script**: `CagiralSchedule` → **When Interacting**: Run
   Script.

Tapping the widget opens the app itself. iOS decides the real refresh cadence for any widget — the
script only hints a preferred interval; that's a platform limit, not something adjustable here.

**Uninstall**: remove the widget from the Home Screen, then delete the script from Scriptable.

## Mac — Übersicht

1. Install **[Übersicht](https://tracesof.net/uebersicht/)** (free, open source) — it creates
   `~/Library/Application Support/Übersicht/widgets/` on first launch.
2. Copy the whole [`macos-uebersicht/cagiral-schedule.widget`](macos-uebersicht/) folder into that
   directory. The `.widget` suffix on the folder name is how Übersicht finds it — keep it.
3. It renders automatically once copied in; no separate install step.
4. To reposition or resize: edit the `top`/`left`/`width` values in `index.jsx`'s `className`
   export — Übersicht hot-reloads on save.
5. To change the refresh interval: edit `refreshFrequency` (milliseconds) near the top of
   `index.jsx`. Default is 5 minutes.

**Uninstall**: delete the `cagiral-schedule.widget` folder from Übersicht's widgets directory.

## Windows — Rainmeter

1. Install **[Rainmeter](https://www.rainmeter.net)** (free, open source).
2. Copy the whole [`windows-rainmeter/CagiralSchedule`](windows-rainmeter/) folder into
   `Documents\Rainmeter\Skins\`.
3. Rainmeter's tray icon → **Manage** → **Skins** tab → refresh the list → select
   `CagiralSchedule\CagiralSchedule.ini` → **Load**.
4. To change the refresh interval: edit `UpdateRate` on `[MeasureFetch]` in
   `CagiralSchedule.ini`. Default is 5 minutes.
5. After any manual edit, right-click the skin on the desktop → **Skins** → **Reload skin**.

This talks directly to GitHub — it's unrelated to the Outlook/Windows-Calendar ICS path in the main
README, so it doesn't inherit that path's >24-hour subscription refresh lag.

**Uninstall**: unload the skin from Rainmeter's manager, then delete the `CagiralSchedule` folder
from `Documents\Rainmeter\Skins\`.

---

## What's actually been verified, and what hasn't

Built and checked from a Linux environment with no iOS, macOS or Windows GUI available, so here's
exactly what that means in practice:

- **The data fetch**: confirmed live — the raw GitHub URL each widget uses returns the current file,
  byte-identical to what's in the repo, with no authentication.
- **JS syntax** (Scriptable, Übersicht): both pass a real syntax check (`node --check` for the
  Scriptable script; an `esbuild` JSX transform for the Übersicht one, since Node can't parse JSX
  natively) — but neither has actually *run* inside Scriptable or Übersicht's own runtime.
- **The Rainmeter Lua** (`parse.lua`, and the vendored `json.lua` decoder): this one **has** been
  run for real — Rainmeter bundles Lua 5.1, and Lua 5.1 is installable here, so the full pipeline
  (decode → filter to a given date → sort → format) was tested end-to-end against the actual,
  current `claudeAgent.json`, including a day with a real reminder event, real passive events, and
  a mix of done/pending status. What could *not* be tested here is the `.ini` file itself — the
  WebParser measure, the `Script`↔`WebParser` coordination via `FinishAction`, and the `Shape`/
  `String` meters — since that requires the actual Rainmeter engine. Each piece of INI syntax used
  was checked against Rainmeter's own documented examples rather than guessed.
- **Actual on-device rendering** — what it looks like, whether sizing feels right, real widget
  refresh timing — is untested by construction, and is the thing to check first after installing.
