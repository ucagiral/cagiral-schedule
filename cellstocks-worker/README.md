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
| POST | `/write` | Bearer token | `{path, content, message, sha?}` — commit a file under `cellstocks/data/`. See below. |

## Ownership on `/write`

A member may only write their own `cellstocks/data/<name>.json`. An admin may write any file
under `cellstocks/data/`. Nothing outside that prefix is ever writable through this endpoint —
it is not a general GitHub proxy, only enough surface for this one job. `content` is the raw
file text (the Worker base64-encodes it); pass the file's current `sha` (from a prior read via
GitHub's Contents API) when updating an existing file, omit it when creating a new one.

Ownership beyond "this is or isn't my file" — approving someone else's request to take or edit
an item — is not in this endpoint yet; it lands with the request/approval flow.

## Testing without Cloudflare

`worker.js` is a plain module (`export default { fetch }`, plus named exports) built only on
Web platform primitives (`fetch`, `Request`/`Response`, `crypto.subtle`) that both the Workers
runtime and Node 20 implement — no build step, same as the rest of this repository.
`tools/cellstocks-worker-selftest.mjs` runs it directly in Node against an in-memory stand-in
for KV and a stubbed GitHub API, so the whole request lifecycle (bootstrap → login → admin
user CRUD → ownership-checked write) is provable without deploying anything:

```bash
node tools/cellstocks-worker-selftest.mjs
```
