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
| Commissioner moves | `COMMISSIONER_MOVE` (**new enum value**). Previously a free-agent add. Yahoo usually sends no players for these |
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
| `commish` and any unknown type silently became `FREE_AGENT_ADD` | `commish` → `COMMISSIONER_MOVE`; unknown types and adds with an unknown source are **not written**, counted, and make the run PARTIAL |
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

Both use the stored access token **without refreshing it**, so the dry run
writes nothing anywhere. Run them within about an hour of the daily sync
(12:00 UTC) or a commissioner's Sync Now. Signed in as the commissioner, on
https://antlerboard.vercel.app (never a preview URL):

1. **Dry run [READ]**: open
   `/api/commissioner/yahoo-transaction-recovery?season=2026`
   (`&leagueKey=…` for another Yahoo league; it defaults to the connected one).
2. **Review** the report (format below). Before applying, decide on everything
   that isn't `ready`, and on `playersToCreate`.
3. **Back up** production (Neon branch, as in the historical-import runbook §2).
4. **Apply [PROD WRITE]**: `POST` the same URL with
   ```json
   { "season": 2026, "fingerprint": "<from the reviewed dry run>", "confirm": "APPLY_YAHOO_TRANSACTION_RECOVERY" }
   ```
   It re-reads Yahoo and **refuses (409) unless the plan is identical** to the
   one reviewed, or if Yahoo's log wasn't read to the end. Then it writes only
   `ready` records, each in its own database transaction, and logs one
   `YAHOO_TRANSACTION_RECOVERY` audit entry. It is refused on deployments
   without the Yahoo env vars (previews).
5. **Re-run the dry run.** Recovered rows are no longer targets. Applying again
   writes nothing new.

### Dry-run report format

```jsonc
{
  "mode": "dry-run",
  "leagueKey": "469.l.8891", "seasonYear": 2026, "generatedAt": "…",
  "yahoo": { "pages": 43, "transactionsRead": 907, "entriesWithoutKey": 0, "complete": true, "incompleteReason": null },
  "targets": 907,                       // stored rows with no detail yet
  "summary": { "ready": 0, "unresolved": 0, "unsupported": 0, "malformed": 0, "missing_in_yahoo": 0, "not_checked": 0 },
  "proposedTypes": { "WAIVER_ADD": 0, "FREE_AGENT_ADD": 0, "DROP": 0, "TRADE": 0, "COMMISSIONER_MOVE": 0 },
  "playersToCreate": [{ "yahooPlayerId": "12345", "name": "…" }],
  "onlyInYahoo": ["469.l.8891.tr.…"],  // not stored at all - the daily sync adds these, recovery doesn't
  "fingerprint": "<sha256 of every ready record's proposal>",
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

- A commissioner session on production (`requireCommissioner`).
- The league's stored Yahoo connection (`YahooConnection` for `469.l.8891`)
  with an **unexpired access token**. These routes never refresh it, because
  refreshing writes new tokens. On 2026-10-16 the token was valid 12:00–13:00
  UTC, after the daily cron. Outside that window both steps answer 409 and
  change nothing.
- The Yahoo app's Fantasy Sports API approval (already in place: the daily sync
  works).
- For the apply step only: a deployment with the Yahoo env vars set (production).

No new credentials, scopes or env vars are needed.

## Open decisions and known uncertainties

1. **Team keys in Yahoo's JSON.** Team links use `source_team_key` /
   `destination_team_key` (and `trader_team_key` / `tradee_team_key`), the
   field names in Yahoo's transaction schema. This repo's export notes only
   confirm the team *names* in real responses. If the keys turn out to be
   absent, every record will be `unresolved` with "Yahoo gave no team key";
   the dry run will show it before anything is written. Matching by team name
   would then be a product decision: names change mid-season.
2. **Acquisitions for 2026 in-season moves.** The sync still writes no
   `Acquisition` rows, so in-season 2026 adds and trades don't feed keeper
   costs. Changing that changes keeper costs and needs a decision.
3. **Players to create.** Recovery creates Yahoo-linked players for Yahoo
   ids nobody has (listed in `playersToCreate`). A player entered by hand under
   a different spelling would then exist twice.
4. **"Not kept" releases** keep their Dec 31 dates; only their label changed.
   Re-dating or hiding them is a product decision.
5. **Daily sync stays PARTIAL** until the 907 are recovered, because it
   reports them as awaiting recovery.
6. **Sync time.** Paging adds about 40 requests to every daily sync (~40 s at a
   500 ms pace). A throttle mid-log makes that run PARTIAL. Whatever was read is
   still written, and the next run continues from the start.
7. **Older seasons.** `leagueKey` + `season` lets the same dry run read
   another Yahoo season, but team keys there won't match today's linked teams.
   Those records will be `unresolved` until a key mapping exists. 2021–2025
   history came from the league-history import and has no legacy rows.
8. **Statuses.** Stored exactly as Yahoo reports them. A status other than
   `successful` is shown next to the move.
