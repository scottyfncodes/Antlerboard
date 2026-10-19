-- Read-only window checks for the 2026-10-17 dry run. SELECTs only.

-- W1. Token lifetime (require >= 15 min at step 2, >= 5 min at step 3)
SELECT now() AS db_now, "tokenExpiresAt", "tokenExpiresAt" - now() AS remaining,
       ("tokenExpiresAt" - now()) >= interval '15 minutes' AS ok_15m,
       ("tokenExpiresAt" - now()) >= interval '5 minutes'  AS ok_5m,
       "lastSyncAttemptAt", "lastSyncSuccessAt", "lastSyncStatus"
FROM "YahooConnection";

-- W2. Latest sync: finished, PARTIAL, 907 awaiting recovery, 0 write errors
SELECT s.id, s."startedAt", s."finishedAt", s.status, s.error,
       tx->'detail'->'counts' AS tx_counts,
       (tx->'detail'->'counts'->>'legacyAwaitingRecovery')::int AS legacy_awaiting,
       (tx->'detail'->'counts'->>'writeErrors')::int AS write_errors,
       tx->'detail'->>'complete' AS log_complete
FROM "SyncLog" s
LEFT JOIN LATERAL (SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.detail)='array' THEN s.detail ELSE '[]' END) e
                   WHERE e->>'section' = 'transactions') t(tx) ON true
ORDER BY s."startedAt" DESC LIMIT 1;

-- W3. Was it the scheduled cron (not a manual Sync Now)?
SELECT "createdAt", "actorName", "after"->'results'->0 AS result
FROM "AuditLogEntry" WHERE action = 'YAHOO_SYNC_CRON' ORDER BY "createdAt" DESC LIMIT 1;

-- W4. Baseline still intact (expect 907 / 098de21868f2e3306d3a5df8ffc84b7f / 0 / 0)
SELECT count(*) AS legacy,
       md5(string_agg("yahooTransactionId", ',' ORDER BY "yahooTransactionId" COLLATE "C")) AS keys_md5,
       (SELECT count(*) FROM "Transaction" WHERE "yahooTransactionId" LIKE '469.l.8891.tr.%' AND "yahooType" IS NOT NULL AND "createdAt" < '2026-10-16') AS legacy_rows_detailed,
       (SELECT count(*) FROM "AuditLogEntry" WHERE action LIKE 'YAHOO_TRANSACTION_RECOVERY%') AS recovery_audits
FROM "Transaction" WHERE "yahooTransactionId" LIKE '469.l.8891.tr.%' AND "yahooType" IS NULL;
