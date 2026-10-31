# Reminders

A task list that keeps reminding you until you confirm a task is done. A web app (PWA) plus a
small Cloudflare Worker that sends the push notifications. UI in English.

**It has no lock-screen widget.** That was the original goal, and it is not possible without a
native app: see "Findings". Umut declined Xcode and the paid developer programme, so the lock
screen requirement was dropped (2026-10-31).

## What it does
- Add a task by typing. Optional date/time; with a time, you also choose the repeat interval in minutes (1-1440, default 10).
- List order: tasks with a time first (soonest to latest), then the rest in the order added.
- Complete only inside the app: **Done…** opens a dialog, and the task is removed only after the button is **held for 2.5 s**. A tap does nothing.
- Once a task's time has come the phone gets a push, then again every interval, until the task is completed. Tasks without a time never notify.
- Completing removes the task from the server on the next sync, which ends its repeats. If the phone is offline when you complete, the sync is retried on reconnect; a push may still arrive in between.

## Files
- `engine.js` - every rule, pure functions (loaded by the page, the service worker, the Worker and `tools/todo-selftest.mjs`).
- `index.html`, `sw.js`, `manifest.webmanifest`, icons - the app.
- `../todo-worker/` - `worker.mjs` (API + cron + serves the app), `webpush.mjs` (VAPID signing), `wrangler.toml`.
- Tests: `node tools/todo-selftest.mjs`, `node tools/todo-browser-test.mjs`.

## Setup (once)
1. `cd todo-worker && npx wrangler kv namespace create TODO_KV` -> put the id in `wrangler.toml`.
2. `node todo-worker/gen-vapid.mjs` -> put `VAPID_PUBLIC` in `wrangler.toml`; set `VAPID_SUBJECT` to a `mailto:` address you read.
3. `npx wrangler secret put VAPID_PRIVATE_JWK` (paste the JSON) and `npx wrangler secret put AUTH_TOKEN` (any long random string).
4. `npx wrangler deploy` -> the app is at the printed `https://todo-worker.<account>.workers.dev`.
5. iPhone: open that address in **Safari**, Share -> **Add to Home Screen**, open the new icon.
6. In the app: Notifications and sync -> paste the AUTH_TOKEN, Save token, Enable notifications, then Send a test push.

The cron runs every minute (Cloudflare's finest resolution), so the shortest useful interval is 1 minute.
Never commit `VAPID_PRIVATE_JWK` or `AUTH_TOKEN`: the repository is public. Task titles are stored in the Worker's KV (needed to decide when to push); the push itself carries no text.

## Findings (checked 2026-10-31)
- Lock-screen widgets exist only as WidgetKit `accessoryInline`, `accessoryCircular`, `accessoryRectangular`, introduced in iOS 16 [LogRocket](https://blog.logrocket.com/building-ios-lock-screen-widgets), [Create with Swift](https://www.createwithswift.com/creating-a-lock-screen-widget-with-swiftui/). No source found offering them to a web app; no lock-screen "large" family was found (`systemLarge` is a Home Screen family - from general knowledge, not confirmed by those sources).
- Safari cannot schedule a local notification on iOS; Apple's guidance is to send a Web Push at event time from a server [Apple Developer Forums](https://developer.apple.com/forums/thread/735402), [WHATWG notifications #69](https://github.com/whatwg/notifications/issues/69). Hence the Worker.
- Web Push for home-screen web apps needs iOS 16.4+ [Apple Developer Forums](https://developer.apple.com/forums/thread/735402) [MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide).
- Native route, not taken: needs a Mac/Xcode or a CI macOS runner [WarpBuild](https://www.warpbuild.com/answers/can-github-actions-build-ios-apps-without-a-mac); free Apple ID signing lasts about 7 days and allows ~3 sideloaded apps [Flavio Copes](https://flaviocopes.com/apple-developer-free-vs-paid/), [AltStore FAQ](https://faq.altstore.io/altstore-world/app-ids). Whether App Groups work with a free Apple ID was **not** established. Whether these limits changed in iOS 27 was **not** established.
- **Not verified:** that this app's push works on iOS 27 beta specifically. Test with the "Send a test push" button first.
- **Not covered here:** the widget-refresh-budget question - it only concerns WidgetKit.
