# Prompt: set up the "Reminders" app for me (Android)

> **How to use this file.** Start a new chat with your Claude (Claude Code or Claude with file/terminal
> access is best), attach this file or paste all of it, and send. Claude will read the whole brief, ask you a few
> questions, then guide you step by step.

---

## 0. Who you are and how to work with me

You are my setup and customization assistant. A friend of mine runs an app called **Reminders** on his iPhone and
I want the same on my **Android** phone. Everything below is the brief.

How to work with me:

- **Reply in the language I write in.** Be short and direct; no flattery.
- **Ask first, build second.** Before changing or building anything, ask me the questions in section 5. Ask only
  what the answer changes. If something I say could mean two things, ask.
- **Guide me one step at a time.** Give a small group of commands or taps, then wait for my output before the next
  group. Say which program I should run them in (terminal, phone, browser).
- **Verify, do not guess.** Anything that depends on versions or platform behaviour (Android, Chrome, Cloudflare,
  Wrangler, widget apps) must be checked with a web search or the vendor's documentation before you state it, and
  you cite the source. If you could not verify something, say so plainly. Section 4 lists what was and was not
  verified when this brief was written; re-check anything that matters, it may be out of date.
- **Secrets never go through this chat.** Never ask me to paste a token, private key or password here, and if I do
  paste one by mistake, tell me to replace it (generate a new one) before continuing. Section 7 shows how to move
  secrets without copying them.
- **Treat my statements about my own phone and computer as true.** If I say a button does not exist, do not suggest it
  again.
- If a step fails, ask for the exact error text; do not repeat the same step.

## 1. What the app is

A personal task list that keeps reminding me until I confirm a task is done. Built for someone who forgets things.

- **Add a task by typing only.** Optional date/time. With a time, I also choose a **repeat interval in minutes**
  (1 to 1440, default 10).
- **Order:** tasks with a time first (soonest to latest), then the rest in the order added.
- **Completing is deliberate and only inside the app:** a "Done…" button opens a dialog, and the task is removed
  only after the confirm button is **held for 2.5 seconds**. A tap does nothing. (Built so it cannot be done by
  accident.)
- **Reminders:** once a task's time has come I get a push notification, then again every interval, until I complete
  the task. Tasks without a time never notify.
- **Every notification lists all open tasks** (up to 5 lines, then "+N more"); `!` marks one that is due.
- **Daily summary:** at times I choose (a list like `08:00, 20:00`, or a range `START-END/MINUTES` such as
  `08:15-21:00/5`, up to 200 times, in my phone's time zone) I get a notification listing all open tasks even if none is due.
  Skipped when there are no open tasks.
- **Open-task count on the app icon** (badge) where the platform supports it.
- **A read-only home-screen widget** listing the open tasks (on iPhone this is the free Scriptable app).
- UI language is English.

There is **no lock-screen widget** on the iPhone version: a web app cannot offer one and a native app needs Xcode
and a paid developer programme, which was declined. Do not push that route unless I ask for it.

## 2. How it is built

Two parts, no database server, free Cloudflare account:

1. **The app** (`todo/`): a PWA (plain HTML/JS, no build step). Tasks live **on the phone** (localStorage, and a copy
   in IndexedDB for the service worker). A service worker handles the offline shell and `push` events.
2. **A small Cloudflare Worker** (`todo-worker/`): serves the app and the API, and has a **cron every minute**. It
   exists because a browser cannot schedule a notification by itself; something outside the phone must send the
   push at the right time. It stores one KV value: the push subscription, each open task's title/time/interval, and
   when each was last pushed. The push itself is an **empty Web Push** signed with VAPID, so no payload encryption is
   needed. The service worker builds the text from the tasks stored on the phone.

All rules (ordering, when a push is due, repeat logic, summary slots, hold-to-confirm, notification text) are pure
functions in **`todo/engine.js`**, loaded by the page, the service worker, the Worker and the tests.

API (same origin as the app):

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/config` | none | returns the VAPID public key |
| `PUT /api/state` | `Authorization: Bearer <AUTH_TOKEN>` | app syncs `{sub?, tasks:[{id,title,due,everyMin}], summary?:{times,tz}}` |
| `GET /api/tasks` | same | read-only list `{tasks:[…]}` for widgets |
| `POST /api/test` | same | sends a test push now |

Secrets live only on Cloudflare: `AUTH_TOKEN` and `VAPID_PRIVATE_JWK`. The VAPID public key and the contact
(`VAPID_SUBJECT`, a `mailto:` address) are plain variables in `wrangler.toml`.

## 3. Where the code is

Public repository: **https://github.com/ucagiral/cagiral-schedule** (branch `main`). **Only these paths matter:**

- `todo/` (the app; `todo/README.md` has the setup steps and the sources behind each claim, `todo/scriptable/` is the iPhone widget)
- `todo-worker/` (`worker.mjs`, `webpush.mjs`, `gen-vapid.mjs`, `wrangler.toml`)
- `tools/todo-selftest.mjs`, `tools/todo-browser-test.mjs`, `tools/make-todo-icons.mjs` (tests and icons)

The rest of that repository is someone else's private lab tooling: **ignore it, do not copy or use anything from it.**

If you cannot read GitHub yourself, ask me to download the repository as a ZIP (Code → Download ZIP), unzip it, and
either give you the folder or upload just `todo/`, `todo-worker/` and the three `tools/todo-*` files. Work on a
**copy that is mine**: put those folders in a new empty folder on my computer. Nothing here needs a GitHub account.

### Do NOT reuse the original owner's deployment

Everything below belongs to the friend and must be replaced with mine, otherwise my tasks would land in his system
(or fail): his Worker address (`todo-worker.<his-subdomain>.workers.dev`, which appears in
`todo/scriptable/Reminders.js`), his AUTH_TOKEN, his VAPID keys, his KV namespace id. I create my own Cloudflare
account, KV namespace, keys and token (section 7).

## 4. What is known about iPhone vs Android (verify before relying on it)

**Verified when this brief was written (still re-check what matters):**

- On iPhone, web push only works for a web app added to the Home Screen (iOS 16.4+) and only after the user grants
  notifications. Badges on the icon work the same way (iOS 16.4+): <https://webkit.org/blog/14112/badging-for-home-screen-web-apps/>.
- Safari/iOS cannot schedule local notifications; Apple's advice is a server-sent Web Push at event time:
  <https://developer.apple.com/forums/thread/735402>. This is why the Worker exists. On Android, check whether
  Chrome's scheduled-notification support (Notification Triggers) is available; as far as was found it is not a
  usable standard, so assume the Worker is still needed. **Verify.**
- **Badge on Android:** MDN's page says the Badging API is not supported on Chromium-based browsers on Android:
  <https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon>. Verify; if
  true, the icon count simply does not exist on Android (the app code calls it defensively, so nothing breaks).
- **Scriptable is iPhone-only.** Android needs another way to draw a home-screen widget. Candidates found, none tested here:
  *Data Widget* (Play Store app that shows remote JSON from a URL), *Tasker 6.4 "Widget v2"*, and *Tasker + KWGT*
  (a Homey community tutorial describes the pattern: Tasker fetches, KWGT displays):
  <https://community.homey.app/t/tutorial-custom-android-widgets-dashboard-using-api-builder-app-tasker-kwgt/66614>.
  Check what each can actually do: **our widget feed needs an `Authorization: Bearer` header**; an app that cannot send
  headers needs a different arrangement (discuss the trade-off with me: for example a separate read-only token in the
  URL is easier but weaker, since URLs leak more easily).
- **Android lock-screen widgets:** per Android Authority/Android Central, Google brought them to tablets first and to
  Pixel phones with Android 16 QPR2, where on phones they appear in a screen-saver / charging view rather than on
  the ordinary lock screen. Whether *my* phone has any of this depends on its make and Android version.
  <https://www.androidauthority.com/lock-screen-widgets-on-phones-android-16-qpr2-3589668/>. **Verify for my phone.**
- **Delivery delay in battery saving (Doze):** Firebase's docs say normal-priority messages can be held until the
  device leaves Doze, and high priority tries to deliver immediately:
  <https://firebase.google.com/docs/cloud-messaging/android/message-priority>. The Worker already sends Web Push
  `Urgency: high`. An old Chromium thread reports high-priority web push not waking a dozing phone
  (<https://groups.google.com/a/chromium.org/g/push-notifications-dev/c/gWsM4Hg2JZE>). **Test on my phone** and, if
  reminders arrive late, research the Android battery settings for my phone's make instead of guessing.

**Not verified at all (you must research, not assume):**

- Whether Chrome on Android needs the page installed ("Add to Home screen" / "Install app") for push, or whether it
  works from a normal tab. Whether other browsers (Samsung Internet, Firefox) behave the same.
- Whether Android web notifications stay on screen until dismissed, and whether a *persistent* notification
  (one that cannot be swiped away) is possible from a web app. A native Android app could show an ongoing notification
  with the task list; that is a different, bigger project (Android Studio/Kotlin or a no-code tool). Do not start it unless
  I ask; present it as an option with its cost.
- The Cloudflare free-tier limits relevant to this design (KV writes per day, cron triggers, Workers requests):
  the cron runs every minute and every push writes KV, so a very short repeat interval with many tasks, or a summary
  every few minutes, could approach a daily write limit. **Look up the current limits and check my chosen intervals against them.**

## 5. Ask me these first (before doing anything)

Ask them together in one short message, then adapt the plan to the answers:

1. Which Android phone (make and model) and Android version? Which browser do I use? Is battery saver or a
   manufacturer "app sleeping" feature on?
2. Do I have a computer (Windows, Mac or Linux)? If not, what is possible from the phone alone (for example Termux),
   and is it worth it?
3. Do I already have a Cloudflare account? (If not, creating a free one needs no card, which should be verified.)
4. What do I actually need: only reminders by notification, or also an always-visible list (home-screen or lock-screen widget)?
   How strict should "complete" be (keep the 2.5 s hold, change it, make it longer)?
5. What should be different from the original: repeat interval default, summary times, task fields, language
   (the UI is English), colours, anything else I want? Do I want it as a web app only, or are you also open to a native
   Android app, knowing it is a bigger job?

## 6. What to keep and what may change

Everything is open to my wishes. Where I do not ask for a change, keep these on purpose:

- **Rules live only in `todo/engine.js`.** Change a rule there, not in the page, and add a check to
  `tools/todo-selftest.mjs`. Run `node tools/todo-selftest.mjs` (needs Node 20+; no install step) before saying
  anything works. `tools/todo-browser-test.mjs` drives the page in Chromium (needs `playwright`).
- **A tap must never complete a task** (the hold-to-confirm). Completing only happens inside the app, never in a notification or widget.
- **No secrets in files that could be committed or shared.**
- Android-specific adaptations (a different widget route, no badge, a different notification option) are expected,
  and each one should be explained, tested on my phone and added to `todo/README.md` with its source.

## 7. Setup procedure (adapt to my answers, one step at a time)

Written for a Windows PowerShell; translate for Mac/Linux. Run inside **my copy** of the folders from section 3.

1. **Tools.** `node --version` (20 or newer) and `git --version` if I use git. Install Node from nodejs.org if missing,
   then reopen the terminal. Create a free Cloudflare account if I have none.
2. **Log in:** `cd todo-worker`, then `npx wrangler login` (a browser opens; allow). Say yes to installing Wrangler if asked.
3. **KV store:** `npx wrangler kv namespace create TODO_KV`. It prints an `id`. Put it in `wrangler.toml` in place of
   `REPLACE_WITH_KV_ID`. (The id is not secret.)
4. **VAPID keys, without copying the private key anywhere:**
   ```powershell
   node gen-vapid.mjs > vapid.txt
   $pub = (Select-String -Path vapid.txt -Pattern '^VAPID_PUBLIC=').Line.Substring(13)
   $jwk = (Select-String -Path vapid.txt -Pattern '^VAPID_PRIVATE_JWK=').Line.Substring(18)
   (Get-Content wrangler.toml) -replace 'REPLACE_WITH_VAPID_PUBLIC', $pub | Set-Content wrangler.toml
   $jwk | npx wrangler secret put VAPID_PRIVATE_JWK
   Remove-Item vapid.txt
   ```
   (If the Worker does not exist yet, deploy first (step 6), then run the `secret put` line.)
5. **Contact for push services:** in `wrangler.toml` replace `mailto:you@example.com` with an address I read. Do not
   invent one for me.
6. **Deploy:** `npx wrangler deploy`. It prints my address `https://todo-worker.<my-subdomain>.workers.dev`.
7. **Access token, shown only on my screen, copied to my clipboard:**
   ```powershell
   $t = node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   $t | npx wrangler secret put AUTH_TOKEN
   $t | Set-Clipboard
   Write-Host $t
   ```
   I save it somewhere safe and send it to my phone myself (not through this chat); 48 characters are not for typing.
8. **On the phone (Android):** open my Worker address in the browser, install/add to Home Screen if the research from
   section 4 says that is needed, open **Notifications and sync**, paste the token, **Save token**,
   **Enable notifications**, then **Send a test push**. A notification must arrive.
9. **Then** set the summary times if wanted, add a task with a time a few minutes ahead and a short interval, and
   confirm it repeats until completed with the 2.5 s hold. Then do the widget part according to the Android route we chose.

Pitfalls the original setup ran into (avoid repeating them):

- A git command that opens a pager can trap the terminal (press `q`); `git config --global core.pager cat` prevents it.
- If the folder already exists, look inside it (`git status`) before deleting anything.
- Editing `wrangler.toml` locally and then pulling updates: use `git stash`, `git pull`, `git stash pop` (if git is used at all). Never commit
  my edited `wrangler.toml` to a public place with anything beyond the non-secret KV id and public key.
- A private key pasted into a chat must be replaced (generate a fresh pair and update the public key too).
- On iPhone, a browser can keep running an old service worker after a Worker update; fully close and reopen the app
  twice. Check whether Android has a similar issue before blaming the code.
- After every `npx wrangler deploy` that changes `todo/`, close and reopen the app so it picks up the new files.

## 8. Done means

- A test push reaches my Android phone and shows the open tasks.
- A timed task reminds me again and again at my interval until I complete it with the long press.
- I can see my open tasks without opening the app, in whatever way fits my phone (verified on the phone, not assumed).
- `node tools/todo-selftest.mjs` passes, and any change you made is written down in `todo/README.md` with its source.
- I know how to update the app and how to remove everything (`npx wrangler delete`, delete the KV namespace, remove the home-screen icon).
