# Yahoo transactions: detailed ingestion and recovery

**Status:** code only. Nothing here has been run against production. The
907 rows the first sync stored are untouched until a commissioner runs the
dry run, reviews it, and separately applies it.

## How Antlerboard represents a transaction

| Concept | Where it lives |
|---|---|
| A transaction | `Transaction`: season, `type`, `date`, `notes`, provenance (`yahooTransactionId` for the sync, `sourceRef` for imports) |
| Yahoo's own record | `Transaction.yahooType` (`add`, `drop`, `add/drop`, `trade`, `commish`), `yahooStatus` (e.g. `successful`), `faabBid`, `dateUnavailable`, `yahooDetailIssues`, `yahooDetailSyncedAt`. **New in this change.** |
| Players moved | `TransactionPlayer`, one row per player. New columns: `action` (`add` / `drop` / `trade`), `sourceType` / `destinationType` (`freeagents`, `waivers`, `team`), `sourceTeamId` / `destinationTeamId`, `yahooPlayerKey` |
| Teams involved | `TransactionTeam` (`FROM` / `TO`), as before |
| Both halves of an add/drop | One `Transaction` (typed by the add: `WAIVER_ADD` or `FREE_AGENT_ADD`) with two `TransactionPlayer` rows: `action: add` and `action: drop` |
| Waiver claim vs free-agent add | `WAIVER_ADD` when Yahoo's add came from `waivers`, `FREE_AGENT_ADD` when from `freeagents`. Any other source is not typed (see below) |
| Commissioner moves | The existing `COMMISSIONER_CORRECTION` type, with `yahooType = "commish"` (Yahoo's own type, verbatim). The UI labels these "Commissioner move", and Antlerboard's own corrections (`yahooType` null) still read "Correction". Previously a free-agent add. Yahoo usually sends no players for these |
| Trades | `TRADE`, both teams as `FROM` + `TO`, each player with their own source and destination team |
| FAAB | `Transaction.faabBid`, only when Yahoo sends `faab_bid` (absent on $0 claims and free-agent adds) |
| Transaction ↔ Acquisition | Separate. `Acquisition` drives keeper costs. The league-history import writes adds/trades there and drops to `Transaction`. **The Yahoo sync writes `Transaction` only, never `Acquisition` or `KeeperRecord`** (unchanged; see open decisions) |
| Imported history | `Transaction.sourceRef` rows (`league-history:…`) and their links are untouched. The import's inferred "not kept into YYYY" releases keep their Dec 31 dates; the UI now labels them as releases at season's end |

## Defects fixed

| Defect (production evidence) | Fix |
|---|---|
| Sync wrote no players or teams: all 907 2026 rows unlinked | Parses `players` and each player's `transaction_data`; links players by Yahoo id and teams by Yahoo team key |
| `add/drop` stored as an add, losing the drop (347 rows) | Both players recorded with their `action` |
| Waiver vs free agent never distinguished; FAAB never stored | From `source_type`; `faab_bid` stored |
| `commish` and any unknown type silently became `FREE_AGENT_ADD` | `commish` → `COMMISSIONER_CORRECTION` + `yahooType "commish"`; unknown types and adds with an unknown source are **not written**, counted, and make the run PARTIAL |
| Missing timestamp silently became "now" | Stored with `dateUnavailable = true`; the UI shows "date unknown" |
| One unpaged request; no proof the log was complete | Paged with `;start=N;count=25` until a page adds nothing (works whether Yahoo honors, caps or ignores paging). A failed later page or the 200-page cap marks the run incomplete |
| A response without a `transactions` field read as "0 new", still SUCCESS | Unreadable first page is an error |
| Keyless entries dropped silently | Counted |
| Existing rows never updated | Upsert on `yahooTransactionId`: status, type, date, FAAB and links update; unchanged rows are not written |
| Any of the above reported as SUCCESS | Every problem becomes the `transactions` section's error, so the run is PARTIAL (FAILED if every section fails). Counts and examples go in `SyncLog.detail` |

What is never done: matching teams by name, linking a player by name, moving a
row to another season, deleting a stored link (a link Yahoo no longer reports
is kept and flagged), or touching a row synced before this change (`yahooType`
null). Those rows are counted as "awaiting recovery", which keeps the daily sync
PARTIAL until they're recovered. That's deliberate: they're known to be incomplete.

A Yahoo player id no Antlerboard player has gets a new Yahoo-linked `Player`
(as the roster sync already does), unless an unlinked player with the same name
exists; then nothing is linked and the row is flagged.

## The recovery (two separate steps)

Both steps use the stored access token **without refreshing it**, and both are
refused on deployments without the Yahoo env vars (verified 2026-10-16:
`YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET` and `YAHOO_REDIRECT_URI` are scoped to
Production only, while the database URL is shared with Preview).

- **Dry run** - `GET /api/commissioner/yahoo-transaction-recovery?season=2026`
  (`&leagueKey=…` for another Yahoo league; default is the connected one).
  - **Database writes: none.** Only `find`/`count` queries: the commissioner
    check, the season, the target rows, players, teams.
  - **Token:** it reads the stored access token and refuses (409) if fewer than
    30 s remain. A 401 from Yahoo is not retried with a refresh.
  - **Side effects:** about 40 Yahoo GETs at a 500 ms pace. These count toward
    Yahoo's rate limit, so don't run it back to back with a Sync Now or a
    history export. Failed Yahoo responses are logged to the function log, with
    the token redacted (`diagnostics.ts`).
- **Apply** - `POST` the same URL with
  `{ "season": 2026, "fingerprint": "<reviewed>", "confirm": "APPLY_YAHOO_TRANSACTION_RECOVERY" }`.
  1. Re-reads Yahoo and rebuilds the plan. Refuses (409, nothing written) if
     the fingerprint differs or Yahoo's log wasn't read to the end.
  2. Writes a `YAHOO_TRANSACTION_RECOVERY_STARTED` audit entry.
  3. For each `ready` record, in key order, in its own database transaction:
     re-reads the stored row. It writes only if the row is still exactly the
     reviewed one (same id, season, type, date, notes, still legacy, no links)
     and the write is still clean (no issues, same season). Otherwise it skips
     the record and names it.
  4. Stops starting new records after 200 s (the route allows 300 s) and
     reports `notAttempted`.
  5. Writes a final `YAHOO_TRANSACTION_RECOVERY` audit entry with the counts
     and every skipped or failed key.

### What the fingerprint binds

`sha256` over `{v: 2, leagueKey, seasonYear, ready: [...]}`. For every ready
record, in key order, it covers:

- **the stored row it was planned against:** id, seasonId, type, date, notes,
  link counts;
- **the full plan the apply step writes:** type, Yahoo type, status, date,
  FAAB, every team link (team id + role), and every player link (player id or
  "create", Yahoo key/id, name, MLB team, positions, action, source and
  destination types and team ids).

Any change to any of it changes the fingerprint: Yahoo's data, a team re-linked
to another Yahoo key, a player created or linked in the meantime, or a hand
edit to a target row. Records that aren't `ready` are never written, so they
are not part of it. Order doesn't matter: the same data in a different Yahoo
order gives the same fingerprint (tested).

Partial runs: records written before a failure or the time limit stay written
(each is atomic). A new dry run then shows only what's left. Re-running the
**old** fingerprint is refused, because the plan changed. That's intended:
review the remainder, then apply its new fingerprint.

### Dry-run report format

```jsonc
{
  "mode": "dry-run",
  "leagueKey": "469.l.8891", "seasonYear": 2026, "generatedAt": "…",
  "yahoo": { "pages": 43, "transactionsRead": 907, "entriesWithoutKey": 0, "complete": true, "incompleteReason": null },
  "targets": 907,                       // stored rows with no detail yet
  "summary": { "ready": 0, "unresolved": 0, "unsupported": 0, "malformed": 0, "missing_in_yahoo": 0, "not_checked": 0 },
  "proposedTypes": { "WAIVER_ADD": 0, "FREE_AGENT_ADD": 0, "DROP": 0, "TRADE": 0, "COMMISSIONER_CORRECTION": 0 },
  "playersToCreate": [{ "yahooPlayerId": "12345", "name": "…" }],
  "onlyInYahoo": ["469.l.8891.tr.…"],  // not stored at all - the daily sync adds these, recovery doesn't
  "fingerprint": "<sha256 of exactly what applying writes - see above>",
  "records": [{
    "yahooTransactionId": "469.l.8891.tr.6",
    "status": "ready",                 // or unresolved / unsupported / malformed / missing_in_yahoo / not_checked
    "current":  { "type": "FREE_AGENT_ADD", "date": "…", "notes": "Synced from Yahoo (add/drop)", "seasonYear": 2026 },
    "proposed": { "type": "WAIVER_ADD", "yahooType": "add/drop", "yahooStatus": "successful", "date": "…",
                  "dateUnavailable": false, "faabBid": 4,
                  "teams":   [{ "teamId": "…", "teamName": "Ranger Thingz", "role": "TO" }],
                  "players": [{ "name": "…", "yahooPlayerKey": "469.p.…", "yahooPlayerId": "…", "playerId": "…",
                                "createsPlayer": false, "action": "add", "from": "waivers", "to": "Ranger Thingz" }] },
    "issues": []
  }]
}
```

The counts above are placeholders; only a real dry run can fill them in.

| Status | Meaning | Applied? |
|---|---|---|
| `ready` | Parsed, every team and player matched by Yahoo key | Yes |
| `unresolved` | Read, but a team key isn't linked, a player is ambiguous, or Yahoo's record lacks something (see `issues`) | No |
| `unsupported` | Yahoo type, or an add's source, can't be mapped | No |
| `malformed` | Yahoo's entry couldn't be read | No |
| `missing_in_yahoo` | Yahoo's **complete** log doesn't have this key | No |
| `not_checked` | The log wasn't read to the end, so absence proves nothing | No |

## Authorization needed to read the Yahoo source

- A commissioner session on **production** (`requireCommissioner`, plus the Yahoo env vars present).
  The dry run (GET only) also accepts the dedicated `RECOVERY_DRYRUN_TOKEN`
  bearer token used by the scheduled read-only preflight; see
  [recovery-preflight-automation.md](recovery-preflight-automation.md). The
  apply (POST) accepts only the commissioner's session.
- The league's stored Yahoo connection (`469.l.8891`) with an **unexpired access token**.
- The Yahoo app's Fantasy Sports API approval (in place: the daily sync works).

No new Yahoo credentials or scopes are needed. Nobody needs to see or copy a
Yahoo token.

### Getting a fresh token (facts, 2026-10-16)

- **Yahoo tokens last one hour.** The 12:00:38 UTC sync stored a token that
  expired at 13:00:38 UTC.
- **There is no read-only way to get a new one.** Refreshing always writes the
  new access token, and possibly a rotated refresh token, to `YahooConnection`
  (`getValidAccessToken`). Skipping that write would break the next sync.
- **Only two things refresh it:**
  - **The scheduled daily sync** (cron `0 12 * * *`). It has fired at 12:56 UTC
    on Oct 15 and 12:00 UTC on Oct 16; Vercel Hobby runs it at some point
    within the hour. It refreshes the token because the old one has long
    expired.
  - **A commissioner's Sync Now.** That is a production sync, so it needs your
    approval.
- **Recommended:** let the scheduled sync refresh the token. Nothing extra
  writes to production, and the token window opens when that sync finishes.

### How to check the window, without exposing the token

Read-only:

```sql
SELECT now(), "tokenExpiresAt", "lastSyncAttemptAt", "lastSyncStatus"
FROM "YahooConnection";
```

- **Start the dry run with at least 5 minutes left.** It takes about 30–60 s.
- **Start the apply with at least 10 minutes left.** It re-reads Yahoo
  (~30–60 s), then makes up to ~907 small writes.
- **If time runs out, nothing breaks.** Either step answers 409 and the work
  waits for the next day's window. A fingerprint stays valid across days as
  long as nothing it binds has changed. The 2026 season is over, so Yahoo's log
  shouldn't change.

## Production rollout

### What the migration does

The migration is `20261016200000_yahoo_transaction_detail`, applied by
`scripts/build.sh` (`prisma migrate deploy`) **only on production builds,
before `next build`**:

- **no enum change**: every type the new code writes (`WAIVER_ADD`,
  `FREE_AGENT_ADD`, `DROP`, `TRADE`, `COMMISSIONER_CORRECTION`) already exists;
- 6 nullable or defaulted columns on `Transaction` (`dateUnavailable` defaults
  to `false`, `yahooDetailIssues` to `{}`);
- 6 nullable columns on `TransactionPlayer`.

No existing row's values change. As of 2026-10-16 production's last migration
is `20261014180000_add_roster_spots`.

### Can code reach the new columns before the migration?

- **Production: no.** The migration runs during the build, before the new code
  is promoted. While it builds, the old deployment keeps serving; its Prisma
  client names only the columns it knows, so the new columns are invisible to
  it. If the build fails after migrating, the old code keeps working against
  the additive schema.
- **Previews: yes.** They run this branch against the production database
  without migrating it. Pages that read `Transaction` (home, Transactions,
  team activity, player history) error on the PR's preview. Every write path
  is closed there: no cron runs on previews, and Sync Now and both recovery
  steps refuse without the Yahoo env vars.

### Rollback

**Code: an instant rollback is safe at any point.** That covers after the
first new sync and after the recovery.

- **Verified:** I migrated a local database with this PR, wrote every shape the
  new code produces through the real sync and recovery paths, and read it back
  with the Prisma client generated from production's current build (`b5f50bb`):
  - the shapes: waiver add with FAAB, free-agent add, add/drop, drop, trade,
    commissioner move, pending status, undated and incomplete rows, recovered
    add/drop, recovered commish move, and created players;
  - the queries: the ones its Transactions page, home page, team activity,
    player history and keeper sync run, plus every column of every row.

  All succeeded. The old build simply ignores the new columns. It labels a
  Yahoo commissioner move "Correction" and shows a recovered add/drop by its
  add type, which is less detail but no error.
- **History:** an earlier draft added a `COMMISSIONER_MOVE` enum value, which
  the old client can't read (`Value 'COMMISSIONER_MOVE' not found in enum
  'TransactionType'`). That value was removed for this reason.

**Data written by the recovery** is undone by restoring from the Neon backup
branch taken just before the apply. That is the simplest and complete option.
Every recovered row is also identifiable: `yahooType IS NOT NULL` on a row
whose `yahooDetailSyncedAt` falls inside the apply's audit-entry window.

**Schema: the migration is reversible, and reversing it isn't needed.**

- **It's purely additive:** 12 new columns, no enum or constraint changes, no
  data rewritten. Old code works with it in place, so a code rollback needs no
  schema change.
- **If the columns ever had to go,** a forward migration dropping them would
  do it. It isn't lossless, though: it discards the recovered detail, so take
  a backup first.
- **Prisma has no automatic down-migration here.** Either way it is a new,
  reviewed migration, not an undo.

### Order of operations (each production step waits for your approval)

| # | Step | Writes to production? |
|---|---|---|
| 1 | You approve and merge PR #35 | Merge only |
| 2 | Take a Neon backup branch **before** the production build; record its id | New branch, `main` untouched |
| 3 | Vercel builds production: migration, then build, then promote | **Schema (additive)** |
| 4 | Verify the deploy (queries below) | No |
| 5 | Wait for the next scheduled sync (12:00–12:59 UTC). It runs the new sync code: refreshes the token, adds any Yahoo transactions not stored yet, may create Yahoo-linked players for them, leaves the 907 alone, and ends **PARTIAL** ("awaiting recovery") | **Yes - the scheduled sync** |
| 6 | Commissioner runs the dry run on production within that token window; saves the JSON | No |
| 7 | Review the report together; you approve the fingerprint in writing | No |
| 8 | Neon backup branch immediately before applying; record its id | New branch |
| 9 | Commissioner POSTs the apply in a token window, at least 10 min before expiry, and not while a sync is running | **Yes - recovery** |
| 10 | Verify (below) | No |

### Verification (read-only)

```sql
-- Deploy (step 4)
SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 1;
SELECT count(*) total, count(*) FILTER (WHERE "yahooTransactionId" IS NOT NULL) yahoo,
       count(*) FILTER (WHERE "yahooTransactionId" IS NOT NULL AND "yahooType" IS NULL) legacy
FROM "Transaction";                                  -- expect 5023 / 907 / 907 before step 5

-- First new sync (step 5)
SELECT status, detail FROM "SyncLog" ORDER BY "startedAt" DESC LIMIT 1;
-- transactions.counts: legacyAwaitingRecovery = 907, created = new Yahoo-only keys, writeErrors = 0

-- After the apply (step 10)
SELECT "yahooType", type, count(*) FROM "Transaction" WHERE "yahooTransactionId" IS NOT NULL GROUP BY 1,2;
                                                     -- matches the report's proposedTypes for ready records
SELECT count(*) FROM "Transaction" t WHERE "yahooType" IS NOT NULL AND "yahooType" <> 'commish'
  AND NOT EXISTS (SELECT 1 FROM "TransactionPlayer" p WHERE p."transactionId" = t.id);   -- expect 0
SELECT count(*) FROM "Transaction" t WHERE "yahooType" = 'trade'
  AND (SELECT count(DISTINCT "teamId") FROM "TransactionTeam" x WHERE x."transactionId" = t.id) < 2;  -- expect 0
SELECT count(*) FROM "Transaction" t WHERE "yahooType" = 'add/drop'
  AND NOT EXISTS (SELECT 1 FROM "TransactionPlayer" p WHERE p."transactionId" = t.id AND p.action = 'drop');  -- 0 unless flagged
SELECT count(*) FROM "Transaction" WHERE "yahooTransactionId" IS NOT NULL AND "yahooType" IS NULL;
                                                     -- = the report's non-ready count
SELECT (SELECT count(*) FROM "Acquisition"), (SELECT count(*) FROM "KeeperRecord"),
       (SELECT md5(string_agg(id || type::text || date::text, ',' ORDER BY id)) FROM "Transaction" WHERE "sourceRef" IS NOT NULL);
                                                     -- identical before and after (5436 / 5064 on 2026-10-16)
SELECT action, after FROM "AuditLogEntry" WHERE action LIKE 'YAHOO_TRANSACTION_RECOVERY%' ORDER BY "createdAt";
```

**Against the source:** open 10 recovered transactions on Yahoo's own league
transaction page and compare each one: teams, players, add or drop, FAAB, date.
Pick them at random, including at least one trade, one add/drop and one
commissioner move.

**Pages, signed in on production:**

- `/league/transactions`: the "Incomplete" banner shows only the non-ready
  count; recovered rows show players, teams, FAAB and "dropped …".
- The home page "Recent Transactions": same wording.
- `/teams/<id>` → Activity: that team's recovered moves appear.
- `/players/<id>` for a player in a recovered add/drop: the history says
  "Added (Waiver add, $N FAAB)" or "Dropped". **Keeper information on the page
  doesn't change** (see Keeper costs below).
- Commissioner → Yahoo after the next scheduled sync: **SUCCESS** if nothing is
  left to recover, otherwise PARTIAL naming what's left.

## Keeper costs and 2026 in-season moves

- **How keeper history is built.** The keeper engine reads `Acquisition` rows
  (stint starts and trades) and `Transaction` rows of type `DROP` with linked
  players (stint ends) (`keeper-sync.ts`).
- **What the import stored for 2026.** For 2026, `Acquisition` holds only the
  auction (204) and offseason trades (29). There are no 2026 waiver,
  free-agent or in-season trade acquisitions, because the 2026 log was the
  sync's and never reached the import.
- **The gap in production (2026-10-16), across the 413 current roster spots:**

  | Roster spots | Latest `Acquisition` for that player |
  |---|---|
  | 164 | The rostered team |
  | 197 | Another team |
  | 52 | None at all |

  Keeper records stop at 2026 (324 rows); none exist for 2027.
- **Defect found in this audit, and fixed in this PR.** Without a guard, every
  recovered or newly synced Yahoo `DROP` (216 rows) would have started ending
  stints in keeper history. The matching in-season adds and trades still
  wouldn't exist, and the drop halves of add/drops (typed as adds) wouldn't
  count. That would have been a silent change to keeper costs and eligibility.
  Keeper history now reads only drops with `yahooTransactionId IS NULL`
  (`KEEPER_HISTORY_DROP_WHERE`), in `keeper-sync.ts` and the History page.
  Verified on production data: all 4,116 drops with player links have no Yahoo
  id and the 216 Yahoo drops have no links, so **nothing changes today**. A
  test shows the guard keeps a player's events and keeper records identical
  after a recovered drop is linked, and fails without it.
- **Smallest safe options for the gap (none implemented, all need your
  decision):**
  1. **Leave it** (current behavior): 2026 in-season moves don't affect keeper
     costs until 2027 keeper work starts.
  2. **Derive in-season acquisitions from the recovered transactions,** in one
     reviewed, idempotent, dry-run-first step:
     - waiver adds become `WAIVER` acquisitions at their FAAB cost;
     - free-agent adds become `FREE_AGENT` acquisitions;
     - trades become `TRADE` acquisitions;
     - and all Yahoo drops are counted together.

     This changes 2027 keeper costs, so it needs your rules first: how FAAB
     maps to cost, how FYPD call-ups are handled, and which of the 197 and 52
     mismatches are expected.
  3. **Commissioner-entered corrections** for the players that matter at the
     2027 keeper deadline only.

## Verified facts vs assumptions

**Verified** (production reads, 2026-10-16, or tests):

- **The 907 legacy rows:** 907 Yahoo rows, all `469.l.8891`, one season, none
  with links.
- **Teams and players:**
  - all 12 teams are linked with `469.l.8891.t.N` keys;
  - no two players share a canonical Yahoo id;
  - 98 players have no Yahoo id (their names would block player creation and
    show as unresolved).
- **Token and env vars:**
  - the token expires an hour after each sync;
  - the cron fired at 12:56 and 12:00 UTC;
  - the Yahoo env vars are Production-only;
  - the migration isn't applied.
- **Rollback:** production's current client (`b5f50bb`) reads every type and
  every column the new code writes (tested locally against a migrated
  database).

**Assumed, not verified against live Yahoo responses** (no valid token was
available, and Yahoo's documentation site is unreachable from the build
environment):

- **Team-key field names:** `source_team_key`, `destination_team_key`,
  `trader_team_key` and `tradee_team_key` appear in real responses. They come
  from Yahoo's schema as two client libraries model it (`yfpy`,
  `yahoo-fantasy`). The repo's own real-export notes confirm team *names*,
  `faab_bid`, `type`, `status` and `timestamp`.
- **Paging:** Yahoo honors `;start;count` on this league. The code is correct
  if it doesn't, but the request count assumes it does.
- **Status values:** completed moves report `status: "successful"`.
- **FAAB:** `faab_bid` is absent on $0 and free-agent claims.

**The dry run is the test of each assumption.** If team keys are missing,
every record comes back `unresolved` with "Yahoo gave no team key", before
anything is written.

## Open decisions

1. **Commissioner moves (decided):** stored as `COMMISSIONER_CORRECTION`, with
   `yahooType = "commish"`, so a code rollback stays safe.
2. **2026 in-season acquisitions and keeper costs:** the options are listed
   above. Behavior stays as it is today until you choose.
3. **Players to create.** Recovery creates Yahoo-linked players for Yahoo ids
   nobody has; the dry run lists them. A player entered by hand under a
   different spelling would then exist twice.
4. **"Not kept" releases** keep their Dec 31 dates; only their label changed.
5. **The daily sync stays PARTIAL** until the 907 are recovered (or
   explicitly accepted as unrecoverable).
6. **Sync length.** The daily sync makes about 40 more Yahoo requests (~40 s at
   500 ms). A throttle mid-log makes that run PARTIAL; whatever was read is
   still written.
7. **Older seasons:** dry runs with `leagueKey` for older seasons come back
   unresolved until a mapping from that season's team keys exists.
