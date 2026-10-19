#!/usr/bin/env python3
"""
Tests for preflight.py and the read-only role. Standard library only.

    python3 -I -m unittest discover -s scripts/recovery -p 'test_*.py' -v

The integration tests also need PREFLIGHT_IT_ADMIN_DSN: a superuser URL for a
throwaway database already migrated with the Prisma schema (CI creates one).
They create the antlerboard_preflight role there from neon-preflight-role.sql,
seed a synthetic league, and run the whole preflight against a local stand-in
for the production endpoint. Production is never contacted.
"""
import hashlib, http.server, importlib.util, json, os, shutil, subprocess, sys, tempfile, threading, unittest, urllib.parse
from datetime import datetime, timedelta, timezone
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pf = load("preflight", "preflight.py")
read = pf.read_text
cred = load("make_preflight_credential", "make-preflight-credential.py")
FIXTURE = os.path.join(HERE, "testdata", "synthetic-dry-run.json")

UTC = timezone.utc
DAY = datetime(2026, 10, 20, tzinfo=UTC)
def t(hh, mm, ss=0):
    return DAY.replace(hour=hh, minute=mm, second=ss)
def pg(d):
    """How psql prints a timestamp(3) column in a UTC session."""
    return d.strftime("%Y-%m-%d %H:%M:%S.000") if d else ""


def snapshot(now=t(12, 12), started=t(12, 0, 10), finished=t(12, 1, 30), expires=t(13, 0, 10), cron_at=t(12, 1, 31),
             status="PARTIAL", awaiting="907", write_errors="0", outcome="synced", actor="Vercel Cron", log_id="sl1",
             cron_log_id="sl1", baseline=None, players=None, read_only="on"):
    base = {"legacy": "907", "keys_md5": "098de21868f2e3306d3a5df8ffc84b7f", "legacy_rows_detailed": "0", "recovery_audits": "0"}
    base.update(baseline or {})
    fypd = players if players is not None else [
        {"id": i, "name": n, "yahooPlayerId": "", "createdAt": "2026-09-21 00:00:00.000", "fypd_selections": "1"}
        for i, n in pf.FYPD_PLAYERS.items()]
    return {
        "ro": [{"transaction_read_only": read_only, "db_user": "antlerboard_preflight", "db_now": now.strftime("%Y-%m-%d %H:%M:%S.%f+00"), "server_version": "17"}],
        "W1": [{"db_now": "", "tokenExpiresAt": pg(expires), "remaining": "", "ok_15m": "t", "ok_5m": "t",
                "lastSyncAttemptAt": pg(started), "lastSyncSuccessAt": "", "lastSyncStatus": status}],
        "W2": [{"id": log_id, "startedAt": pg(started), "finishedAt": pg(finished), "status": status, "error": "",
                "tx_counts": "{}", "legacy_awaiting": awaiting, "write_errors": write_errors, "log_complete": ""}],
        "W3": [{"createdAt": pg(cron_at), "actorName": actor,
                "result": json.dumps({"leagueId": "lg", "outcome": outcome, "status": status, "syncLogId": cron_log_id})}] if cron_at else [],
        "W4": [base],
        "F1": fypd, "F2": [],
        "P1": [{"yahoo_transactions": "907", "players": "1000"}],
    }


def decide(snap, now=None):
    now = now or pf.ts(snap["ro"][0]["db_now"])
    return pf.evaluate(snap, now)


class SelectOnly(unittest.TestCase):
    def test_the_shipped_sql_files_are_plain_selects(self):
        self.assertEqual(len(pf.sql_file("window-checks.sql", 4)), 4)
        self.assertEqual(len(pf.sql_file("fypd-unlinked.sql", 2)), 2)
        self.assertEqual(len(pf.sql_file("write-probe.sql", 1)), 1)

    def test_refuses_anything_else(self):
        for sql in ["INSERT INTO \"Player\" VALUES (1);", "SELECT 1; DELETE FROM \"Player\";", "SELECT * INTO t FROM x;",
                    "SELECT 1 FOR UPDATE;", "SELECT pg_sleep(1);", "\\! rm -rf /\nSELECT 1;", "SELECT 1 -- x\n;",
                    "SELECT ';' ; UPDATE x SET y=1;", "WITH d AS (DELETE FROM x RETURNING *) SELECT * FROM d;",
                    "SELECT set_config('a','b',false);", "/* c */ SELECT 1;", "CREATE TABLE x();"]:
            with self.subTest(sql=sql), self.assertRaises(pf.Stop):
                pf.select_statements(sql)

    def test_literals_and_identifiers_are_not_mistaken_for_keywords(self):
        self.assertEqual(pf.select_statements("SELECT count(*) FROM \"UPDATE\" WHERE action LIKE 'DELETE%';\n"),
                         ["SELECT count(*) FROM \"UPDATE\" WHERE action LIKE 'DELETE%'"])


class Gate(unittest.TestCase):
    def assertStop(self, v, fragment):
        self.assertEqual(v["decision"], "STOP", v["failures"])
        self.assertTrue(any(fragment in f for f in v["failures"]), v["failures"])

    def test_go_inside_the_window(self):
        v = decide(snapshot())
        self.assertEqual(v["decision"], "GO", v["failures"])
        self.assertEqual(v["earliest"], t(12, 11, 30))
        self.assertEqual(v["deadline"], t(12, 45))
        self.assertTrue(all(c["ok"] for c in v["checks"]))

    def test_token_expiry_sets_an_earlier_deadline(self):
        v = decide(snapshot(now=t(12, 20), started=t(11, 59, 0) + timedelta(minutes=1), expires=t(12, 40)))
        self.assertEqual(v["decision"], "GO")
        self.assertEqual(v["deadline"], t(12, 35))

    def test_waits_until_ten_minutes_after_the_sync(self):
        v = decide(snapshot(now=t(12, 5)))
        self.assertEqual((v["decision"], v["earliest"]), ("WAIT", t(12, 11, 30)))

    def test_waits_for_todays_scheduled_sync(self):
        v = decide(snapshot(now=t(11, 50), cron_at=t(11, 50) - timedelta(days=1)))
        self.assertEqual(v["decision"], "WAIT")
        self.assertIn("hasn't been recorded", v["waiting"])
        self.assertEqual(decide(snapshot(now=t(12, 3), cron_at=None))["decision"], "WAIT")

    def test_stop_after_the_hard_deadline_even_with_every_other_check_passing(self):
        self.assertStop(decide(snapshot(now=t(12, 45, 1))), "hard deadline")
        self.assertStop(decide(snapshot(now=t(12, 50), cron_at=None)), "hard deadline")

    def test_stop_inside_the_token_margin(self):
        self.assertStop(decide(snapshot(now=t(12, 20), expires=t(12, 15))), "a start window exists")
        self.assertStop(decide(snapshot(now=t(12, 30), finished=t(12, 15), cron_at=t(12, 15, 1), expires=t(12, 34))), "token margin")

    def test_stop_when_a_late_sync_leaves_no_window(self):
        self.assertStop(decide(snapshot(now=t(12, 41), started=t(12, 39), finished=t(12, 40), cron_at=t(12, 40, 1), expires=t(13, 39))),
                        "a start window exists")

    def test_stop_on_sync_results(self):
        self.assertStop(decide(snapshot(status="SUCCESS")), "status PARTIAL")
        self.assertStop(decide(snapshot(awaiting="906")), "907 transactions")
        self.assertStop(decide(snapshot(awaiting="")), "907 transactions")
        self.assertStop(decide(snapshot(write_errors="1")), "write errors")
        self.assertStop(decide(snapshot(finished=None)), "the sync finished")
        self.assertStop(decide(snapshot(expires=t(11, 59))), "refreshed")

    def test_stop_unless_the_sync_was_the_scheduled_one(self):
        self.assertStop(decide(snapshot(outcome="skipped")), "from the schedule")
        self.assertStop(decide(snapshot(actor="Scott")), "from the schedule")
        self.assertStop(decide(snapshot(cron_log_id="sl0")), "latest sync log")

    def test_stop_on_baseline(self):
        self.assertStop(decide(snapshot(baseline={"legacy": "906"})), "legacy")
        self.assertStop(decide(snapshot(baseline={"keys_md5": "0" * 32})), "keys_md5")
        self.assertStop(decide(snapshot(baseline={"legacy_rows_detailed": "1"})), "legacy_rows_detailed")
        self.assertStop(decide(snapshot(baseline={"recovery_audits": "1"})), "recovery_audits")

    def test_stop_if_an_fypd_player_was_linked_or_is_missing(self):
        players = snapshot()["F1"]
        linked = [dict(p, yahooPlayerId="64314") if p["name"] == "Braden Montgomery" else p for p in players]
        self.assertStop(decide(snapshot(players=linked)), "lack Yahoo ids")
        self.assertStop(decide(snapshot(players=players[:6])), "present")

    def test_stop_on_session_clock_and_shape_problems(self):
        self.assertStop(decide(snapshot(read_only="off")), "read-only")
        self.assertStop(pf.evaluate(snapshot(), t(12, 14)), "clocks agree")
        s = snapshot(); s["W1"] = s["W1"] * 2
        self.assertStop(decide(s), "W1")
        s = snapshot(); del s["W4"]
        self.assertStop(decide(s), "W4")
        s = snapshot(); s["W2"][0]["startedAt"] = "yesterday"
        self.assertStop(decide(s), "unreadable")


class Invariants(unittest.TestCase):
    def test_detects_any_change_but_ignores_the_clock(self):
        a, b = snapshot(), snapshot()
        b["ro"][0]["db_now"] = "2026-10-20 12:13:00+00"
        b["W1"][0]["remaining"] = "00:40:00"
        self.assertEqual(pf.changed(a, b), [])
        b["P1"][0]["players"] = "1001"
        b["W1"][0]["tokenExpiresAt"] = pg(t(13, 30))
        self.assertEqual(len(pf.changed(a, b)), 2)


class LoopWithoutDatabase(unittest.TestCase):
    """The run loop with the database and HTTP replaced: STOP must never reach the endpoint."""

    def run_main(self, snaps, start=t(12, 12)):
        """Each snapshot moves the fake clock to that snapshot's database time."""
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out)
        it, now, calls = iter(snaps), [start], []
        def next_snapshot(db):
            s = next(it)
            now[0] = pf.ts(s["ro"][0]["db_now"])
            return s
        env = {"PREFLIGHT_DATABASE_URL": "postgresql://antlerboard_preflight:pw-xxxxxxxxxxxxxxxx@db.example/neondb",
               "RECOVERY_DRYRUN_TOKEN": "tok-" + "x" * 40}
        with mock.patch.dict(os.environ, env), mock.patch.object(pf.Db, "snapshot", next_snapshot), \
                mock.patch.object(pf, "utcnow", lambda: now[0]), mock.patch.object(pf, "sleep", lambda s: None), \
                mock.patch.object(pf, "http_get", lambda *a: calls.append(a) or (500, "", b"")), \
                mock.patch.object(pf.shutil, "which", lambda name: "/usr/bin/psql"):
            code = pf.main(["preflight.py", out])
        return code, calls, json.loads(read(os.path.join(out, "preflight.json"))), read(os.path.join(out, "summary.md"))

    def test_outside_the_window_it_stops_without_calling_the_endpoint(self):
        code, calls, ev, md = self.run_main([snapshot(now=t(13, 2))], start=t(13, 2))
        self.assertEqual((code, calls, ev["outcome"]), (1, [], "STOP"))
        self.assertIn("hard deadline", ev["stopReasons"][0])
        self.assertIn("# Recovery preflight: STOP", md)
        self.assertNotIn("pw-xxxxxxxxxxxxxxxx", json.dumps(ev) + md)

    def test_a_sync_that_never_comes_ends_in_stop_at_the_deadline(self):
        snaps = [snapshot(now=n, cron_at=None) for n in (t(12, 30), t(12, 44), t(12, 46))]
        code, calls, ev, _ = self.run_main(snaps)
        self.assertEqual((code, calls), (1, []))
        self.assertEqual([p["decision"] for p in ev["polls"]], ["WAIT", "WAIT", "STOP"])

    def test_a_failed_check_stops_immediately_without_calling_the_endpoint(self):
        code, calls, ev, _ = self.run_main([snapshot(write_errors="2")])
        self.assertEqual((code, calls, len(ev["polls"])), (1, [], 1))

    def test_a_changed_audited_script_stops_before_anything_else(self):
        with mock.patch.dict(pf.AUDITED_HASHES, {"window-checks.sql": "0" * 64}):
            code, calls, ev, _ = self.run_main([])
        self.assertEqual((code, calls), (1, []))
        self.assertIn("differs from the audited", ev["stopReasons"][0])

    def test_missing_credentials_stop(self):
        out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, out)
        with mock.patch.dict(os.environ, {"PREFLIGHT_DATABASE_URL": "", "RECOVERY_DRYRUN_TOKEN": ""}):
            self.assertEqual(pf.main(["preflight.py", out]), 1)
        self.assertIn("isn't set", json.loads(read(os.path.join(out, "preflight.json")))["stopReasons"][0])


class Credential(unittest.TestCase):
    """PostgreSQL itself checks the verifier: Integration logs in over SCRAM with it."""

    def test_verifier_format(self):
        import base64, re
        v = cred.scram_verifier("pencil", b"0123456789abcdef")
        m = re.fullmatch(r"SCRAM-SHA-256\$4096:([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)", v)
        self.assertIsNotNone(m)
        self.assertEqual(base64.b64decode(m.group(1)), b"0123456789abcdef")
        self.assertEqual([len(base64.b64decode(m.group(i))) for i in (2, 3)], [32, 32])
        self.assertEqual(v, cred.scram_verifier("pencil", b"0123456789abcdef"))
        self.assertNotEqual(v, cred.scram_verifier("pencil2", b"0123456789abcdef"))


# --- Integration: a real Postgres, the real role SQL, a local stand-in endpoint ---

ADMIN = os.environ.get("PREFLIGHT_IT_ADMIN_DSN")
ROLE = "antlerboard_preflight"
TOKEN = "it-token-" + "z" * 40


def admin(sql, *args):
    p = subprocess.run(["psql", ADMIN, "-X", "-q", "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", *args], input=sql,
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return p.stdout


@unittest.skipUnless(ADMIN, "PREFLIGHT_IT_ADMIN_DSN not set")
class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db = urllib.parse.urlsplit(ADMIN).path.strip("/")
        admin(f"DROP OWNED BY {ROLE}; DROP ROLE {ROLE};" if admin(f"SELECT 1 FROM pg_roles WHERE rolname = '{ROLE}'").strip() else "SELECT 1;")
        role_sql = read(os.path.join(HERE, "neon-preflight-role.sql")).replace("ON DATABASE neondb", f"ON DATABASE {db}")
        cls.verification = admin(role_sql).strip().splitlines()
        cls.password = "it-pw-" + os.urandom(12).hex()
        admin(f"ALTER ROLE {ROLE} WITH PASSWORD '{cred.scram_verifier(cls.password, os.urandom(16))}';")
        u = urllib.parse.urlsplit(ADMIN)
        cls.role_url = f"postgresql://{ROLE}:{cls.password}@{u.hostname}:{u.port or 5432}/{db}?sslmode=disable"

    @classmethod
    def tearDownClass(cls):
        admin(f"DROP OWNED BY {ROLE}; DROP ROLE {ROLE};")

    def setUp(self):
        now = datetime.now(UTC)
        if (now - timedelta(minutes=40)).date() != (now + timedelta(minutes=50)).date():
            self.skipTest("too close to midnight UTC for a same-day window")
        self.report = json.loads(read(FIXTURE))
        keys = sorted(x["yahooTransactionId"] for x in self.report["records"])
        self.baseline = {"legacy": len(keys), "keys_md5": hashlib.md5(",".join(keys).encode()).hexdigest(),
                         "legacy_rows_detailed": 0, "recovery_audits": 0}
        tables = '"AuditLogEntry","SyncLog","YahooConnection","TransactionPlayer","TransactionTeam","Transaction","FypdSelection","FypdDraft","Player","Team","Manager","Season","League"'
        fypd = ",".join(f"('{i}','lg','{n}',now() - interval '1 day')" for i, n in pf.FYPD_PLAYERS.items())
        picks = ",".join(f"('fs{n}','fd',1,{n},{n},'cmvbj15m50006sda4rcjiv8cu','{i}',now())" for n, i in enumerate(pf.FYPD_PLAYERS, 1))
        legacy = ",".join(f"('tx{k.rsplit('.', 1)[1]}','s26',2026,'DROP','{k}')" for k in keys)
        utc = "(now() AT TIME ZONE 'utc')"
        admin(f"""
TRUNCATE {tables} CASCADE;
INSERT INTO "League"(id, name, abbreviation, "updatedAt") VALUES ('lg', 'Test league', 'TL', now());
INSERT INTO "Season"(id, "leagueId", year) VALUES ('s26', 'lg', 2026);
INSERT INTO "Manager"(id, "leagueId", name) VALUES ('m1', 'lg', 'M');
INSERT INTO "Team"(id, "leagueId", name, "managerId", "yahooTeamId") VALUES
  ('cmvbj15m50006sda4rcjiv8cu', 'lg', 'T1', 'm1', '469.l.8891.t.1'), ('cmvbj15m9000asda4u4uua4em', 'lg', 'T2', 'm1', '469.l.8891.t.2');
INSERT INTO "Player"(id, "leagueId", name, "updatedAt", "yahooPlayerId") VALUES ('cmvbj15mb000csda443kwa9yc', 'lg', 'Juan Soto', now() - interval '1 day', '469.p.200');
INSERT INTO "Player"(id, "leagueId", name, "updatedAt") VALUES {fypd};
INSERT INTO "FypdDraft"(id, "leagueId", year, "updatedAt") VALUES ('fd', 'lg', 2025, now());
INSERT INTO "FypdSelection"(id, "draftId", round, "pickInRound", "overallPick", "teamId", "playerId", "updatedAt") VALUES {picks};
INSERT INTO "Transaction"(id, "seasonId", "seasonYear", type, "yahooTransactionId") VALUES {legacy};
INSERT INTO "YahooConnection"(id, "leagueId", "accessToken", "refreshToken", "yahooLeagueKey", "tokenExpiresAt", "lastSyncAttemptAt", "lastSyncStatus", "updatedAt")
  VALUES ('yc', 'lg', 'SECRET-ACCESS-TOKEN-VALUE', 'SECRET-REFRESH-TOKEN-VALUE', '469.l.8891', {utc} + interval '40 minutes', {utc} - interval '20 minutes', 'PARTIAL', {utc} - interval '15 minutes');
INSERT INTO "SyncLog"(id, "connectionId", "startedAt", "finishedAt", status, detail) VALUES
  ('sl1', 'yc', {utc} - interval '20 minutes', {utc} - interval '15 minutes', 'PARTIAL',
   '[{{"section":"transactions","detail":{{"counts":{{"legacyAwaitingRecovery":{len(keys)},"writeErrors":0}}}}}}]');
INSERT INTO "AuditLogEntry"(id, "actorName", action, "entityType", "createdAt", after) VALUES
  ('a1', 'Vercel Cron', 'YAHOO_SYNC_CRON', 'YahooConnection', {utc} - interval '15 minutes',
   '{{"results":[{{"leagueId":"lg","outcome":"synced","status":"PARTIAL","syncLogId":"sl1"}}]}}');
""")
        hm = lambda d: (d.hour, d.minute)
        self.patches = [mock.patch.object(pf, "BASELINE", self.baseline),
                        mock.patch.object(pf, "EXPECTED_SYNC", {"status": "PARTIAL", "legacy_awaiting": len(keys), "write_errors": 0}),
                        mock.patch.object(pf, "CRON_OPENS", hm(now - timedelta(minutes=30))),
                        mock.patch.object(pf, "HARD_DEADLINE", hm(now + timedelta(minutes=30))),
                        mock.patch.object(pf, "sleep", lambda s: None),
                        mock.patch.dict(os.environ, {"PREFLIGHT_DATABASE_URL": self.role_url, "RECOVERY_DRYRUN_TOKEN": TOKEN, "NO_PROXY": "127.0.0.1"})]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.hits, self.during = [], None
        self.server = self.endpoint(200)
        self.out = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.out)

    def endpoint(self, status):
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                test.hits.append({"path": self.path, "auth": self.headers.get("Authorization")})
                if test.during:
                    test.during()
                body = dict(test.report, generatedAt=datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")) \
                    if test.status == 200 else {"error": "The stored Yahoo access token has expired"}
                data = json.dumps(body).encode()
                self.send_response(test.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *a):
                pass
        self.status = status
        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        p = mock.patch.object(pf, "DRY_RUN_URL", f"http://127.0.0.1:{server.server_port}/api/commissioner/yahoo-transaction-recovery?season=2026")
        p.start()
        self.addCleanup(p.stop)
        return server

    def evidence(self):
        ev = json.loads(read(os.path.join(self.out, "preflight.json")))
        everything = "".join(read(os.path.join(self.out, f)) for f in os.listdir(self.out))
        for secret in (self.password, TOKEN, "SECRET-ACCESS-TOKEN-VALUE", "SECRET-REFRESH-TOKEN-VALUE"):
            self.assertNotIn(secret, everything)
        return ev

    def test_role_verification_queries_show_a_read_only_role(self):
        v = self.verification
        self.assertEqual(v[0], "f|f|f|f|f|f|2|{default_transaction_read_only=on,statement_timeout=30s,lock_timeout=5s,idle_in_transaction_session_timeout=60s}")
        self.assertEqual(v[1:], ["0", "0", "0", "30|f|f|f", "f|f", "0"])

    def test_role_cannot_write_or_read_tokens_and_needs_its_password(self):
        def as_role(sql, url=None):
            return subprocess.run(["psql", url or self.role_url, "-X", "-At", "-c", sql], capture_output=True, text=True)
        self.assertEqual(as_role("SHOW default_transaction_read_only").stdout.strip(), "on")
        for sql in ['SELECT "accessToken" FROM "YahooConnection"', 'SELECT * FROM "YahooConnection"', 'SELECT * FROM "Manager"']:
            self.assertIn("permission denied", as_role(sql).stderr)
        for sql in ["SET transaction_read_only = off; INSERT INTO \"League\"(id, name, abbreviation, \"updatedAt\") VALUES ('x','x','x',now())",
                    "BEGIN READ WRITE; UPDATE \"Player\" SET name = 'x'; COMMIT", "CREATE TABLE pwn(i int)"]:
            self.assertNotEqual(as_role(sql).returncode, 0, sql)
        self.assertEqual(admin('SELECT count(*) FROM "Player" WHERE name = \'x\'').strip(), "0")
        wrong = self.role_url.replace(self.password, "wrong-password")
        self.assertIn("password authentication failed", as_role("SELECT 1", wrong).stderr)

    def test_success_path_end_to_end(self):
        code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual((code, ev["outcome"]), (0, "DRY_RUN_VALIDATED"), ev["stopReasons"])
        self.assertEqual(len(self.hits), 1)
        self.assertEqual(self.hits[0]["auth"], f"Bearer {TOKEN}")
        self.assertEqual([s["ok"] for s in ev["steps"]], [True] * len(ev["steps"]))
        self.assertEqual([s["step"] for s in ev["steps"]], [
            "audited script hashes unchanged", "preflight", "production unchanged by the dry run",
            "original JSON, intact envelope, generatedAt inside the request and the token's life",
            "python3 -I validate_dry_run.py", "cross-check SELECTs", "python3 -I waiver_fa_check.py"])
        day = datetime.now(UTC).date().isoformat()
        for f in [f"dry-run-{day}.json", f"dry-run-{day}.crosscheck.sql", f"dry-run-{day}.yahoo-sample.md", f"dry-run-{day}.summary.txt",
                  f"dry-run-{day}.waiver-fa.md", "validate_dry_run.output.txt", "waiver_fa_check.output.txt", "crosscheck-results.json",
                  "unresolved.md", "summary.md"]:
            self.assertTrue(os.path.exists(os.path.join(self.out, f)), f)
        cc = json.loads(read(os.path.join(self.out, "crosscheck-results.json")))
        self.assertEqual(cc["readOnly"][0]["transaction_read_only"], "on")
        self.assertTrue(all(r["ok"] for r in cc["results"]))
        self.assertIn("# Recovery preflight: DRY RUN VALIDATED", read(os.path.join(self.out, "summary.md")))
        self.assertIn("--- exit code 0 ---", read(os.path.join(self.out, "validate_dry_run.output.txt")))

    def test_outside_the_window_stops_without_calling_the_endpoint(self):
        past = datetime.now(UTC) - timedelta(minutes=1)
        with mock.patch.object(pf, "HARD_DEADLINE", (past.hour, past.minute)):
            code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual((code, ev["outcome"], self.hits), (1, "STOP", []))
        self.assertIn("hard deadline", ev["stopReasons"][0])

    def test_a_write_during_the_dry_run_is_a_stop(self):
        self.during = lambda: admin("INSERT INTO \"AuditLogEntry\"(id, \"actorName\", action, \"entityType\") VALUES ('w', 'x', 'YAHOO_TRANSACTION_RECOVERY_STARTED', 'x');")
        code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual((code, len(self.hits)), (1, 1))
        self.assertIn("production changed while the dry run ran", ev["stopReasons"][0])

    def test_an_error_answer_is_a_stop_with_the_error_kept(self):
        self.status = 409
        code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual((code, len(self.hits)), (1, 1))
        self.assertIn("HTTP 409", ev["stopReasons"][0])
        self.assertIn("expired", read(os.path.join(self.out, "dry-run-error.txt")))

    def test_a_validator_failure_stops_before_the_cross_checks(self):
        self.report = dict(self.report, yahoo=dict(self.report["yahoo"], complete=False, incompleteReason="test"))
        code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual(code, 1)
        self.assertIn("validate_dry_run.py exited 1", ev["stopReasons"][0])
        self.assertNotIn("cross-check SELECTs", [s["step"] for s in ev["steps"]])

    def test_a_cross_check_mismatch_is_a_stop(self):
        admin("DELETE FROM \"Team\" WHERE id = 'cmvbj15m9000asda4u4uua4em';")
        code = pf.main(["preflight.py", self.out])
        ev = self.evidence()
        self.assertEqual(code, 1)
        self.assertIn("C3 every team exists", ev["stopReasons"][0])


if __name__ == "__main__":
    unittest.main()
