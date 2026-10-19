-- One-time setup of the read-only login used by the unattended recovery
-- preflight (.github/workflows/recovery-preflight.yml). See
-- docs/recovery-preflight-automation.md for the full procedure.
--
-- Run in the Neon SQL editor: project hidden-wave-58536414, branch main,
-- database neondb, as neondb_owner. This file is the only production change
-- the automation needs, and it needs the commissioner's approval.
--
-- It creates a role that can log in but has NO password yet, so it can't be
-- used until the separate ALTER ROLE ... PASSWORD step (generated locally by
-- make-preflight-credential.py, which never shows the password to anyone but
-- you).
--
-- What the role can do: SELECT the listed columns of nine tables. Nothing
-- else. Not the Yahoo access/refresh tokens, not any other table, no writes,
-- no DDL. Every session is read-only by default as well.

BEGIN;

CREATE ROLE antlerboard_preflight WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 2;

-- Belt and braces: even a session that somehow had write grants starts
-- read-only, and nothing it runs can hang around.
ALTER ROLE antlerboard_preflight SET default_transaction_read_only = on;
ALTER ROLE antlerboard_preflight SET statement_timeout = '30s';
ALTER ROLE antlerboard_preflight SET lock_timeout = '5s';
ALTER ROLE antlerboard_preflight SET idle_in_transaction_session_timeout = '60s';

GRANT CONNECT ON DATABASE neondb TO antlerboard_preflight;
GRANT USAGE ON SCHEMA public TO antlerboard_preflight;

-- Column-level SELECT only (default deny for every other column and table).
-- YahooConnection deliberately excludes "accessToken", "refreshToken" and
-- "yahooGuid".
GRANT SELECT ("tokenExpiresAt", "lastSyncAttemptAt", "lastSyncSuccessAt", "lastSyncStatus", "updatedAt")
  ON "YahooConnection" TO antlerboard_preflight;
GRANT SELECT (id, "startedAt", "finishedAt", status, error, detail)
  ON "SyncLog" TO antlerboard_preflight;
GRANT SELECT (action, "actorName", "createdAt", after)
  ON "AuditLogEntry" TO antlerboard_preflight;
GRANT SELECT (id, "yahooTransactionId", "yahooType", "createdAt", "yahooDetailSyncedAt")
  ON "Transaction" TO antlerboard_preflight;
GRANT SELECT ("transactionId") ON "TransactionPlayer" TO antlerboard_preflight;
GRANT SELECT ("transactionId") ON "TransactionTeam" TO antlerboard_preflight;
GRANT SELECT (id, name, "yahooPlayerId", "createdAt", "updatedAt")
  ON "Player" TO antlerboard_preflight;
GRANT SELECT ("playerId") ON "FypdSelection" TO antlerboard_preflight;
GRANT SELECT (id, "yahooTeamId") ON "Team" TO antlerboard_preflight;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (read-only). Run after the block above; every row must show
-- the expected value, otherwise drop the role (see the runbook) and stop.
-- ---------------------------------------------------------------------------

-- V1. Role attributes. Expect: f | f | f | f | f | f | 2 | {default_transaction_read_only=on,statement_timeout=30s,lock_timeout=5s,idle_in_transaction_session_timeout=60s}
SELECT rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit, rolconfig
FROM pg_roles WHERE rolname = 'antlerboard_preflight';

-- V2. Member of no other role (e.g. not neon_superuser). Expect 0.
SELECT count(*) AS memberships FROM pg_auth_members WHERE member = 'antlerboard_preflight'::regrole;

-- V3. No table-level privilege of any kind on any table (column SELECTs only). Expect 0.
SELECT count(*) AS table_privileges
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND has_table_privilege('antlerboard_preflight', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');

-- V4. No column it could write. Expect 0.
SELECT count(*) AS writable_columns
FROM information_schema.columns col
WHERE col.table_schema = 'public'
  AND has_column_privilege('antlerboard_preflight', format('%I.%I', col.table_schema, col.table_name), col.column_name, 'INSERT,UPDATE,REFERENCES');

-- V5. Exactly the 30 granted columns are readable, and the Yahoo tokens are not. Expect 30 | f | f | f
SELECT (SELECT count(*) FROM information_schema.columns col
        WHERE col.table_schema = 'public'
          AND has_column_privilege('antlerboard_preflight', format('%I.%I', col.table_schema, col.table_name), col.column_name, 'SELECT')) AS readable_columns,
       has_column_privilege('antlerboard_preflight', 'public."YahooConnection"', 'accessToken', 'SELECT') AS can_read_access_token,
       has_column_privilege('antlerboard_preflight', 'public."YahooConnection"', 'refreshToken', 'SELECT') AS can_read_refresh_token,
       has_column_privilege('antlerboard_preflight', 'public."YahooConnection"', 'yahooGuid', 'SELECT') AS can_read_yahoo_guid;

-- V6. Can't create objects in the schema or the database. Expect f | f
SELECT has_schema_privilege('antlerboard_preflight', 'public', 'CREATE') AS can_create_in_schema,
       has_database_privilege('antlerboard_preflight', current_database(), 'CREATE') AS can_create_schema;

-- V7. No SECURITY DEFINER functions in public it could call to write as their owner. Expect 0.
SELECT count(*) AS security_definer_functions
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef;
