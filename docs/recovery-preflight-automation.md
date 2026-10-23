# Recovery preflight automation (read-only)

The 2026 Yahoo transaction recovery dry run can only start inside a short
window each day:

- it opens 10 minutes after the scheduled sync finishes (the sync runs some
  time between 12:00 and 12:59 UTC);
- it closes at the earlier of 12:45 UTC and the Yahoo token's expiry minus
  5 minutes.

Waiting for that window by hand kept missing it. This automation runs the
whole read-only preflight and the dry run itself, then keeps the evidence for
the commissioner to review.

**What it never does:** apply, link players, change the seven FYPD mappings,
refresh a token, press Sync Now, touch Neon branches, or write anything to
production. Apply still requires the commissioner's signed-in session, the
reviewed fingerprint and the confirmation phrase, exactly as before (see
[yahoo-transaction-recovery.md](yahoo-transaction-recovery.md)).

## How it works

`.github/workflows/recovery-preflight.yml` starts at 11:41 UTC, with a backup
trigger at 12:11. It runs only from the repository's default branch (the
production branch Vercel deploys, currently
`claude/antlerboard-fantasy-baseball-7b3vai`; `main` is a stale branch). It runs `python3 -I scripts/recovery/preflight.py`, which
does the following and stops at the first failure.

1. **Checks the three audited scripts.** Their SHA-256 hashes must be
   unchanged:
   - `validate_dry_run.py` f8f55a06…
   - `waiver_fa_check.py` 5e9f4a9e…
   - `window-checks.sql` c4e40efc…

   The hashes are pinned in `SHA256SUMS` and again inside `preflight.py`.
2. **Proves the setup**, after the first poll that isn't a STOP. These are
   the checks listed under "Verify the setup" below: the Neon login,
   GitHub-to-Vercel connectivity, fail-closed behavior and the token. Any
   failure is a STOP that names the blocker.
3. **Polls production every 60 s.** Each poll is one REPEATABLE READ READ
   ONLY transaction as the read-only role. It runs `window-checks.sql`
   unchanged, `fypd-unlinked.sql` and `write-probe.sql`, then re-checks every
   gate:

   | Gate | Required |
   |---|---|
   | Session | `transaction_read_only = on` |
   | Clocks | Runner and database within 60 s |
   | Hard deadline | Now ≤ 12:45 UTC |
   | Baseline | 907 / `098de21868f2e3306d3a5df8ffc84b7f` / 0 / 0 |
   | FYPD | All seven players present, none with a Yahoo id |
   | Scheduled sync | Today's `YAHOO_SYNC_CRON` audit entry by "Vercel Cron", outcome `synced`, naming the latest SyncLog (so not a manual Sync Now) |
   | Sync result | Started today after 12:00 UTC, finished, `PARTIAL`, `legacyAwaitingRecovery` 907, `writeErrors` 0 |
   | Token | Refreshed by that sync (expires after the sync started) |
   | Window | Earliest = finish + 10 min. Latest = min(12:45, expiry − 5 min). Earliest ≤ latest, and now ≤ latest |

   - Before the sync is recorded, or before the earliest start, it **waits**.
   - Any failed, missing, unreadable or inconsistent value is an immediate
     **STOP**, and so is reaching the deadline. Nothing is retried, and the
     deadline is never extended.
4. **On GO, makes one GET of the production dry run.** The URL is fixed in
   the script: `https://antlerboard.vercel.app/api/commissioner/yahoo-transaction-recovery?season=2026`.
   - It sends the `RECOVERY_DRYRUN_TOKEN` bearer token and never follows a
     redirect.
   - It saves the response byte for byte.
   - Any answer other than 200 is a STOP, and the error text is kept.
5. **Takes the same snapshot again.** Any difference from the GO snapshot is a
   STOP. This compares the token expiry, the sync and cron rows, the baseline,
   the FYPD players, and the write probe (Yahoo transaction and link counts,
   players, recovery audit entries, sync logs, connection `updatedAt`).
6. **Validates the report, in order, stopping at the first failure:**
   1. The original JSON and its envelope: league, season, fingerprint and
      records, with `generatedAt` inside the request and before the token
      expired.
   2. `python3 -I validate_dry_run.py <report> <evidence dir>`, which must
      exit 0.
   3. The cross-checks it generates. They are confirmed to be plain SELECTs,
      run read-only, and compared with values recomputed from the report and
      with the baseline.
   4. `python3 -I waiver_fa_check.py <report>`, which must exit 0.

It exits 0 only when every step passed. That means the evidence is ready for
review, not that anything is approved.

## Why it can't write to production

| Layer | What enforces it |
|---|---|
| Database login | `antlerboard_preflight` has SELECT on 30 listed columns of nine tables and nothing else: no table-level privilege, no write, no DDL, no Yahoo token columns, no membership in other roles (`neon-preflight-role.sql`, verification V1–V7) |
| Session | The role defaults to `default_transaction_read_only = on`; the script also sets it per connection and opens every transaction `READ ONLY` |
| SQL | Every statement is checked to be a plain SELECT before it runs (no DML/DDL keywords, `SELECT INTO`, `pg_*()` functions, comments or psql meta-commands) |
| Endpoint | The dry-run GET never refreshes the token and writes nothing (`allowRefresh: false`). The token is accepted on GET only, with no `leagueKey` override; POST ignores it |
| Evidence | The before/after snapshots must be identical, and each check records the database's own `transaction_read_only` |
| Secrets | Read only from GitHub secrets. The Yahoo token columns can't be read. Every output passes through redaction, and the tests assert no secret appears in any evidence file |

## Evidence

The GitHub Actions run summary shows GO/STOP, every check with its evidence,
the window and each step. The artifact `recovery-preflight-YYYY-MM-DD` is kept
for 90 days and contains:

| File | What |
|---|---|
| `preflight.json` | Every poll, the final gate with all values, hashes, request timing, steps, and the outcome with its reasons |
| `summary.md` | The same, readable |
| `dry-run-YYYY-MM-DD.json` | The report exactly as served |
| `validate_dry_run.output.txt` | The validator's exact output and exit code |
| `dry-run-YYYY-MM-DD.summary.txt`, `.crosscheck.sql`, `.yahoo-sample.md` | The validator's outputs: summary, cross-check SQL, 12-record Yahoo sample |
| `crosscheck-results.json` | Each cross-check: expected, actual, pass/fail, plus the session's read-only proof |
| `waiver_fa_check.output.txt`, `dry-run-YYYY-MM-DD.waiver-fa.md` | The waiver/free-agent check output and its 8-record sample |
| `unresolved.md` | Every record that isn't ready, with its issues |
| `dry-run-error.txt` | Only when the endpoint answered non-200 |

A STOP fails the run (a run that ends before writing evidence is recorded as a STOP too, so the backup trigger never retries it), and GitHub emails a failure notice to the account that
last changed the workflow's schedule (Settings > Notifications > Actions).

## One-time setup

Each step changes production configuration and needs the commissioner's
approval. The schedule does nothing until step 6.

1. **Merge PR #36.** That deploys the route change, which is inert without
   `RECOVERY_DRYRUN_TOKEN`: every bearer token is refused.
2. **Create the read-only role.** Run `scripts/recovery/neon-preflight-role.sql`
   against project `hidden-wave-58536414`, branch `main`, database `neondb`,
   and check that verification queries V1–V7 show exactly the expected values.
   The role has no password yet, so it can't log in.
3. **Generate the two secrets on your own computer.** Run
   `python3 -I scripts/recovery/make-preflight-credential.py`. It prints three
   values and saves nothing:
   - an `ALTER ROLE antlerboard_preflight WITH PASSWORD '…';` statement. Run it
     in the Neon SQL editor. Neon only accepts plaintext passwords; it
     refused a pre-hashed SCRAM verifier when tried on 2026-10-19.
   - the `PREFLIGHT_DATABASE_URL` value. Save it in GitHub: Settings > Secrets
     and variables > Actions > New repository secret.
   - the `RECOVERY_DRYRUN_TOKEN` value. Save it as a GitHub repository secret
     too, and in Vercel (Project antlerboard > Settings > Environment
     Variables) with environment **Production only** and Sensitive on.

   Then clear the terminal.
4. **Redeploy production** so the Vercel variable takes effect.
5. **Verify the setup.** Run the workflow manually in `verify-setup` mode
   (Actions > Recovery preflight (read-only) > Run workflow). It is allowed
   while the schedule is disabled, and it never runs the dry run. It proves:
   - **Neon:** the login works, it is `antlerboard_preflight`, the session is
     read-only, and it can't read the Yahoo token column.
   - **GitHub to Vercel:** production is reachable and refuses a wrong token
     (401).
   - **Fail closed:** a POST to the apply with the dry-run token is refused
     (401 or 403).
   - **The token:** production accepts the dry-run token (409, "doesn't
     refresh"). This check only runs while the Yahoo token is expired and
     outside 11:58–13:05 UTC, so the request stops before reading Yahoo.
     Otherwise the run fails with "couldn't be checked now".
6. **Activate.** In GitHub, go to Settings > Secrets and variables > Actions >
   Variables and create `RECOVERY_PREFLIGHT_ENABLED` = `true`. Do this only
   after step 5 passes. Until the variable exists, the schedule and manual
   `preflight` runs skip the job.

Every scheduled run repeats the step-5 checks after its first poll, so the
first real run proves the Neon credential and GitHub-to-Vercel connectivity
explicitly. When the run starts after the sync (the Yahoo token valid), the
token check is recorded as deferred and the dry run proves it: a 401 then is a
STOP that names the blocker.

## Turning it off, rotating, removing

- **Pause:** set `RECOVERY_PREFLIGHT_ENABLED` to `false`, or delete it.
- **Rotate the token:**
  - Replace it in Vercel and GitHub together, then redeploy.
  - A leaked token only allows the read-only dry run, and only while a Yahoo
    token is valid.
- **Remove the role:**

  ```sql
  DROP OWNED BY antlerboard_preflight;
  DROP ROLE antlerboard_preflight;
  ```

- **Disable the endpoint path:** delete `RECOVERY_DRYRUN_TOKEN` from Vercel
  and redeploy. Every bearer token is refused again.

## Limits

- **A late cron leaves no window.** If Vercel's cron fires after about 12:35
  UTC, there's no valid window that day: finish + 10 minutes lands past
  12:45. The run reports STOP with the evidence. Observed fire times: 12:56
  (Oct 15) and about 12:00 (Oct 16–18).
- **GitHub can delay or drop scheduled runs.** The early 11:41 start and the
  12:11 backup cover that. A run that starts after 12:45 reports STOP.
- **One run a day.** Once today's evidence exists, later triggers, manual
  ones included, skip. A STOP is final for that day.

## Tests

```bash
python3 -I -m unittest discover -s scripts/recovery -p 'test_*.py' -v
# Integration (real Postgres, real role SQL, local stand-in endpoint):
PREFLIGHT_IT_ADMIN_DSN=postgresql://postgres@127.0.0.1:5432/<migrated scratch db> python3 -I -m unittest discover -s scripts/recovery -p 'test_*.py' -v
npx vitest run src/app/api/commissioner/yahoo-transaction-recovery src/middleware.test.ts
```

`.github/workflows/recovery-preflight-ci.yml` runs all of these on pull
requests, against a throwaway Postgres. It has no secrets and no production
access.
