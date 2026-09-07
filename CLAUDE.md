# Working agreement

This file is read automatically at the start of every session, so it is where standing instructions
belong. Notes buried in other files may not be read before work starts; anything that must shape
behaviour from the first message goes here.

The repo is Umut's lab schedule: `claudeAgent.json` is the source of truth, `index.html` is the app,
`schedule.ics` is generated. See `README.md` for the mechanics.

It also hosts **two more, unrelated apps**: `wardrobe/` picks what to wear, and `cellstocks/` keeps
track of the frozen cell stocks in the −80 °C freezer. Everything below is about the schedule unless
it says otherwise; §6 covers the wardrobe and §7 the cell stocks. When a request is about clothes,
weather or outfits none of the scheduling rules apply; when it is about vials, boxes or freezers,
§7 applies and the scheduling rules still don't.

---

## 1. Ask before building

**Default to asking.** When Umut asks for something, the useful move is usually a few sharp
questions first, not an immediate half-right implementation. A wrong guess costs a rebuild and
erodes trust in the schedule; a question costs thirty seconds.

Ask when:

- the request could reasonably mean two different things,
- a duration, order or dependency isn't stated and the answer changes the plan,
- the change touches a day that is already full, or work already marked done,
- there's a trade-off worth his call (finish late today vs. split across two days).

Don't ask when the answer is already written down here, in `workflows.md`, or in `protocols/` —
look it up instead. Don't ask permission for the obvious mechanical step.

Prefer a small number of concrete, answerable questions over an open "what do you want?".

## 2. Write everything down, automatically

**Any new protocol, term, timing, quantity, preference or correction that comes up in conversation
gets recorded — without being asked.** The conversation is not storage; the md files are. If Umut
has to repeat himself, the notes failed.

This includes casual remarks: "boiling is 15 minutes active", "medium change is 6.5 mL", "don't run
past 18:00", "I did that already". All of it lands in a file.

Where things go:

| What | File |
|---|---|
| How Umut runs a protocol — his durations, volumes, orderings, preferences | `workflows.md` |
| Published protocol consensus, with sources | `protocols/<topic>.md` |
| Researched durations per procedure, hands-on vs. unattended | `protocols/durations.md` |
| Standing instructions about how to work | this file |
| App behaviour and data shape | `README.md` |
| How warm a garment is, why, with sources | `protocols/clothing-insulation.md` |
| What goes with what, and why | `protocols/outfit-matching.md` |
| How long a frozen vial keeps, and what has to be recorded about it | `protocols/cryopreservation.md` |

New topics get a new file under `protocols/` rather than being crammed into an existing one.

**Back factual claims with real sources.** Vendor protocols, published methods, manufacturer
documentation — cited by link in the file. Not memory, not a plausible-sounding number. When
sources disagree, record the range and say which end we take and why. Anything Umut states directly
beats a published range, and gets written down as our value.

If something he says is ambiguous enough that it can't be recorded accurately, ask — a wrong entry
is worse than a missing one, because it will be trusted later.

## 3. Durations are researched, every time

Every event created or re-timed gets a web-searched duration — every time, including procedures
looked up before. Findings land in `protocols/durations.md` with sources. Record hands-on and
unattended time separately: that is what decides whether other work can be scheduled on top.

Events already on the calendar are left alone unless asked. This applies to new and re-timed events.

## 4. Landing changes

The calendar feed only rebuilds from `main`, so a change that stops at a branch never reaches
Apple Calendar. Work on a branch, open a PR, merge it — don't leave it sitting.

Before editing, re-read `claudeAgent.json` from `origin/main`: Umut edits from his phone
mid-session, and those edits are real. If he marked something done, it is done.

Rebuild the feed with `node tools/build-ics.mjs` and commit the result alongside the JSON.

## 5. Scheduling rules that keep biting

- `active` blocks the day; `passive` runs unattended. Other work goes **inside** passive stretches,
  never overlapping another active step. Verify this programmatically before claiming a day works.
- Dependencies are real: boil before loading, transfer before any antibody, cDNA before qPCR prep.
- Don't push a day past roughly 18:00 without saying so and offering the split.

## 6. The wardrobe app

`wardrobe/` is a separate app that happens to live in this repo. It shares the Pages host, the
GitHub token and the PWA pattern; it shares no data and no rules with the schedule. It only ever
*reads* `claudeAgent.json`, to tell a lab day from a meeting.

- **Every rule lives in `wardrobe/engine.js`**, as pure functions with no DOM and no clock. The
  browser loads that file and `tools/wardrobe-selftest.mjs` runs the same file in node. Change a
  rule there, not in the app, and add a check — the suite exists so claims about the rules can be
  verified instead of believed. Run it before claiming anything works.
- **Warmth is in clo**, from the published tables, never invented. A garment's thickness step maps
  onto that garment type's own range. Anything Umut states about a specific garment beats the table.
- **Say when something is a guess.** A thickness the app inferred is marked as one, on the item and
  on the outfit card. Never present an inferred value as though it were answered.
- **The agent never writes a field.** `tools/wardrobe-agent.mjs` writes proposals to `agentGuessed`;
  only Umut accepting one in the app settles it. Do not add a path around that.
- **Only the name is required** when adding a garment. Do not add a second mandatory field.
- **There is no laundry tracking, and that is not an oversight.** It was removed because it asked a
  question about every garment to solve a problem that affects a few. Multi-day wear is one
  mechanism — pinning a piece, from the outfit itself. Do not reintroduce a wear counter.
- **A per-piece rejection blames only that piece.** `trainTaste` skips the item-level features of
  everything he kept when a swipe carries a `focus`. Losing that quietly turns his sharpest signal
  back into his vaguest one.
- **A rejection is about a context.** It is stored with the rest of the outfit and blocks that piece
  only while the company is equivalent — same slot, similar colour, same formality; fabric and cut
  are not differences. Do not widen this into a blanket ban on the garment.
- **Feedback has to be visible in the ranking.** The model's early influence was once so low that a
  rejected garment came back in eight of the next eight cards. If `ruleWeightFor` is ever retuned,
  measure that number rather than reasoning about the curve.
- **The agent has two channels and they are not interchangeable.** `applyProposals` fills blanks and
  refuses anything answered by hand; `recordSuggestions` carries corrections read out of his written
  notes, which may contradict an answer and therefore quote the sentence and wait for acceptance.
- New wardrobe facts — a garment's real warmth, a preference about what he will and won't wear,
  a correction — get written down the same as anything else, into the table above.

---

## 7. The cell stocks app

`cellstocks/` is a separate app that happens to live in this repo. **It is not related to anything
else in here.** It shares the Pages host and nothing else — not the data, not the rules, not even
the browser storage: its own token, device name, theme and offline cache, all under `cst_*` keys.
Do not "reuse" a helper from another app in it, and do not factor anything out of it into shared
code. The only unavoidable overlap is that one origin means one Cache Storage, which each service
worker handles by sweeping only its own prefix.

- **Every rule lives in `cellstocks/engine.js`**, as pure functions with no DOM, no fetch and no
  clock — ids, timestamps and "today" are always arguments. The browser loads that file and
  `tools/cellstocks-selftest.mjs` runs the same file in node. Change a rule there, not in the app,
  and add a check. Run the suite before claiming anything works.
- **A row holds one kind of cell, and that is the placement rule.** The grouping key is the
  **origin** facet, not the line: KO, OX, CASPEX and guide of one cell all share a row. A different
  cell never takes a free slot beside it — it starts a fresh row, and failing that a fresh box.
  This is not tidiness; it is how the freezer already is (of the 43 rows in use, 42 hold exactly
  one cell). One freeze-down stays in one row where a row can hold it, and in one box where a box can.
  Do not "optimise" this into first-free-slot packing.
- **The name is the only thing typed.** Origin, KO/OX, resistance, CASPEX and guide are derived
  from it by `classify()`, which is the spreadsheet's five formulas — and **the rules are data in
  each account's own `cellstocks/data/<name>.json`, never code**. Umut said he may define new
  common labels; that has to stay a Rules-screen edit. A facet he has set by hand is never
  recomputed.
- **`cellstocks/data/<name>.json` is one person's vials, one file per account. `cellstocks/data/<name>.xlsx`
  is generated from it on every save** and committed in the same commit, never the reverse. A hand
  edit to the workbook is thrown away by the next save; do not add a path that reads it back.
- **An empty structure is an answer, not a missing one.** `labStorageLoaded` says whether
  the tree has been read this session; never infer it from `labStorage.units` being empty.
  Deleting the last freezer made the app treat the tree as unloaded and re-read it from
  raw.githubusercontent, which serves the previous version for a while after a commit — so
  the deleted freezers came back on screen and the next delete wrote one of them back.
  There are five rounds of that in `lab-storage.json`'s history. A commit is the freshest
  copy there is: after one, never re-read.
- **There is one kind of node, and it recurses. That is the whole storage model.** A **layer**
  has a name, a note, an icon and children; a layer marked `isBox` **stops** — it takes an
  `owner` and an A×B grid, and nothing goes inside it. There is no depth limit and no fixed
  unit → rack → box triple: a real lab is `Freezer 1 → Shelf 1 → Metal Rack 1 → a box`, or a
  fridge with two shelves, or a tank with towers and canes. Umut drew this himself, twice,
  after three rounds of fixed levels being wrong. Never reintroduce a level count, a
  `childLabel`, or a "leaf or group, never both" rule — both existed only to prop the fixed
  levels up. `eachNode`/`findNode`/`addNode`/`editNode`/`moveNode`/`removeNode` are the whole
  API; `eachBox`/`findBox` are a thin view over it that still hand back `{box, rack, unit,
  chain}` so old call sites kept working.
- **`unplaced` is the one thing beside the tree.** A member may make a box before anybody has
  said where it lives — his flow is fill it first, then choose the cabinet — so it waits in
  `storage.unplaced` and shows as *"Not placed yet"* on the Boxes tab, in Structure, and in
  the daily export. It is real inventory with no location, never hidden and never given a
  fake one. Only an admin moves it into the tree.
- **There is one freezer, so there is one structure file.** `cellstocks/lab-storage.json` holds the
  whole lab's tree — `labName`, `labIcon`, `children`, `unplaced` — and every box carries an
  `owner`. Storing a copy of it inside each member's file was wrong three rounds running: it made
  the one physical −80 exist as several unrelated records, and it put a person level in a tree whose
  spec (his own picture) has none. `slim()` strips `storage` before a member file is saved and
  `hydrateStorage()` puts it back at load, so every engine function still reads `state.storage`
  exactly where it always did. Do not put the tree back into a member file.
- **A vial stores its whole route, as `{id, name}` per step.** Umut's call, asked and answered:
  the file says where a vial is even without the tree. An id alone survives a rename but reads
  as nothing to a person; a name alone goes stale the moment a shelf is renamed — so both.
  The tree stays the source of truth for what is drawn; a stored path that disagrees is a
  `stale-path` **warning** from `validate()`, never silently believed and never silently
  overwritten. `refreshPaths()` is the fix, and `commitLabStorage` runs it in the **same
  commit** as the move or rename that caused it: a follow-up commit means a failure in
  between leaves exactly the half-finished state the warning describes.
- **The Structure screen is a folder tree, all of it on screen at once, open by default.**
  Root, every layer, every box, ✎ on every row including the root, **+** on every row that is
  not a box, drag any row onto any layer. A node is open unless it has been collapsed by
  hand — which is also why a layer added inside a folder is visible the moment it is saved.
  It is admin-only, and it is the third attempt — do not "simplify" it back into one level at
  a time or a per-member picker.
- **Admin deletes a freezer, rack or box outright — but a vial is never erased.** The count
  fields could only trim from the end, so every row's ✎ has a Delete. Umut asked for it to
  need no Handoff and no emptying by hand, so it does not refuse: any vial still inside is
  **withdrawn first, in its own owner's file**, with the same `from` snapshot that taking one
  out by hand writes, so it leaves the inventory but stays in the Log and in history. The
  confirm says how many vials and whose before anything runs, and the owners' files are
  written **before** the tree, so a failure mid-way leaves the boxes still named rather than
  the vials stranded. Deleting a *user* is the opposite and still refuses — that needs Handoff.
- **Everything moves the same way, because everything is a node.** `moveNode` takes a box, a
  shelf or a whole freezer into any layer, to the top level, or back out to `unplaced`, with
  everything under it. The drag payload is the bare node id — no kind prefix to keep in step.
  It refuses a node into itself or its own descendant (that would cut the subtree off the
  tree, taking every vial in it out of the world) and anything into a box.
- **Nothing turns a layer into a box or back.** `editNode` deliberately cannot flip `isBox`:
  one direction orphans the children, the other orphans the vials. It is a
  delete-and-make-again decision, and the tick is disabled once the node exists.
- **A member adds a box; only admin adds a freezer.** The quick-add row on the Boxes tab offers
  a box and nothing else — the "Add a freezer or tank" button was removed at Umut's word, not
  disabled, because a member adding a unit was adding it to everybody's tree. With no freezer
  yet, "Add a box" is disabled and says to ask an admin. Do not put a unit-level control back on
  a member's screen.
- **Every folder carries its own icon, and both kinds are real.** An emoji is stored as the
  character; an uploaded image lands in `cellstocks/icons/` (admin only, PNG/JPG/WEBP, no SVG — it
  is markup and this repo is public) and the node stores only the filename. `iconKind()` decides
  which by extension; nothing else guesses.
- **An account that still owns a box cannot be deleted.** Its vials go with its file, but
  its boxes live in the shared tree and would be left behind naming somebody who no longer
  exists — which is exactly what happened the first time Umut tested it. `routeDeleteUser`
  refuses with a 409 that names the boxes; the app says the same thing without the round
  trip and points at Handoff, which is the way through. Do not "clean up" by silently
  dropping or unassigning the boxes.
- **A workbook is generated from the inventory, and the inventory is two files.** The sheets
  name the unit, the leaf rack and the box, and there is a whole `storage` sheet, so a rename
  in the tree makes every affected member's `.xlsx` wrong while no vial has moved.
  `commitLabStorage` regenerates them *in the same commit* as the tree — never a follow-up —
  and works out who is affected by comparing the generated sheets, not by guessing which
  edits count as renames. CI checks every `cellstocks/data/*.json` that has a workbook, never
  one account by name.
- **A handoff hands over, it does not copy.** The boxes stay physically where they are — only
  `box.owner` changes in the shared file — the vials move into the new owner's file under freshly
  minted ids, every box must be given a destination (or explicitly Discarded) first, and then the
  departing account is deleted along with both its files. Do not reintroduce the old "From <user>"
  unit, and do not leave the account standing.
- **Two stored vials in one slot is an error, not a warning.** `validate()` returns it as one and
  the save is refused. Do not downgrade it, and do not add a code path that places a vial without
  going through `validate` first.
- **Withdrawal does not delete a vial.** It sets `status:"withdrawn"`, clears the location and logs
  a snapshot of where it was. History is not optional in a lab inventory. Undo restores the vial
  only if its slot is still free.
- **Freezer geometry is data, not code.** Never hardcode 9×9, a level count or a position format.
  A nitrogen tank, a freezer and a fridge are the same thing — layers — and differ only in what
  the admin typed in their name and note; the positions in a box come from its own `rows`,
  `cols` and `scheme`. There is no machine-readable `type` any more: Umut asked for one free
  note field ("sadece serbest açıklama metni"), so nothing branches on what a layer *is*.
- **The placement proposal is a proposal.** The override path stays — but even an override may not
  mix two cells in one row, and a plan never part-fills silently. If it cannot describe a run
  honestly it lists the slots instead.
- **A row that already mixes two cells is a warning, not an error.** One row does — UMUT CAA CELLS
  A, one Du145 among eight HEK293T. It is listed for review; it does not block a save, and nothing
  is moved to fix it without being asked.
- **Work a device has not committed is merged with the server's copy, never replaced by
  it.** Umut froze two vials, the save was refused, and the next time the app opened they
  were gone — he had to enter them again. Three lines apart: `markDirty()` cached the
  state, `dirty` lived only in memory, and `load()` then overwrote `state` with the
  committed copy *and* wrote that over the cache. So `dirty` travels inside the cached
  copy now, and `load()` merges by vial id when it is set. The union is safe because ids
  are minted per device and never reused: the same id is the same tube, a different id is
  a different tube, so it can neither invent one nor drop one. What it must never do is
  settle a real disagreement — two devices claiming one slot both survive the merge and
  `validate()` refuses the save, because picking a winner silently is how a tube ends up
  somewhere nobody looks. Only the inventory merges; the tree and the rules are the lab's
  and are re-hydrated from the shared files.
- **A ref update refused because the branch moved is retried, not reported as a conflict.**
  `commitFilesAtomic` gave up on GitHub's "Update is not a fast forward", and the app told
  somebody standing at a freezer that *someone else saved first* — for a save nobody else
  was involved in. `main` moves on its own here (the daily export commits to it, phones
  commit to it, merged PRs land on it), so a second between the read and the write is
  enough. It re-reads the tip and rebuilds, up to `COMMIT_ATTEMPTS`; `base_tree` comes
  from the new tip, so everything committed in between is carried forward. A refusal that
  is *not* a moved branch (a 403, say) is never retried — it would only make the person
  wait longer for the same answer.
- **An empty slot in the sheet is not a vial.** Umut's workbook lists every position in a
  box and leaves the name blank where nothing is frozen there, so a line carrying a slot
  label and nothing else describes a space, not a tube whose name failed to read. Imported
  as vials, 144 of those became 144 permanent *"Fix"* entries in Review about rows where
  there was never anything to fix — and buried the one row that did need answering. The
  test is deliberately narrow, because the cost of getting it wrong is a tube going
  missing: the row is skipped only when the **name is blank and every other cell on the
  line is blank too**, position and box excluded (the position is the grid's own
  scaffolding, the box name repeats down the block). A date, a passage, a note, a facet, a
  column nobody mapped, an uncalculated formula — anything at all — and the row still comes
  in for Review. And whatever it *did* record now travels with it: that data used to be
  read only on the path where the row was fully understood, so a row with a date and no
  name arrived holding neither.
- **Anything the sheet did not say is surfaced, not filled in.** Ambiguous dates, missing passages,
  an implausible passage, a mixed row: all listed under Review for Umut to answer through the vial
  editor. A facet he pins by hand is never recomputed.
- **Nothing is repaired behind his back.** The import queues ambiguous dates rather than swapping
  them, reports every row where the corrected rules disagree with the sheet, and needs an explicit
  tick before it throws any row away. `#N/A` is not a value and is never imported as one.
- **Absolute and relative passages are separate scales.** `p+2` must never be comparable with `p2`,
  and the 68 vials marked `p?` must never vanish from a search without the UI saying so.
- **Light/dark is per device and lives in its own card.** `renderAppearance(target)` draws
  it on the login gate *and* at the top of Settings — it was buried at the bottom of
  Connect, under the worker URL, and nobody found it. It is `localStorage` only: how this
  phone looks is not a fact about the lab, and is never committed.
- **There is no messaging in this app, and that is deliberate.** Requests, notifications and
  editable message templates were all built and then removed at Umut's word ("toplu mesaj
  ozelligini tamamen kaldir", then all of it). A lab-mate's vial in a lab-wide search shows whose
  it is and exactly which slot it sits in, and nothing else — you go and ask the person. Do not
  reintroduce an in-app way to ask.
- **Three roles: member, admin, PI.** A member has their own inventory. Admin has none and has the
  tools. **A PI has no inventory of their own at all** — they read and search everyone else's and
  change nothing, which the worker enforces in `canWrite()` rather than trusting the app to hide
  the buttons. An unknown role is refused, never quietly demoted to member.
- **An import puts its boxes in the lab's file, not in the importer's.** A spreadsheet
  describes boxes, and `slim()` drops `storage` from a member's own file — so for a while
  the boxes an import created existed only in that browser: the next reload turned every
  imported vial into *"(unknown box)"* and `validate()` then refused to save the file at
  all. `adoptImportedBoxes()` moves them into `lab-storage.json` under `unplaced`, owned by
  whoever imported, with the sheet's own location kept as the box's note. The member's
  vials, their workbook and the tree go in **one commit**. The freezer the sheet names is
  *not* created: a member does not add units to everybody's tree.
- **The classification rules are the lab's, not an account's.** Every account started from the
  same defaults and then edited its own private copy, so the same cell name read differently
  depending on whose screen you were on — admin read `Du145 TOX4 KO` as a knockout, umut's copy
  as an overexpression. Umut asked for them merged and shared. They live in
  `cellstocks/lab-rules.json`; `slim()` strips `rules` from a member file and `hydrateRules()`
  puts them back at load, exactly as the tree does. Any member may edit them — adding the label
  for a cell everybody works with is the everyday action this replaced — and every change is
  committed with the affected workbooks in one commit. Do not put a copy back in a member file.
- **Merging rule sets is not concatenation.** A facet's rules are ordered and first-match-wins,
  so `mergeRuleSets` keeps a matcher's **first** position, reports a matcher that two accounts
  gave **different values** rather than settling it, and always sorts a catch-all (a bare
  `value`) **last** — anything after one is dead code. `tools/cellstocks-merge-rules.mjs` is the
  one-off that ran it, dry by default, and it prints every disagreement and every vial facet
  that would read differently. The one real conflict it found: `50CR` reads as `CisR` (admin's),
  not `50CR` (umut's) — flip it from Settings → Rules if that is the wrong way round.
- **A rule preview counts the whole lab, and waits until it can.** The rules are shared, so
  "this changes 0 vials" measured against your own inventory alone is a lie. Settings → Rules
  loads the lab first and the Add/Edit/Delete buttons stay disabled until it has.
- **A rule or an attribute name can be edited and deleted, not only added.** Both previews what it
  would do to the real inventory first (how many vials read differently, how many of those are
  pinned by hand and so do not move) — `ruleImpact()` in the app, over `E.classifyAll`. Deleting an
  attribute name only stops it being *suggested*; a value already recorded under it is never
  touched.
- **The app is at `https://cellstocks-worker.caalabworkersdev.workers.dev`, served by its own Worker,
  not from GitHub Pages.** `cellstocks-worker` has an
  `[assets]` binding over `cellstocks/`, so the page and the API are one origin: the address
  carries no GitHub username, and the app's own calls are same-origin, so CORS never applies
  to them. The old Pages address **redirects here** — first thing in `<head>`, before the
  manifest, so it never renders and never registers a service worker of its own. It cannot
  simply be unpublished: the whole repository goes to Pages and `.nojekyll` rules out
  excluding part of it. `ALLOWED_ORIGIN` still names the Pages origin, which costs nothing.
  `resolveConfig()` reads owner/repo out of an `*.github.io` address and falls back to
  `DEFAULT_REPO` anywhere else; `sw.js` derives its scope from `registration.scope` rather
  than testing for a literal `/cellstocks/`, which silently disabled it off Pages. The
  login gate offers the address the page came from ahead of whatever this device saved,
  because the `workers.dev` subdomain is an account setting that can change and would
  otherwise strand every saved copy of the old one.
  **The repository is still public, so the data still is** — this changed the address, not
  that. The real fix is a private repo with every read going through the Worker; Umut knows
  and chose the address for now.
- **The freezer's layout is exported every morning, in three shapes, and mailed.**
  `tools/cellstocks-export.mjs` writes `cellstocks/exports/layout.{xlsx,pdf,csv}` — a grid
  sheet per box, a printable map for the freezer door, and one row per box. The names never
  change: git keeps every previous morning, and a dated file would mean a new link daily.
  `cellstocks/pdf.js` is the PDF writer, dependency-free like `xlsx.js` beside it and just as
  minimal (one built-in font, Latin-1, so `Şişli` prints as `Sisli` — folded, never dropped).
  One GitHub Action at 05:00 UTC (08:00 Istanbul) builds, commits only when something
  changed, and mails. `tools/cellstocks-mail.mjs` speaks SMTP itself rather than using a
  ready-made action, because whatever sends this is handed the mailbox's app password on
  every run and **this repository is public**; it is tested against a fake server, and its
  error transcript redacts the credentials because it ends up in a public build log.
  Recipients live in `cellstocks/exports/recipients.json`, which admin edits under
  Admin → History & export and is the only path under `exports/` the worker lets the app
  write. No secret, or nobody on the list, skips the mail — it never fails the build and
  never claims to have sent something it did not.
- **The recipients file is cached after a commit, like the tree is.** Umut set the send
  time, removed an address, removed it again — and the third save wrote his old time back.
  The export card re-read `recipients.json` from raw.githubusercontent after committing,
  got the pre-change copy, and merged his next edit onto that. It is the freezers coming
  back, in a new place, and the merge made it worse by rebuilding fresh edits on stale
  state. `mailSettings` holds what was committed and the card only reads the file when it
  has never seen it. **After a commit, never re-read — anywhere.**
- **The daily mail's trigger is the Worker's Cloudflare cron, not GitHub's.** GitHub's
  scheduler has never once fired this repository's export workflow — not `0 5 * * *`, not
  the `5,35 * * * *` poll that replaced it, which missed three slots in a row on the
  morning of 7 Sep. I could not establish why. So `cellstocks-worker` has a `scheduled`
  handler that dispatches the workflow: Cloudflare's cron is a different scheduler, and
  the Worker already holds `GITHUB_TOKEN`, so no new credential goes anywhere. It
  dispatches with **`force=false`**, which means *check whether it is time* rather than
  *send now* — the workflow then runs `--check` and the app's own `sendAt` still decides.
  A Claude Routine was tried first and does not work: the sessions it fires have no GitHub
  tools, and its test firing dispatched nothing. **Do not put the send time in the cron**
  — the cron only asks, the workflow decides.
- **The mail is a poll, not a single daily fire, and the hour is data.** It was
  `cron: "0 5 * * *"` once, and the first morning it was due GitHub ran nothing at all:
  the top of the hour is its most contended slot and runs there are delayed or dropped.
  The cron is `5,35 * * * *` now and `shouldSendNow()` in `tools/cellstocks-mail.mjs`
  decides which poll is the day's send — so a skipped poll heals itself on the next one,
  which is the whole reason a fixed daily fire was wrong. **Never put the send time back
  into the workflow**: it lives in `recipients.json` as `sendAt`/`timeZone` because an
  admin sets it from the app, and the app can write that one file and must never be able
  to write a workflow. `last-mailed.json` is the one bit of state, written by the Action
  only after the server accepted the message — a failed send is deliberately not recorded,
  so the next poll retries.
- **Another lab gets a generated template, never a copied folder.**
  `tools/cellstocks-template.mjs` builds a blank standalone tree out of the live files and
  tars it; the two documents that only exist in the template (a Turkish setup `README.md`
  and its own `CLAUDE.md`) live in `tools/cellstocks-template/`. A checked-in second copy
  of `index.html` would go stale the first time the real one was fixed. Every substitution
  it makes is asserted and the built tree is grepped for our identifiers, because the one
  that matters is the GitHub Pages redirect: left in, a new lab's users get bounced onto
  our Worker and log in against our freezer. It runs the four suites inside the built tree
  before writing an archive.
- Only Umut's own `UMUT -80` sheet is in the app. The other nine people's sheets in that shared
  workbook are out of scope — this repository is public, and that is their call, not ours.
- New cryopreservation facts — how long a vial keeps, a medium, a preference, a correction — get
  written down the same as anything else, into the table above.
