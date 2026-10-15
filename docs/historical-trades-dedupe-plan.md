# Duplicated historical trades: cleanup plan (not run)

**Status:** proposed. The commissioner said to leave the duplicates alone for
the league-history import. Nothing here runs without separate, explicit
approval.

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

**Also check:** `row 57` (Michael ↔ Ed) is dated 2026-11-28, which is in the
future. Its neighbours run from 2025-11-25 to 2026-01-29, so 2025-11-28 looks
likely. This plan doesn't change it. Confirm it against the workbook.

## Plan

1. **Code fix, as its own PR.** Make the historical import idempotent for
   trades. A trade whose `sourceRef` and content already exist is skipped,
   not created again. A re-run should then leave the row count unchanged.
   Add a test for exactly that.
2. **Backup.** Create a Neon backup branch of `main` immediately before the
   cleanup, as in runbook §2. Record its id.
3. **Verify read-only.** The counts above must still hold: 87 rows, 44
   distinct, 43 pairs, nothing duplicated twice.
4. **Correct.** Run `scripts/dedupe-historical-trades.sql`.
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
