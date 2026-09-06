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
| POST | `/admin/users` | admin | Create an account: `{name, password, role?, hidden?}`. `role` is one of `member`, `admin`, `pi` — anything else is a 400, never a silent demotion. |
| DELETE | `/admin/users/:name` | admin | Delete an account, its `cellstocks/data/<name>.{json,xlsx}` pair, and revokes its sessions immediately. |
| POST | `/admin/users/:name/reset-password` | admin | `{password}`. |
| POST | `/admin/users/:name/rename` | admin | `{newName}`. Moves the git files and the KV account record. Invalidates their current session — see below. |
| POST | `/commit` | Bearer token | `{files: [{path, content, base64?}], message}` — one atomic commit under `cellstocks/data/`. See below. |
| GET | `/types` | Bearer token | The lab-wide item-type list, and each type's known attribute names. |
| POST | `/types` | Bearer token | Additive only: `{name}` adds a type, `{attribute: {type, name}}` adds one attribute name. Never removes or overwrites anyone else's addition. |
| POST | `/admin/types/merge` | admin | `{from, into}` — folds one type's attribute names into another and removes it. |
| DELETE | `/admin/types/:name` | admin | Removes a type. Vials already using it keep the name as history. |
| POST | `/admin/types/:name/attributes/rename` | admin | `{from, to}` — renames one attribute name; renaming onto an existing one merges them. |
| DELETE | `/admin/types/:name/attributes/:attr` | admin | Removes one attribute name from the suggestion list. Values already recorded under it are untouched. |
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

## Roles

Three, and the list is a whitelist — an unknown role is a 400 rather than a silent demotion
to `member`:

| Role | Own inventory | Can write | Sees |
|---|---|---|---|
| `member` | yes | only their own `cellstocks/data/<name>.{json,xlsx}` | their own boxes; other members' via the app's search-in-lab |
| `admin` | no | anywhere under `cellstocks/data/` | everything, and the admin tools |
| `pi` | **no** | **nothing** — `canWrite()` refuses every path, including one named after them | everything, read-only |

`pi` is the lab head: they read and search the whole lab and change none of it. The app hides
the Add tab and the admin tools for them; `canWrite()` enforces the write half here rather
than trusting it to.

## Deleting a user

`DELETE /admin/users/:name` deletes the account, its session, and its
`cellstocks/data/<name>.{json,xlsx}` in one commit — Umut's rule, from round 6: deleting
somebody takes their stock with them.

It is **refused with a 409 while that person still owns a box** in
`cellstocks/lab-storage.json`, and the error names the boxes. Their vials would go with
their file, but their boxes are in the lab's shared tree and nothing would clean them up —
before that tree was shared, the boxes lived in the account's own file and went with it.
`Admin → Handoff` is the way through: it gives every box a new owner (or discards it) and
then deletes the account itself.

## Renaming a user

`POST /admin/users/:name/rename` is a real identity change, not a display-name edit — Umut asked
for a rename to "update everything", so it touches three things:

1. **The git files.** `renameUserFiles()` reads the current blob sha for
   `cellstocks/data/<old>.{json,xlsx}` via the Contents API (the same call `/admin/history/at`
   already makes) and writes one tree that both points the new path at that same blob *and*
   deletes the old path (a tree entry with `sha: null` deletes it) — one commit, so the file is
   never briefly duplicated or briefly missing. A pair that 404s (never saved) is skipped.
2. **The KV account record** — a new `user:<newname>` key, the old one deleted.
Deleting the old KV key means any of that account's existing sessions stop resolving immediately
(`requireSession` re-reads the user record on every call) — a rename forces a fresh login under
the new name, the same trade-off deleting an account already makes.

## Ownership and atomicity on `/commit`

A member may only commit their own `cellstocks/data/<name>.json` and `cellstocks/data/<name>.xlsx`.
An admin may commit any file under `cellstocks/data/`. Two paths sit outside that prefix and are
writable on purpose:

- `cellstocks/lab-storage.json` — the lab's one shared storage tree. **Any signed-in member may
  write it**, because adding a box to the freezer is everyday work and there is no per-node
  permission model here to express "this branch is mine". What a member is *offered* is
  narrower than that: a box, and only a box. Adding or removing a freezer or tank is admin's
  alone, from the Structure screen — that rule lives in the app, since this check is
  path-based. The trade-off is deliberate and recorded in `canWrite()` itself, and every write
  lands as an ordinary git commit, so a bad one is visible in the history and revertable.
- `cellstocks/icons/<file>.{png,jpg,jpeg,webp}` — **admin only**, and the filename is validated
  against `^[a-zA-Z0-9._-]+$` before the extension check, so no nested path and no `..` gets
  through. No SVG: it is markup, and this repository is public.

Nothing else outside `cellstocks/data/` is ever writable through this endpoint — it is not a
general GitHub proxy, only enough surface for this one job. Every file in a `/commit` request is
ownership-checked before any GitHub call is made, so a request that mixes one writable path with
one forbidden path is rejected whole — nothing is partially committed.

`/commit` takes one or more files and lands them in a single git commit via the git data API
(blob → tree → commit → ref update), the same sequence `cellstocks/index.html`'s own
`commitFiles()` already used against GitHub directly. That matters because the app always saves
the JSON and its generated `.xlsx` together: a two-request version of this endpoint would leave a
window where the committed workbook and the inventory it's supposed to describe disagree, which
is exactly what `CLAUDE.md` says must never happen. `content` is the raw file text for JSON,
base64 (`base64: true`) for the binary workbook.

## Testing without Cloudflare

`worker.js` is a plain module (`export default { fetch }`, plus named exports) built only on
Web platform primitives (`fetch`, `Request`/`Response`, `crypto.subtle`) that both the Workers
runtime and Node 20 implement — no build step, same as the rest of this repository.
`tools/cellstocks-worker-selftest.mjs` runs it directly in Node against an in-memory stand-in
for KV and a stubbed GitHub API, so the whole request lifecycle (bootstrap → login → admin
user CRUD → ownership-checked atomic commit → type and attribute management) is provable without
deploying anything:

```bash
node tools/cellstocks-worker-selftest.mjs
```
