# League-history import rehearsal

Runs the real `/api/commissioner/import/league-history/check` and `/commit`
route handlers **twice** against a local Postgres copy of production, using
the exact files production will get, then checks the result. Nothing here
touches production. The database URL must be local, and Yahoo env vars are
removed.

## The replica

`seed-replica.ts` builds the database from a snapshot directory. The snapshot
holds no emails, credentials, tokens or sessions. It's kept out of git
(`.rehearsal/`).

| File | Contents (read-only queries on production) |
|---|---|
| `base.txt` | League, settings, seasons, managers (names only), teams, the 72 team-season records, the 87 historical trades (names, dates, refs) |
| `players.txt` | The 511 players: Yahoo id, name, MLB team, positions, FYPD draft year |
| `roster.txt` | The 413 roster spots as team:player:position |
| `fypd.txt` | Both FYPD drafts, their order and all 113 picks |

The 2026 synced transactions are recreated by count, type and key prefix
(658 adds, 33 trades, 216 drops on `469.l.8891`). The import reads only
their keys and seasons.

## Run

```bash
export REHEARSAL_DATABASE_URL=postgresql://postgres:<local password>@localhost:5432/antlerboard_rehearsal
export REHEARSAL_REPLICA=.rehearsal/replica
export REHEARSAL_WORKBOOK=Official_Keeper_Costs.xlsx
export REHEARSAL_AUCTION=Auction_History_From_Yahoo.xlsx   # scripts/build-auction-history.ts
export REHEARSAL_YAHOO=antlerboard-yahoo-2021-2025-transactions.csv.gz
export REHEARSAL_OUT=rehearsal-report.json
bash scripts/rehearsal/run.sh
```

The run recreates the database, seeds it, then runs the import twice. It fails
unless all of these hold:

- **Sizes.** The upload, the `/check` response and the `/commit` body are each under 4.0 MB.
- **Transactions.** Every Yahoo transaction with players is written. Commissioner
  entries without players are counted separately.
- **Auction picks.** Per season, 2021-2025: draft picks and their total salary equal
  the auction file's buys.
- **No duplicates.**
  - No player has two picks or two draft acquisitions in a season.
  - No declared keeper (by Yahoo id) is also an auction pick.
- **Untouched data.** These hash the same before and after:
  - 2026 synced transactions
  - roster spots
  - FYPD drafts, order and picks
  - team-season records
  - historical trades (team-id backfill excepted; the report counts it)
  - existing players, teams, managers, seasons and league settings
- **Repeat.** The second run's writes equal the first run's.

`REHEARSAL_OUT` holds the full report: sizes, the per-season reconciliation,
the preview summary and flags, both commit results, and the untouched-data
hashes.
