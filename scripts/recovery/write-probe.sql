-- Read-only. Taken before and after the dry run: everything a recovery apply
-- (or a token refresh) would change. Any difference means something wrote to
-- production while the dry run ran, and the run is a STOP.

-- P1. Write probe
SELECT
  (SELECT count(*) FROM "Transaction" WHERE "yahooTransactionId" LIKE '469.l.8891.tr.%') AS yahoo_transactions,
  (SELECT count(*) FROM "Transaction" WHERE "yahooTransactionId" LIKE '469.l.8891.tr.%' AND "yahooType" IS NOT NULL) AS yahoo_transactions_detailed,
  (SELECT count(*) FROM "TransactionPlayer" tp JOIN "Transaction" t ON t.id = tp."transactionId"
    WHERE t."yahooTransactionId" LIKE '469.l.8891.tr.%') AS yahoo_transaction_players,
  (SELECT count(*) FROM "TransactionTeam" tt JOIN "Transaction" t ON t.id = tt."transactionId"
    WHERE t."yahooTransactionId" LIKE '469.l.8891.tr.%') AS yahoo_transaction_teams,
  (SELECT count(*) FROM "Player") AS players,
  (SELECT count(*) FROM "Player" WHERE "yahooPlayerId" IS NOT NULL) AS players_with_yahoo_id,
  (SELECT max("updatedAt") FROM "Player") AS players_last_updated,
  (SELECT count(*) FROM "AuditLogEntry" WHERE action LIKE 'YAHOO_TRANSACTION_RECOVERY%') AS recovery_audits,
  (SELECT count(*) FROM "SyncLog") AS sync_logs,
  (SELECT max("updatedAt") FROM "YahooConnection") AS connection_updated_at;
