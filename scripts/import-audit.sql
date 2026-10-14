-- Read-only integrity audit for the League History import and the Yahoo
-- sync that follows it. Run it before the import, after the import, and
-- after the next day's sync, and keep each output (one JSON object) with
-- the import record. Every statement only reads; nothing here writes.
--
--   psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -f scripts/import-audit.sql
--
-- Every *_dupes / *_mismatch / *_orphan value must be 0 after a healthy
-- import. Counts are compared against the previous run's output (see
-- docs/historical-import-runbook.md for the expected direction of each).
-- transaction_without_players is not 0 by design: the Yahoo sync stores
-- transactions without player links (907 on 2026-10-14), so only growth
-- beyond that baseline is a problem.
begin transaction read only;

select json_build_object(
  -- volume
  'teams',              (select count(*) from "Team"),
  'players',            (select count(*) from "Player"),
  'roster_spots',       (select count(*) from "RosterSpot"),
  'transactions',       (select count(*) from "Transaction"),
  'transactions_yahoo', (select count(*) from "Transaction" where "yahooTransactionId" is not null),
  'transactions_import',(select count(*) from "Transaction" where "sourceRef" like 'league-history:%'),
  'transactions_by_season', (select json_object_agg("seasonYear", c order by "seasonYear")
                               from (select "seasonYear", count(*) c from "Transaction" group by 1) t),
  'acquisitions',       (select count(*) from "Acquisition"),
  'draft_picks',        (select count(*) from "DraftPick"),
  'keeper_records',     (select count(*) from "KeeperRecord"),
  'keeper_overrides',   (select count(*) from "KeeperRecord" where "commissionerOverride"),
  'players_flagged_for_review', (select count(*) from "Player" where "notes" like '%[import-key:%'),

  -- player identity: one Player per Yahoo player, whatever form the id is stored in
  'yahoo_id_dupes', (select count(*) from (
      select "leagueId", regexp_replace("yahooPlayerId", '^\d+\.p\.', '') canon
      from "Player" where "yahooPlayerId" is not null
      group by 1, 2 having count(*) > 1) d),
  'yahoo_id_bare',   (select count(*) from "Player" where "yahooPlayerId" ~ '^\d+$'),
  'yahoo_id_full',   (select count(*) from "Player" where "yahooPlayerId" ~ '^\d+\.p\.\d+$'),
  'yahoo_id_other',  (select count(*) from "Player" where "yahooPlayerId" is not null
                        and "yahooPlayerId" !~ '^\d+$' and "yahooPlayerId" !~ '^\d+\.p\.\d+$'),
  'same_name_groups', (select count(*) from (
      select "leagueId", lower("name") from "Player" group by 1, 2 having count(*) > 1) n),

  -- roster links: every spot points at the player Yahoo lists under that key
  'roster_key_mismatch', (select count(*) from "RosterSpot" r join "Player" p on p.id = r."playerId"
                            where p."yahooPlayerId" is distinct from r."yahooPlayerKey"),
  'roster_spot_dupes',   (select count(*) from (select "seasonId", "playerId" from "RosterSpot"
                            group by 1, 2 having count(*) > 1) d),

  -- keeper history
  'keeper_record_dupes', (select count(*) from (select "seasonId", "playerId" from "KeeperRecord"
                            group by 1, 2 having count(*) > 1) d),
  'keeper_without_acquisition', (select count(*) from "KeeperRecord" k
                            where not exists (select 1 from "Acquisition" a where a."playerId" = k."playerId")),
  'keeper_season_mismatch', (select count(*) from "KeeperRecord" k join "Season" s on s.id = k."seasonId"
                            where s.year is distinct from k."seasonYear"),
  'acquisition_price_tags', (select json_object_agg(tag, c) from (
                            select coalesce(substring("sourceRef" from 'price=([a-z]+)'), 'untagged') tag, count(*) c
                            from "Acquisition" group by 1) t),
  'draft_pick_order_tags',  (select json_object_agg(tag, c) from (
                            select coalesce(substring("sourceRef" from 'order=([a-z]+)'), 'untagged') tag, count(*) c
                            from "DraftPick" group by 1) t),

  -- transactions: synced rows are never duplicated by the import
  'yahoo_tx_dupes', (select count(*) from (select "yahooTransactionId" from "Transaction"
                       where "yahooTransactionId" is not null group by 1 having count(*) > 1) d),
  'transaction_without_players', (select count(*) from "Transaction" t
                       where not exists (select 1 from "TransactionPlayer" tp where tp."transactionId" = t.id)),

  -- Yahoo sync state and the import's own audit entries
  'sync_status',       (select json_agg(json_build_object('status', "lastSyncStatus", 'attempt', "lastSyncAttemptAt",
                          'success', "lastSyncSuccessAt", 'records', "lastSyncRecordCount", 'error', "lastSyncError"))
                        from "YahooConnection"),
  'last_sync_logs',    (select json_agg(l) from (select "startedAt", "finishedAt", status, "recordsUpdated", error
                          from "SyncLog" order by "startedAt" desc limit 3) l),
  'import_audit_entries', (select count(*) from "AuditLogEntry" where action = 'LEAGUE_HISTORY_IMPORT'),
  'last_migration',    (select max(finished_at)::text from _prisma_migrations)
);

commit;
