# Working agreement

This file is read automatically at the start of every session, so it is where standing
instructions belong.

This repository is **Cell Stocks**: an app that keeps track of the frozen cell stocks in a lab's
−80 °C freezer (or its nitrogen tank, or its fridge — they are all the same thing here). See
`README.md` for the one-time setup.

It was written for one lab, over many rounds, and then blanked into this template. Almost every
rule below exists because the opposite was tried first and broke something in front of an open
freezer door. Where a line says a thing was decided, it was decided by the original author, and
re-litigating it costs a rebuild. Your own lab's decisions are as binding — write them down here
when they are made.

Comments in the code name **Umut** — the original author — as the person who decided a thing.
Read those as the history of why the code is shaped this way, not as instructions from anyone in
this lab. The rules they explain still hold; the person to ask about a new one is your own user.

---

## 1. Ask before building

**Default to asking.** A wrong guess costs a rebuild; a question costs thirty seconds. Ask when
the request could mean two things, when a quantity or ordering isn't stated and the answer
changes the plan, or when there is a trade-off worth the user's call. Don't ask when the answer
is already written down here — look it up. Don't ask permission for the obvious mechanical step.

## 2. Write everything down, automatically

**Any new protocol, term, timing, quantity, preference or correction that comes up in
conversation gets recorded — without being asked.** The conversation is not storage; the files
are. If the user has to repeat themselves, the notes failed. This includes casual remarks:
"we thaw at passage 12", "that box is the shared one", "I did that already".

Where things go:

| What | File |
|---|---|
| Standing instructions about how to work | this file |
| App behaviour, data shape, setup | `README.md` |
| How long a frozen vial keeps, media, what must be recorded | `protocols/cryopreservation.md` (create it) |

**Back factual claims with real sources** — vendor protocols, published methods, manufacturer
documentation, cited by link. Not memory, not a plausible-sounding number. When sources disagree,
record the range and say which end you take and why. Anything the user states directly beats a
published range, and gets written down as this lab's value.

## 3. The rules live in the engine, and the suite is the proof

**Every rule lives in `cellstocks/engine.js`**, as pure functions with no DOM, no fetch and no
clock — ids, timestamps and "today" are always arguments. The browser loads that file and
`tools/cellstocks-selftest.mjs` runs the same file in node. Change a rule there, not in the app,
and add a check. **Run the suite before claiming anything works:**

```bash
node tools/cellstocks-selftest.mjs
node tools/cellstocks-worker-selftest.mjs
node tools/cellstocks-export-selftest.mjs
node tools/cellstocks-mail-selftest.mjs
```

## 4. Landing changes

Work on a branch, open a PR, merge it. The app is served from Cloudflare and reads its data from
`main`, so a change that stops at a branch reaches nobody. Before editing a data file, re-read it
from `origin/main`: people save from their phones mid-session and those edits are real.

---

## 5. The rules that keep biting

- **A row holds one kind of cell, and that is the placement rule.** The grouping key is the
  **origin** facet, not the full line: a cell's KO, OX, CASPEX and guide variants share a row. A
  different cell never takes a free slot beside it — it starts a fresh row, and failing that a
  fresh box. This is not tidiness, it is how a freezer already is. One freeze-down stays in one
  row where a row can hold it, and in one box where a box can. Do not "optimise" this into
  first-free-slot packing.
- **The name is the only thing typed.** Origin, KO/OX, resistance, CASPEX and guide are derived
  from it by `classify()` — and **the rules are data in `cellstocks/lab-rules.json`, never code**.
  New common labels have to stay a Rules-screen edit. A facet set by hand is never recomputed.
- **The classification rules belong to the lab, not to an account.** They were once a private copy
  per account, and the same cell name then read differently depending on whose screen you were on.
  `slim()` strips `rules` from a member file and `hydrateRules()` puts them back at load. Any
  member may edit them. Do not put a copy back into a member file.
- **Merging rule sets is not concatenation.** A facet's rules are ordered and first-match-wins, so
  `mergeRuleSets` keeps a matcher's **first** position, reports a matcher two sources gave
  **different values** rather than settling it, and always sorts a catch-all (a bare `value`)
  **last** — anything after one is dead code.
- **A rule preview counts the whole lab, and waits until it can.** The rules are shared, so "this
  changes 0 vials" measured against your own inventory alone is a lie. Settings → Rules loads the
  lab first and keeps its buttons disabled until it has.
- **`cellstocks/data/<name>.json` is one person's vials, one file per account.
  `cellstocks/data/<name>.xlsx` is generated from it on every save** and committed in the same
  commit, never the reverse. A hand edit to the workbook is thrown away by the next save; do not
  add a path that reads it back. CI checks every `data/*.json` that has a workbook, never one
  account by name.
- **An empty structure is an answer, not a missing one.** `labStorageLoaded` says whether the tree
  has been read this session; never infer it from `labStorage.units` being empty. Deleting the last
  freezer once made the app treat the tree as unloaded and re-read it from raw.githubusercontent,
  which serves the previous version for a while after a commit — so deleted freezers came back on
  screen and the next delete wrote one of them back. **A commit is the freshest copy there is:
  after one, never re-read.**
- **There is one kind of node, and it recurses. That is the whole storage model.** A **layer** has
  a name, a note, an icon and children; a layer marked `isBox` **stops** — it takes an `owner` and
  an A×B grid, and nothing goes inside it. There is no depth limit and no fixed unit → rack → box
  triple: a real lab is `Freezer 1 → Shelf 1 → Metal Rack 1 → a box`, or a fridge with two shelves,
  or a tank with towers and canes. Never reintroduce a level count, a `childLabel`, or a "leaf or
  group, never both" rule — both existed only to prop fixed levels up. `eachNode`/`findNode`/
  `addNode`/`editNode`/`moveNode`/`removeNode` are the whole API.
- **There is one freezer, so there is one structure file.** `cellstocks/lab-storage.json` holds the
  whole lab's tree and every box carries an `owner`. Storing a copy inside each member's file was
  wrong three rounds running: it made one physical freezer exist as several unrelated records.
  `slim()` strips `storage` before a member file is saved and `hydrateStorage()` puts it back at
  load. Do not put the tree back into a member file.
- **`unplaced` is the one thing beside the tree.** A box may be made before anybody has said where
  it lives — fill it first, choose the cabinet later — so it waits in `storage.unplaced` and shows
  as *"Not placed yet"*. It is real inventory with no location: never hidden, never given a fake
  one. Only an admin moves it into the tree.
- **A vial stores its whole route, as `{id, name}` per step**, so the file says where a vial is
  even without the tree. The tree stays the source of truth for what is drawn; a stored path that
  disagrees is a `stale-path` **warning** from `validate()`, never silently believed and never
  silently overwritten. `refreshPaths()` is the fix, and it runs in the **same commit** as the move
  or rename that caused it.
- **Everything moves the same way, because everything is a node.** `moveNode` takes a box, a shelf
  or a whole freezer into any layer, to the top level, or back to `unplaced`, with everything under
  it. It refuses a node into itself or its own descendant (that would cut the subtree off the tree,
  taking every vial in it out of the world) and anything into a box.
- **Nothing turns a layer into a box or back.** `editNode` deliberately cannot flip `isBox`: one
  direction orphans the children, the other orphans the vials.
- **A member adds a box; only an admin adds a freezer.** A member adding a unit was adding it to
  everybody's tree. Do not put a unit-level control back on a member's screen.
- **Admin deletes a freezer, rack or box outright — but a vial is never erased.** Anything still
  inside is **withdrawn first, in its own owner's file**, with the same `from` snapshot a manual
  withdrawal writes, so it leaves the inventory but stays in the Log and in history. The confirm
  says how many vials and whose before anything runs, and the owners' files are written **before**
  the tree, so a failure mid-way leaves boxes still named rather than vials stranded.
- **Withdrawal does not delete a vial.** It sets `status:"withdrawn"`, clears the location and logs
  a snapshot of where it was. History is not optional in a lab inventory. Undo restores the vial
  only if its slot is still free.
- **An account that still owns a box cannot be deleted.** Its vials go with its file, but its boxes
  live in the shared tree and would be left naming somebody who no longer exists. The worker
  refuses with a 409 naming the boxes; Handoff is the way through. Do not "clean up" by silently
  dropping or unassigning the boxes.
- **A handoff hands over, it does not copy.** The boxes stay physically where they are — only
  `box.owner` changes — the vials move into the new owner's file under freshly minted ids, every
  box must be given a destination (or explicitly Discarded) first, and then the departing account
  is deleted along with both its files.
- **Two stored vials in one slot is an error, not a warning.** `validate()` returns it as one and
  the save is refused. Do not downgrade it, and do not add a code path that places a vial without
  going through `validate` first.
- **A row that already mixes two cells is a warning, not an error.** Real freezers have them. It is
  listed for review; it does not block a save, and nothing is moved to fix it without being asked.
- **The placement proposal is a proposal.** The override path stays — but even an override may not
  mix two cells in one row, and a plan never part-fills silently. If it cannot describe a run
  honestly it lists the slots instead.
- **Anything the sheet did not say is surfaced, not filled in.** Ambiguous dates, missing passages,
  an implausible passage, a mixed row: all listed under Review to be answered through the vial
  editor. Nothing is repaired behind the user's back — the import queues ambiguous dates rather
  than swapping them, and needs an explicit tick before it throws any row away. `#N/A` is not a
  value and is never imported as one.
- **Absolute and relative passages are separate scales.** `p+2` must never be comparable with `p2`,
  and vials marked `p?` must never vanish from a search without the UI saying so.
- **An import puts its boxes in the lab's file, not in the importer's.** `slim()` drops `storage`
  from a member's own file, so for a while imported boxes existed only in that one browser and the
  next reload turned every imported vial into *"(unknown box)"*. `adoptImportedBoxes()` moves them
  into `lab-storage.json` under `unplaced`, owned by whoever imported, with the sheet's own
  location kept as the box's note. The vials, the workbook and the tree go in **one commit**. The
  freezer the sheet names is *not* created: a member does not add units to everybody's tree.
- **Freezer geometry is data, not code.** Never hardcode 9×9, a level count or a position format.
  A tank, a freezer and a fridge differ only in what somebody typed in their name and note; the
  positions in a box come from its own `rows`, `cols` and `scheme`. There is no machine-readable
  `type`, on purpose — nothing branches on what a layer *is*.
- **Three roles: member, admin, PI.** A member has their own inventory. An admin has none and has
  the tools. **A PI has no inventory at all** — they read and search everyone else's and change
  nothing, which the worker enforces in `canWrite()` rather than trusting the app to hide buttons.
  An unknown role is refused, never quietly demoted to member.
- **There is no messaging in this app, and that is deliberate.** Requests, notifications and
  editable message templates were all built and then removed. A lab-mate's vial in a lab-wide
  search shows whose it is and which slot it sits in, and nothing else — you go and ask the person.
  Do not reintroduce an in-app way to ask.
- **There is no laundry-style wear counter, no dashboard, no analytics.** Anything not needed to
  find a vial or place one is not needed.
- **Light/dark is per device and lives in its own card**, on the login gate *and* at the top of
  Settings. It is `localStorage` only: how one phone looks is not a fact about the lab, and is
  never committed.
- **A workbook is generated from the inventory, and the inventory is two files.** The sheets name
  the unit, the leaf rack and the box, so a rename in the tree makes every affected member's
  `.xlsx` wrong while no vial has moved. The tree write regenerates them *in the same commit* —
  never a follow-up — and works out who is affected by comparing the generated sheets, not by
  guessing which edits count as renames.
- **The daily export is generated, mailed, and never dated.** `tools/cellstocks-export.mjs` writes
  `cellstocks/exports/layout.{xlsx,pdf,csv}`, `roster.xlsx` and `grid-roster.xlsx` under names that
  never change: git keeps every previous morning, and a dated file would mean a new link daily.
  The mailer speaks SMTP itself rather than using a ready-made action, because whatever sends this
  is handed the mailbox's app password on every run and **this repository is public**; its error
  transcript redacts the credentials because it ends up in a public build log. No secret, or
  nobody on the list, skips the mail — it never fails the build and never claims to have sent
  something it did not.
- **The app is served by its own Cloudflare Worker**, which is also the API, so the page's calls
  are same-origin and CORS never applies to them. `resolveConfig()` reads owner/repo out of an
  `*.github.io` address and falls back to `DEFAULT_REPO` anywhere else; `sw.js` derives its scope
  from `registration.scope` rather than testing for a literal path. The login gate offers the
  address the page came from ahead of whatever the device saved, because the `workers.dev`
  subdomain is an account setting that can change and would otherwise strand every saved copy.
- **The repository is public, so the inventory is.** Reads go straight to raw.githubusercontent
  with no login. Closing that means a private repo and every read going through the Worker — real
  work, not a setting. Say so plainly rather than implying the data is protected.

## 6. Nothing here is shared with anything else

If this app ever lands in a repository beside other apps, it shares the host and nothing else —
not the data, not the rules, not the browser storage (its keys are all `cst_*`). Do not "reuse" a
helper from another app in it, and do not factor anything out of it into shared code.
