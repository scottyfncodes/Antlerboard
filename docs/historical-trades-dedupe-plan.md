# Duplicated historical trades: cleanup plan (not run)

**Status:** done, 2026-10-16 14:58 UTC, with the commissioner's written
approval. Backup branch `pre-history-dedupe-20261016-1450`
(`br-bitter-bonus-avao48r9`), full-database fingerprint identical to `main`
before any change.

| | Before | After |
|---|---|---|
| `HistoricalTrade` | 87 rows, 44 distinct | 44 rows, one per `sourceRef` |
| `HistoricalPropBet` | 36 rows, 20 distinct | 20 rows, one per `sourceRef` |

- Kept: the Sep 21 17:54 load's row of every group (all 44 trades and 20
  bets). Deleted: the Sep 22 03:16 copies (43 trades, 16 bets), each
  identical to its kept row in every column but `id` / `createdAt`.
- Row 57's date corrected from 2026-11-29 to 2025-11-29 (see below).
- Every other table, the kept rows themselves, and all earlier audit entries
  match the backup byte for byte. Audit entries: `historical-trade-dedupe`,
  `historical-prop-bet-dedupe`, `historical-trade-row57-date`.
- No page displays these two tables today; only the importers read them.

## What production holds (read-only, 2026-10-15)

| | |
|---|---|
| `HistoricalTrade` rows | 87 |
| Distinct trades (identical in every content column) | 44 |
| Duplicated exactly once | 43 |
| Duplicated more than once | 0 |
| Load 1 | 44 rows, 2026-09-21 17:54 UTC |
| Load 2 | 43 rows, 2026-09-22 03:16 UTC: every trade except `row 57` |
| A `sourceRef` with two different contents | none |
| Rows with team links | 0 (the league-history import will fill links in; it never changes trade content) |
| Rows referenced by anything else | none (no foreign key points at `HistoricalTrade`) |

**Cause.** `/api/commissioner/import/historical/commit` creates every trade
row on every run. It upserts team-season records, but it doesn't upsert
trades, so the second run on Sep 22 added a second copy of each trade.

**Prop bets have the same problem** (read-only, 2026-10-16): 36
`HistoricalPropBet` rows for 20 distinct bets (20 from load 1, 16 from
load 2). `scripts/dedupe-historical-prop-bets.sql` is the matching script,
with the same guards (36 / 20 / 16, nothing tripled; after: 20 rows, 20
distinct `sourceRef`s) and the same backup-and-approve steps. Tested on the
local replica with 36 synthetic rows: it left 20, and a second run refused.

**Re-checked 2026-10-16, after the league-history import:** trades still 87
rows / 44 distinct / 43 pairs counting the newly filled team links, so the
trade script's guards hold as written.

**Row 57** (Michael ↔ Ed: Cameron, Flaherty, Ohtani for Gilbert,
J.Rodríguez) was dated 2026-11-29, as the workbook has it (Off Season Trades,
cell A58). The keeper records place it before the 2026 season: Michael kept
Ohtani in 2025 and Ed in 2026; Ed kept J.Rodríguez in 2025 and Michael in
2026. Corrected to 2025-11-29. **The workbook cell still says 2026**: fix it
there too, or a later workbook import adds the trade again with the old date
(content differs, so it isn't skipped as a duplicate).

## Plan

1. **Code fix, as its own PR.** *Done* (`historical/commit/route.ts`): a
   trade or prop bet identical in every content column is skipped, not
   created again, and the result reports `tradesSkipped` /
   `propBetsSkipped`. Covered by `historical/commit/route.test.ts`.
2. **Backup.** Create a Neon backup branch of `main` immediately before the
   cleanup, as in runbook §2. Record its id.
3. **Verify read-only.** The counts above must still hold: 87 rows, 44
   distinct, 43 pairs, nothing duplicated twice.
4. **Correct.** Run `scripts/dedupe-historical-trades.sql`, then
   `scripts/dedupe-historical-prop-bets.sql`.
   - It keeps the oldest row of each identical group and deletes the rest
     (43 rows).
   - It writes one `AuditLogEntry` for the correction.
   - It's all-or-nothing. Guards before the delete check the exact state
     (87 / 44 / 43, nothing tripled). Guards after it check 44 rows, 44
     distinct `sourceRef`s.
   - Any mismatch rolls everything back.
5. **Check afterwards.**
   - 44 rows, one per `sourceRef`.
   - The trade history page shows each trade once.
   - Team links on the kept rows are unchanged.

**Order relative to the league-history import:** either way. The import fills
the same empty links on both copies of a pair, so the copies stay identical,
and the script's content match includes the links.

**Tested on the local rehearsal replica** (87 rows, same structure):
- It removed 43 rows and left 44, one per `sourceRef`.
- Run again, it refused ("Expected 87 historical trades - stop") and changed
  nothing.
