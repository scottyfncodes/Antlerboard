# League History import runbook

How to run the one-time League History import (Settings › Import › League
History) against production safely. **Nothing in this document has been run
against production.** The import stays unexecuted until the commissioner
approves both the reviewed preview and the backup (gates G1–G4).

Every step is marked:

- **[READ]**: reads only. Safe to run any time.
- **[ISOLATED WRITE]**: writes only to a throwaway Neon branch or a local
  database. Never production.
- **[PROD WRITE]**: writes to production. Only after the gate named on the step.

## Facts this runbook relies on

| Fact | Value / where |
|---|---|
| Production app | https://antlerboard.vercel.app (Vercel project `antlerboard`, team `nocodo`) |
| Production database | Neon project `hidden-wave-58536414` (`neon-citrine-feather`), branch `main` |
| Previews | Share the production database. **Never use a preview URL for any step here.** |
| Yahoo sync cron | `vercel.json`: `0 12 * * *` (12:00 UTC). Skips a run when the last attempt was under `syncIntervalMinutes` (180) ago. |
| Season the sync owns | 2026, Yahoo league `469.l.8891` (907 synced transactions on 2026-10-14) |
| Neon point-in-time history | 6 hours (`history_retention_seconds = 21600`). The backup branch is the durable rollback, not PITR. |
| Vercel request/response body limit | about 4.5 MB per Function request **and** response |
| Import endpoints | `POST /api/commissioner/import/league-history/check` (multipart, 3 files, writes nothing). `POST …/commit` (JSON: the whole preview sent back, one DB transaction, `maxDuration` 300 s). |
| Commit safeguards | Preview HMAC signature, identity and overlap checks re-run inside the transaction, all-or-nothing rollback (#16) |

### Baseline (read-only audit, 2026-10-14 ~20:10 UTC, after #16 and #15 deployed)

```
teams 12 · players 511 (413 full Yahoo keys, 0 bare ids, 98 no Yahoo id)
roster_spots 413 · transactions 907 (all 2026, all Yahoo-synced)
acquisitions 0 · draft_picks 0 · keeper_records 0 · import_audit_entries 0
yahoo_id_dupes 0 · same_name_groups 0 · roster_key_mismatch 0 · roster_spot_dupes 0 · yahoo_tx_dupes 0
transaction_without_players 907   <- expected: the sync stores transactions without player links
last migration 2026-10-14 17:29:52 UTC
SyncLog: 4 rows ever, all 2026-10-14 16:30–17:38 UTC (manual); last SUCCESS 17:38:12, 437 records
```

**No SyncLog row has ever come from the 12:00 UTC cron.** Gate G0 below
exists for this reason.

## Gate G0: before scheduling anything (code + cron)

1. **Provenance on every cost view.** The Team page (`TeamView`),
   Players › Market and search still show raw `KeeperRecord.keeperCost`, and
   `/history/draft/[year]` shows `#overallPick` without a "row order" label.
   Production has no keeper records or draft picks today, so these are
   harmless now. After the import they would present estimated costs and row
   numbers as fact. Merge the follow-up PR that routes them through
   `classifyKeeperCost` / `nominationOrderOf` first, or record the
   commissioner's explicit decision to import without it.
2. **Prove the cron works [READ].** On at least one day, with no manual
   "Sync Now" between 09:00 and 13:00 UTC, confirm the scheduled run's
   `YAHOO_SYNC_CRON` audit entry (actor "Vercel Cron") with an
   `outcome: "synced"` result whose `syncLogId` names a SyncLog row with
   `status = SUCCESS` (query in §5). Runtime logs are kept only 1 hour on
   Hobby, so the database is the only durable evidence. Every authenticated
   scheduled run writes that audit entry, including runs that skip or find
   no eligible connection. No entry at all after 13:00 UTC means the
   schedule didn't fire or didn't authenticate. Fix the cron before going
   further. The post-import verification depends on it.

## 1. Prepare the input files [READ]

Do these on the commissioner's machine. None of them touch the app.

1. **Master workbook** (`Official_Keeper_Costs…xlsx`: manager sheets, Off
   Season Trades, FYPD) and **auction history** (`Auctions_AllSeasons` +
   `Keepers_AllSeasons` `.xlsx`). Use the exact files the commissioner
   reviewed. Record each file's SHA-256 (`shasum -a 256 <file>`).
2. **Yahoo transaction export, 2025 and earlier only.** The CSV has columns
   `season, league_key, transaction_raw`. The sync owns 2026, so the file
   must contain no `469.l.8891` rows and no `season` of 2026 or later. Check:

   ```bash
   python3 - "$CSV" <<'PY'
   import csv, sys, collections
   rows = list(csv.DictReader(open(sys.argv[1], newline='', encoding='utf-8')))
   by = collections.Counter((r['season'], r['league_key']) for r in rows)
   for k, n in sorted(by.items()): print(*k, n)
   bad = [k for k in by if k[1] == '469.l.8891' or int(k[0]) >= 2026]
   print('FAIL: 2026 rows present' if bad else 'OK: 2025 and earlier only', bad)
   PY
   ```

   The commit also refuses any transaction from a synced Yahoo league (a 409
   with nothing written). This check is so the preview never needs that.
3. **Size check.** The `/check` upload is the three files in one multipart
   request:

   ```bash
   ls -l "$WORKBOOK" "$AUCTION" "$CSV" | awk '{s+=$5; print $5, $9} END {printf "total %.2f MB (must be < 4.0 MB for margin under ~4.5 MB)\n", s/1048576}'
   ```

   The preview JSON that `/check` returns is also sent back unchanged as the
   `/commit` body, so it must be under the limit too. Measure it in the
   rehearsal (§3.4). If anything is over 4.0 MB, stop. The import needs a
   code change (for example, server-side preview storage) before it can run
   on Vercel.

## 2. Backup branch [ISOLATED WRITE], then gate G1

Immediately before the production preview (§4), and again immediately before
the commit (§6) if more than an hour has passed:

1. Neon console → project `hidden-wave-58536414` → Branches → **Create
   branch** from `main`, "Current point in time". Name it
   `pre-league-history-import-YYYYMMDD-HHMM` (UTC). Record the branch id and
   the LSN/time Neon shows. (MCP equivalent: `create_branch` with
   `project_id = hidden-wave-58536414`.)
2. **Fingerprint both [READ].** Run `scripts/db-fingerprint.sql` against
   `main` and against the new branch, and record the output. Get each
   connection string from the Neon console and keep it in an environment
   variable. Never paste it into a ticket, chat or this document.

   ```bash
   psql "$PROD_URL"   -At -f scripts/db-fingerprint.sql > fp-main.json
   psql "$BACKUP_URL" -At -f scripts/db-fingerprint.sql > fp-backup.json
   diff fp-main.json fp-backup.json && echo "backup identical"
   sha256sum fp-main.json   # record this hash, not the JSON, in the import log
   ```

   The two files may differ only if someone used the app in between. Rerun
   both until they match.
3. **Pre-import audit [READ]:**
   `psql "$PROD_URL" -qAt -v ON_ERROR_STOP=1 -f scripts/import-audit.sql > audit-pre.json`.
   It must show 0 for `yahoo_id_dupes`, `roster_key_mismatch`,
   `roster_spot_dupes`, `keeper_record_dupes` and `yahoo_tx_dupes`, and
   `import_audit_entries` 0 for a first run. Compare it with the baseline above.

**G1 (commissioner):** the backup branch exists, its fingerprint matches `main`, and the pre-import audit is clean.

## 3. Rehearsal on the backup's copy [ISOLATED WRITE]

This proves the exact files commit cleanly, and measures the payload, without
touching production.

1. In Neon, create a **second** branch from the backup branch
   (`rehearsal-YYYYMMDD`). Never rehearse on the backup itself.
2. Run the app locally against it (`.env.local`: `DATABASE_URL`/`DIRECT_URL` =
   the rehearsal branch, any local `AUTH_SECRET`). **No Yahoo env vars.**
   Don't sync from the rehearsal: a token refresh there could invalidate
   production's Yahoo credentials.
3. `npm run dev`, sign in as the commissioner, go to Settings › Import ›
   League History, upload the three files and choose **Build preview**.
4. In DevTools › Network, record the `/check` response size. This is the
   `/commit` body size and must be < 4.0 MB.
5. Commit on the rehearsal. Then run
   `scripts/import-audit.sql` against it and apply the post-import checks in
   §7. Run the import a second time and confirm every count is unchanged
   (re-runs replace their own rows).
6. Delete the rehearsal branch when you're done.

## 4. Build the production preview [READ], then gate G2

On **https://antlerboard.vercel.app** only, never a preview URL, signed in
as the commissioner: Settings › Import › League History → upload the three
files → **Build preview**. `/check` writes nothing.

Review, and save a screenshot or copy of each:

- **Conflicts.** Must be empty. Any conflict means the commit will refuse with
  409. Fix the input; never edit around it.
- **Unresolved team names.** Each one must be mapped or explained.
- **Unmatched players.**
- **Identity review list.** Players kept separate because a same-name match
  wasn't certain. Each becomes its own player, with a "Needs review" note on
  the player page.
- **Keeper checks.** Workbook vs. engine cost disagreements, and the
  "apply recorded keeper costs" choice.
- **Summary counts.** Players, events, draft picks, seasons. They must match
  the rehearsal.

**G2 (commissioner, in writing):** "I reviewed preview built at <time UTC> from files <sha256s>, no conflicts, and approve committing it."
Without G2, do not commit. Close the tab instead. Nothing has been written.

## 5. Schedule after the 12:00 UTC sync [READ]

The commit must not overlap a sync: both write players and transactions.
On the import day:

1. No manual "Sync Now" after 09:00 UTC. Otherwise the 180-minute interval makes the cron skip.
2. After 12:00 UTC, wait for the scheduled run's evidence, rather than
   assuming it ran:

   ```sql
   -- the scheduled run: what it did, and the SyncLog it created
   select a."createdAt", r->>'outcome' outcome, r->>'status' status,
          r->>'reason' reason, s.status log_status, s."finishedAt", s.error
   from "AuditLogEntry" a
   cross join lateral jsonb_array_elements((a."after"::jsonb)->'results') r
   left join "SyncLog" s on s.id = r->>'syncLogId'
   where a.action = 'YAHOO_SYNC_CRON'
   order by a."createdAt" desc limit 3;
   ```

   Proceed only when today's entry (12:00 to 13:00 UTC) has
   `outcome = synced` and its SyncLog has `finishedAt` set and
   `status = SUCCESS`. `skipped` means a manual sync ran too recently.
   `failed`, or a log status of `RUNNING`, `PARTIAL` or `FAILED`, means stop
   and investigate; don't import that day. A SyncLog row with no matching
   audit entry was a manual "Sync Now", not the schedule.
3. Commit within about 60 minutes of that sync finishing, so the next
   automatic sync is about 24 hours away.

## 6. Commit [PROD WRITE], gate G3

**G3 (commissioner):** G1 and G2 recorded, §5 sync confirmed SUCCESS, and the backup is under an hour old (otherwise redo §2).

1. If the preview tab from §4 is still open and nothing has synced since,
   choose **Commit**. Otherwise choose **Build preview** again on production,
   confirm it matches the approved one (same counts, no conflicts), then
   commit. The commit re-checks identity and overlap inside its transaction
   anyway, and refuses a preview it didn't sign.
2. Outcomes:
   - **200** with a result (players created/matched, acquisitions, picks,
     keeper records, overrides, identity review). Save it.
   - **409** "Nothing was written" with conflicts. The transaction aborted
     before its first write. Go to §7.3 to confirm, then back to §1.
   - **400** signature refused. Nothing written. Build the preview again.
   - **500** or a timeout. The transaction rolled back. Confirm with §7.3
     before any retry. Don't retry blind.

## 7. Post-import checks [READ]

Run immediately:
`psql "$PROD_URL" -qAt -v ON_ERROR_STOP=1 -f scripts/import-audit.sql > audit-post.json`

1. **Identity.** `yahoo_id_dupes` = 0. `yahoo_id_full` ≥ 413 (no synced key
   was rewritten). `yahoo_id_other` = 0. `players` = pre + `playersCreated`
   from the commit result. `same_name_groups` may rise only by the number of
   identity-review players. `players_flagged_for_review` = the review list
   length.
2. **Roster links.** `roster_spots` = 413 (unchanged). `roster_key_mismatch` =
   0. `roster_spot_dupes` = 0.
3. **Rollback check (after a 409/500).** Every count equals `audit-pre.json`,
   `import_audit_entries` is unchanged, and `fp` from
   `scripts/db-fingerprint.sql` equals the pre-import fingerprint (except for
   rows the app wrote in between, such as SyncLog).
4. **Keeper history.** `keeper_records` > 0. `keeper_record_dupes` = 0.
   `keeper_without_acquisition` = 0. `keeper_season_mismatch` = 0.
   `keeper_overrides` = the commit's `overridesApplied`.
5. **Provenance.** `acquisition_price_tags` has no `untagged` entry for
   imported rows. Every `draft_pick_order_tags` entry is `source` or `sheet`.
6. **Transactions.** `transactions_yahoo` = 907 (the sync's rows are
   untouched). `yahoo_tx_dupes` = 0. `transactions_by_season['2026']` = 907.
   `transactions_import` = the commit's `dropsWritten`.
   `transaction_without_players` = 907 (only the sync's rows; every imported
   row has players).
7. `import_audit_entries` = pre + 1.
8. **UI, as a manager:** Player Costs (Unavailable / Recorded / Calculated as
   expected), Draft History (row-order picks labelled "Row"), Keepers board,
   a player page with history, and one player on the identity review list.

If any of checks 1, 2, 4 or 6 fails, go to §9.

## 8. Next-day sync verification [READ]

After the next 12:00 UTC cron (confirm with the §5 query that it ran and
succeeded), run `scripts/import-audit.sql > audit-sync.json` and compare it
with `audit-post.json`:

- `players` changes only by genuinely new Yahoo players, never by the
  number of players the import created. A jump about equal to the import's
  created or matched count means the sync duplicated players: go to §9.
- `yahoo_id_dupes` = 0. `yahoo_id_bare` should fall: the sync upgrades a bare
  id the import created to the current full key (same Player row).
- `roster_key_mismatch` = 0. `roster_spot_dupes` = 0. `roster_spots` changes
  only with real roster moves.
- `keeper_records`, `keeper_overrides`, `acquisitions`, `draft_picks` are
  unchanged (the sync never touches them). `keeper_without_acquisition` = 0.
- `yahoo_tx_dupes` = 0. `transactions_yahoo` grows only by new 2026 moves.

## 9. Rollback [PROD WRITE], commissioner decision

The import is data-only (no schema, no code), so rollback is restoring `main`
from the backup branch. **This discards every write after the backup**
(syncs, trades, offers), so decide quickly and note what will be lost.

1. Commissioner approves the rollback.
2. Neon console → Branches → `main` → **Restore** → from branch
   `pre-league-history-import-…` (latest point). Neon keeps the replaced state
   as a backup branch of its own. The connection string and endpoint of `main`
   are unchanged, so the app needs no redeploy.
3. Verify [READ]: `scripts/db-fingerprint.sql` on `main` equals
   `fp-main.json` from §2, and `scripts/import-audit.sql` equals
   `audit-pre.json`.
4. Within 6 hours of the import, Neon point-in-time restore to just before the
   commit is an alternative. After that, only the backup branch remains.
   Keep the backup branch at least 14 days.

## 2025 FYPD: resolved, one cleanup pending

Resolved on 2026-10-15 by the commissioner:

- The 2025 FYPD is the 2025 MLB draft class, drafted the night before the
  2026 auction. The commissioner's pick list matches the 53 stored
  selections exactly (pick number, manager and player).
- **53 is final.** The draft ended at pick #53, and the remaining 7 of the
  order's 60 slots were passed. This is recorded as
  `FYPD_CONFIRMED_FINAL_PICKS` in `src/lib/config.ts`, so Draft History shows
  the draft as complete at 53. Original slots after #38 stay "Unknown",
  because passed picks shifted the numbering.
- Production's year labels are correct. "2024" is the 2024 class (60 picks,
  Konnor Griffin at #1).

Still pending, and separate from the import:

- The `PENDING_REVIEW` import batch labelled 2025 ("Table 1 (cols A-D)", 60
  picks, created 2026-09-22) **is a copy of the 2024 FYPD**. Promoting it
  would have replaced the real 2025 picks. Promotion now refuses any batch
  that names a different player at a stored pick, so it can't do that. It
  should still be marked `DISCARDED`. The app has no discard action, so this
  is a single **[PROD WRITE]** that needs the commissioner's explicit
  approval:

  ```sql
  update "FypdImportBatch" set status = 'DISCARDED',
    notes = 'Discarded 2026-10-15: duplicate of the 2024 FYPD mislabelled as 2025 (commissioner-confirmed).'
  where status = 'PENDING_REVIEW' and "seasonYear" = 2025 and label = 'Table 1 (cols A-D)'
    and jsonb_array_length("rawPicks"::jsonb) = 60;
  -- expect exactly 1 row updated
  ```
