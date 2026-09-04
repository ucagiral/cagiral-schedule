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
| POST | `/admin/users` | admin | Create an account: `{name, password, role?, hidden?}`. |
| DELETE | `/admin/users/:name` | admin | Delete an account. Revokes its sessions immediately. |
| POST | `/admin/users/:name/reset-password` | admin | `{password}`. |
| POST | `/commit` | Bearer token | `{files: [{path, content, base64?}], message}` — one atomic commit under `cellstocks/data/`. See below. |
| POST | `/requests` | Bearer token | Ask another member's owner for an item: `{toUser, itemName, vialId?, note?}`. Notifies `toUser`, not the requester. |
| GET | `/requests` | Bearer token | Every request this account is on either side of (as requester or owner), newest first. |
| POST | `/requests/:id/approve` | owner or admin | Marks the request approved and notifies the requester. See below for what "approved" does and doesn't do. |
| POST | `/requests/:id/deny` | owner or admin | Marks the request denied and notifies the requester. |
| GET | `/notifications` | Bearer token | This account's own notifications, newest first. |
| POST | `/notifications/:id/read` | that notification's own recipient | Marks one notification read. 404s for anyone else, including admin — there is no cross-account notification access. |

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
