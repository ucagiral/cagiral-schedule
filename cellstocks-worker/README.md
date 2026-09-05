# Cell Stocks worker

The one non-static piece of Cell Stocks. See the file header of `worker.js` for why it exists
and what it does and does not do — short version: it holds the single GitHub write token
privately and is the only thing that can commit a write, so it is the only thing that can
actually enforce who owns what. Reads never go through it.

This is infrastructure, not app code — it shares nothing with `cellstocks/`, same as
`cellstocks/` shares nothing with `wardrobe/` or the schedule app (see `CLAUDE.md` §7).

## Deploying (one time)

Requires a Cloudflare account (the free tier is enough) and `wrangler`
(`npm install -g wrangler`, or `npx wrangler`).

```bash
cd cellstocks-worker
wrangler login

# Create the KV namespace and paste the id it prints into wrangler.toml's kv_namespaces entry.
wrangler kv namespace create CST_KV

# Secrets -- never go in wrangler.toml or git.
wrangler secret put GITHUB_TOKEN       # a GitHub PAT with write access to this repo
wrangler secret put BOOTSTRAP_SECRET   # any random string; used once, see below

wrangler deploy
```

`wrangler.toml`'s `[vars]` (owner/repo/branch/allowed origin) are not secret and can be edited
directly if they ever need to change.

## Creating the first account

Every other account is created from the admin panel, but the admin panel needs someone logged
in as admin to open it — so the very first account is created once, directly against the
Worker, with the `BOOTSTRAP_SECRET` set above:

```bash
curl -X POST https://<your-worker>.workers.dev/bootstrap \
  -H 'content-type: application/json' \
  -d '{"name":"admin","password":"<choose one>","secret":"<BOOTSTRAP_SECRET>"}'
```

This only works once — it refuses the moment any user exists in KV — so it cannot be replayed
later even if the secret leaks. From then on, log in as that account and use `/admin/users` to
create every real account, including the ordinary `Umut` member account (the admin account
stays a separate, hidden login — see the plan this shipped from for why).

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| POST | `/bootstrap` | `BOOTSTRAP_SECRET`, once | Create the first (admin) account. |
| POST | `/login` | — | `{name, password}` → `{token, user}`. Sessions do not expire; logout is the only way to end one. |
| POST | `/logout` | Bearer token | Invalidate the session. |
| GET | `/session` | Bearer token | `{user}` — confirms who a token belongs to. |
| GET | `/admin/users` | admin | List every account (no password data). |
| POST | `/admin/users` | admin | Create an account: `{name, password, role?, hidden?, canBroadcast?}`. |
| DELETE | `/admin/users/:name` | admin | Delete an account. Revokes its sessions immediately. |
| POST | `/admin/users/:name/reset-password` | admin | `{password}`. |
| POST | `/admin/users/:name/rename` | admin | `{newName}`. Moves the git files, the KV account record, and every request/broadcast/notification that named them. Invalidates their current session — see below. |
| POST | `/commit` | Bearer token | `{files: [{path, content, base64?}], message}` — one atomic commit under `cellstocks/data/`. See below. |
| POST | `/requests` | Bearer token | Ask another member's owner for an item: `{toUser, itemName, vialId?, note?}`. Notifies `toUser`, not the requester. |
| GET | `/requests` | Bearer token | Every request this account is on either side of (as requester or owner), newest first. |
| POST | `/requests/:id/approve` | owner or admin | Marks the request approved and notifies the requester. See below for what "approved" does and doesn't do. |
| POST | `/requests/:id/deny` | owner or admin | Marks the request denied and notifies the requester. |
| GET | `/notifications` | Bearer token | This account's own notifications, newest first. |
| POST | `/notifications/:id/read` | that notification's own recipient | Marks one notification read. 404s for anyone else, including admin — there is no cross-account notification access. |
| POST | `/broadcasts` | Bearer token | `{text}` — a lab-wide message. Sends immediately if this account has broadcast authority (see below); otherwise queues for approval. |
| GET | `/broadcasts` | Bearer token | Broadcast authority sees every broadcast, pending or resolved; anyone else sees only their own. |
| POST | `/broadcasts/:id/approve` | broadcast authority | Sends a pending broadcast to the lab and tells the original sender it went out. |
| POST | `/broadcasts/:id/deny` | broadcast authority | Refuses a pending broadcast; it never reaches the lab. Tells the original sender. |
| GET | `/messages` | Bearer token | `{messages}` — every template's *effective* text (a lab's override where it has one, the shipped default otherwise). For UI copy like the broadcast compose box's own placeholder, not just what a notification sends. |
| GET | `/admin/messages` | admin | `{defaults, overrides}` — every message template this file can send, and which ones a lab has customized. |
| PUT | `/admin/messages` | admin | `{messages: {key: text}}` — set or reset templates. See below. |
| GET | `/admin/history/commits?user=<name>` | admin | Every commit that ever touched that user's data file, newest first. |
| GET | `/admin/history/at?user=<name>&at=<ISO8601>` | admin | `{sha, commitDate, content}` — that user's data file exactly as it stood at or before that moment. See below. |

### History (time machine)

"Even if someone deletes their stock, I should be able to retrieve the complete stock situation on
23 May 2026 14:56" — Umut, on the admin panel. Needs no separate storage: every save is already a
git commit to `cellstocks/data/<user>.json` (see `/commit` above), so GitHub's own commit history
for that one path *is* the time machine — including past a deleted account or a deleted data file,
since git history does not forget either. `/admin/history/at` uses GitHub's own `until` filter on
the Commits API, which finds the most recent commit *at or before* the given moment — not the
nearest commit in either direction — matching what "the situation on 23 May 2026 14:56" actually
means. Returns 404 if no commit to that file exists yet at that time, rather than silently
returning nothing or the wrong version. The admin panel is expected to turn the returned JSON into
a downloadable `.xlsx` client-side, the same way the live app always has (`cellstocks/xlsx.js` +
`engine.js`'s `vialsToSheets()`) — this endpoint only needs to produce the JSON as it stood, not
regenerate a workbook server-side.

### Editable message templates

Every notification this file ever sends — "X is asking about Y", a broadcast line, an
approval/denial — is a named template (`DEFAULT_MESSAGES`), not an inline string, because Umut
asked to be able to edit these from the admin panel. `PUT /admin/messages` merges into a single
stored override object (there are only a handful of templates and they only ever change together,
from one editor screen): send `{key: "new text with {placeholders}"}` to override a message, or
`{key: ""}` (empty/blank) to reset that one back to its default. An unknown key is rejected outright
rather than silently stored, so a typo in the editor can't quietly create a template nothing ever
reads. `{placeholder}` substitution (`fillTemplate()`) leaves an unrecognized placeholder in a
custom template untouched rather than dropping it, so a typo'd `{itme}` shows up as literal text
instead of vanishing — visible and fixable, not silently wrong.

Two of the templates (`broadcast-placeholder-direct`, `broadcast-placeholder-queued`) are never
sent anywhere — they're the broadcast compose box's own placeholder text in the app, editable for
the same reason every other message is. `GET /messages` (any logged-in user) is how the app reads
the *effective* text of any template to display it; `GET/PUT /admin/messages` (admin-only) is the
separate, admin-only pair for the editor screen, which additionally needs to know which ones are
overridden.

### Who has broadcast authority

Not just `role === "admin"`. Umut's own everyday login is an ordinary member account — the plan this
shipped from is explicit that he won't switch to the hidden admin account unless he has to — so
broadcast authority is a `canBroadcast` flag on the user record: always true for `role: "admin"`,
and settable on any other account (in practice, Umut's own "Umut" login) via `POST /admin/users`.
A message from an account without it queues as `"pending"` and notifies only the accounts that
*can* approve it, not the whole lab — that would defeat the point of asking first. A hidden account
(`hidden: true`, i.e. the admin login) never receives a broadcast itself — same "not really in the
lab for notification purposes" rule search-in-lab already follows.

## Renaming a user

`POST /admin/users/:name/rename` is a real identity change, not a display-name edit — Umut asked
for a rename to "update everything", so it touches three things:

1. **The git files.** `renameUserFiles()` reads the current blob sha for
   `cellstocks/data/<old>.{json,xlsx}` via the Contents API (the same call `/admin/history/at`
   already makes) and writes one tree that both points the new path at that same blob *and*
   deletes the old path (a tree entry with `sha: null` deletes it) — one commit, so the file is
   never briefly duplicated or briefly missing. A pair that 404s (never saved) is skipped.
2. **The KV account record** — a new `user:<newname>` key, the old one deleted.
3. **Every historical reference** — `fromUser`/`toUser` on `request:*` records, `fromUser` on
   `broadcast:*` records, and every `notification:<oldname>:*` entry re-keyed under the new name
   (notifications are keyed by recipient, so this is a re-key, not a field edit). The wording of a
   notification already sent is left exactly as it was — "Umut is asking about X" is what was
   actually said at the time; rewriting it would be inventing history, not correcting it.

Deleting the old KV key means any of that account's existing sessions stop resolving immediately
(`requireSession` re-reads the user record on every call) — a rename forces a fresh login under
the new name, the same trade-off deleting an account already makes.

## Ownership and atomicity on `/commit`

A member may only commit their own `cellstocks/data/<name>.json` and `cellstocks/data/<name>.xlsx`.
An admin may commit any file under `cellstocks/data/`. Nothing outside that prefix is ever
writable through this endpoint — it is not a general GitHub proxy, only enough surface for this
one job. Every file in a `/commit` request is ownership-checked before any GitHub call is made,
so a request that mixes one writable path with one forbidden path is rejected whole — nothing is
partially committed.

`/commit` takes one or more files and lands them in a single git commit via the git data API
(blob → tree → commit → ref update), the same sequence `cellstocks/index.html`'s own
`commitFiles()` already used against GitHub directly. That matters because the app always saves
the JSON and its generated `.xlsx` together: a two-request version of this endpoint would leave a
window where the committed workbook and the inventory it's supposed to describe disagree, which
is exactly what `CLAUDE.md` says must never happen. `content` is the raw file text for JSON,
base64 (`base64: true`) for the binary workbook.

## Requests and notifications: what "approved" does and doesn't do

The physical vial never moves through any of this. Umut's answer was explicit: approving a
request just marks the item "reserved for" the requester on the *owner's own side*, because
physically it's still sitting in the owner's own freezer until someone actually hands it over.
That marking is an ordinary edit to the owner's own `cellstocks/data/<owner>.json`, made through
`/commit` above like any other save — this Worker has no idea what a "vial" is and never touches
one. What it owns is the bookkeeping neither side could otherwise see: the pending request itself
(a requester cannot write into someone else's file to leave a note there) and the notification
that tells the other side something happened. The app is responsible for turning an approval into
an actual `reservedFor`-style field on the vial and saving it — that's app-side work, not here.

## Testing without Cloudflare

`worker.js` is a plain module (`export default { fetch }`, plus named exports) built only on
Web platform primitives (`fetch`, `Request`/`Response`, `crypto.subtle`) that both the Workers
runtime and Node 20 implement — no build step, same as the rest of this repository.
`tools/cellstocks-worker-selftest.mjs` runs it directly in Node against an in-memory stand-in
for KV and a stubbed GitHub API, so the whole request lifecycle (bootstrap → login → admin
user CRUD → ownership-checked atomic commit → request/approve/notify) is provable without
deploying anything:

```bash
node tools/cellstocks-worker-selftest.mjs
```
