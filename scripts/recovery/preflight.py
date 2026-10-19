#!/usr/bin/env python3
"""
Unattended, read-only preflight and dry run for the 2026 Yahoo transaction
recovery. Run by .github/workflows/recovery-preflight.yml; setup and the
operating procedure are in docs/recovery-preflight-automation.md.

Usage:  python3 -I scripts/recovery/preflight.py EVIDENCE_DIR

Environment (GitHub secrets, never printed):
  PREFLIGHT_DATABASE_URL  the read-only antlerboard_preflight login
  RECOVERY_DRYRUN_TOKEN   the dry-run GET's dedicated bearer token

Stops at the first failure:
  1. The three audited scripts must match their recorded hashes.
  2. Poll production (read-only) until today's scheduled sync has finished
     and settled. Every poll re-checks every gate: read-only session, clocks,
     baseline, the seven FYPD players, the sync (scheduled cron, PARTIAL, 907
     awaiting, 0 write errors) and the token. GO only inside
     [sync finish + 10 min, min(12:45 UTC, token expiry - 5 min)].
  3. On GO: one GET of the production dry run (never Apply), then the same
     snapshot again. Any difference is a STOP.
  4. validate_dry_run.py, then its SELECT-only cross-checks, then
     waiver_fa_check.py.
Exit 0 = the dry run was fetched and every check passed: evidence is ready for
the commissioner's review (it is not an approval to apply). Exit 1 = STOP.
Evidence (preflight.json, summary.md and every output) is written either way.
"""
import csv, hashlib, io, json, os, re, shutil, subprocess, sys, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# Production only, never a preview: the URL is fixed here, not configurable.
DRY_RUN_URL = "https://antlerboard.vercel.app/api/commissioner/yahoo-transaction-recovery?season=2026"

AUDITED_HASHES = {
    "validate_dry_run.py": "f8f55a06bb09e1b9e93e2df1ba2540903d6e1b90894478738dc82861d0f619c9",
    "waiver_fa_check.py": "5e9f4a9e230369185cd922d8b59a05b4330999ab8ea8f29f854d4e15bfcb979d",
    "window-checks.sql": "c4e40efc4140ec4ac22d7cd262bf80687a3fb083ae2480f49913125ece57409c",
}

BASELINE = {"legacy": 907, "keys_md5": "098de21868f2e3306d3a5df8ffc84b7f", "legacy_rows_detailed": 0, "recovery_audits": 0}
EXPECTED_SYNC = {"status": "PARTIAL", "legacy_awaiting": 907, "write_errors": 0}
LEAGUE_KEY, SEASON = "469.l.8891", 2026
FYPD_PLAYERS = {
    "cmubjpgy0001wgqsl6sqoo7u8": "Braden Montgomery",
    "cmubjph26003ggqslajf8accf": "Ryan Waldschmidt",
    "cmubjph2y003sgqsly95sf3rm": "Ryan Sloan",
    "cmubjpgxf001ogqsldnn2conf": "Hagen Smith",
    "cmubjpguv000ogqsleko5r9cb": "Jurrangelo Cijntje",
    "cmubjpkhx008jgqsl2iipko5a": "Tyler Bremner",
    "cmubjpkgi007zgqslb1znlsgr": "Seth Hernandez",
}

CRON_OPENS = (12, 0)        # vercel.json "0 12 * * *" - fires some time in that hour
HARD_DEADLINE = (12, 45)    # latest start, whatever the token says
SYNC_SETTLE = timedelta(minutes=10)
TOKEN_MARGIN = timedelta(minutes=5)
MAX_CLOCK_SKEW = timedelta(seconds=60)
POLL_SECONDS = 60
HTTP_TIMEOUT_SECONDS = 330  # the route's maxDuration is 300
MAX_REPORT_BYTES = 20_000_000

# Statements in any SQL this script runs must be plain SELECTs; on top of the
# read-only role and the read-only transaction.
FORBIDDEN_SQL = re.compile(
    r"\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|"
    r"DEALLOCATE|SET|RESET|LOCK|VACUUM|ANALYZE|CLUSTER|REINDEX|REFRESH|COMMENT|LISTEN|NOTIFY|UNLISTEN|BEGIN|START|"
    r"COMMIT|ROLLBACK|SAVEPOINT|RELEASE|DISCARD|IMPORT|LOAD|INTO|NEXTVAL|SETVAL|SET_CONFIG|DBLINK)\b|\bpg_\w+\s*\(",
    re.IGNORECASE,
)

SECRETS = []


class Stop(Exception):
    """Any failed, missing or inconsistent check: the run ends with STOP."""


# Overridden in tests only.
def utcnow():
    return datetime.now(timezone.utc)


def sleep(seconds):
    time.sleep(seconds)


def redact(text):
    for s in SECRETS:
        if s and len(s) >= 8:
            text = text.replace(s, "[redacted]")
    return text


def iso(d):
    return d.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if d else None


def ts(value):
    """A psql timestamp (session time zone UTC) as an aware UTC datetime, or None."""
    if value is None or value == "":
        return None
    v = value.strip().replace(" ", "T", 1)
    if re.search(r"[+-]\d\d$", v):
        v += ":00"
    d = datetime.fromisoformat(v.replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def at(day, hm):
    return datetime(day.year, day.month, day.day, hm[0], hm[1], tzinfo=timezone.utc)


def sha256_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def read_text(path):
    with open(path) as f:
        return f.read()


# --- SQL -----------------------------------------------------------------------

def select_statements(sql):
    """The statements of a SQL file, refusing anything but plain SELECTs."""
    body = "\n".join(l for l in sql.splitlines() if not l.lstrip().startswith("--"))
    masked = re.sub(r"'(?:[^']|'')*'", "''", body)
    masked = re.sub(r'"(?:[^"]|"")*"', '""', masked)
    if "--" in masked or "/*" in masked or "\\" in masked:
        raise Stop("SQL has an inline comment or psql meta-command; refusing to run it")
    stmts, masks = body.split(";"), masked.split(";")
    if len(stmts) != len(masks):
        raise Stop("SQL has a semicolon inside a literal; refusing to run it")
    out = []
    for stmt, mask in zip(stmts, masks):
        if not mask.strip():
            continue
        if not re.match(r"(?is)^\s*(SELECT|WITH)\b", mask) or FORBIDDEN_SQL.search(mask):
            raise Stop(f"SQL is not a plain SELECT; refusing to run it: {stmt.strip()[:80]}")
        out.append(stmt.strip())
    return out


def sql_file(name, expect):
    stmts = select_statements(read_text(os.path.join(HERE, name)))
    if len(stmts) != expect:
        raise Stop(f"{name} has {len(stmts)} statements, expected {expect}")
    return stmts


def parse_sections(text):
    out, label, buf = {}, None, []
    def flush():
        if label is not None:
            out[label] = list(csv.DictReader(io.StringIO("".join(buf))))
    for line in text.splitlines(keepends=True):
        if line.startswith("@@@"):
            flush()
            label, buf = line[3:].strip(), []
        elif label is not None:
            buf.append(line)
    flush()
    return out


class Db:
    """psql as the read-only role, one REPEATABLE READ READ ONLY transaction per call."""

    def __init__(self, url):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("postgres", "postgresql") or not u.hostname or not u.username or not u.path.strip("/"):
            raise Stop("PREFLIGHT_DATABASE_URL isn't a complete postgresql:// URL")
        q = dict(urllib.parse.parse_qsl(u.query))
        password = urllib.parse.unquote(u.password or "")
        SECRETS.append(password)
        self.env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "LC_ALL")}
        self.env.update({
            "PGHOST": u.hostname, "PGPORT": str(u.port or 5432), "PGUSER": urllib.parse.unquote(u.username),
            "PGPASSWORD": password, "PGDATABASE": u.path.strip("/"), "PGSSLMODE": q.get("sslmode", "require"),
            "PGTZ": "UTC", "PGOPTIONS": "-c default_transaction_read_only=on", "PGCONNECT_TIMEOUT": "30",
            "PGAPPNAME": "antlerboard-recovery-preflight",
        })
        if "channel_binding" in q:
            self.env["PGCHANNELBINDING"] = q["channel_binding"]

    def query(self, labelled):
        lines = [
            "\\set ON_ERROR_STOP on",
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;",
            "SET LOCAL TIME ZONE 'UTC';",
            "\\echo @@@ro",
            "SELECT current_setting('transaction_read_only') AS transaction_read_only, current_user AS db_user, "
            "now() AS db_now, current_setting('server_version') AS server_version;",
        ]
        for label, stmt in labelled:
            lines += [f"\\echo @@@{label}", stmt + ";"]
        lines.append("COMMIT;")
        try:
            p = subprocess.run(["psql", "-X", "-q", "--csv", "-f", "-"], input="\n".join(lines) + "\n",
                               env=self.env, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise Stop("database query timed out")
        if p.returncode != 0:
            raise Stop("database query failed: " + (redact(p.stderr.strip())[:1000] or f"psql exit {p.returncode}"))
        out = parse_sections(p.stdout)
        missing = [l for l in ["ro"] + [l for l, _ in labelled] if l not in out]
        if missing:
            raise Stop(f"database returned no result for {', '.join(missing)}")
        return out

    def snapshot(self):
        labelled = list(zip(["W1", "W2", "W3", "W4"], sql_file("window-checks.sql", 4)))
        labelled += list(zip(["F1", "F2"], sql_file("fypd-unlinked.sql", 2)))
        labelled += list(zip(["P1"], sql_file("write-probe.sql", 1)))
        return self.query(labelled)


# --- The gate ------------------------------------------------------------------

def evaluate(snap, runner_now):
    """GO, WAIT or STOP for one snapshot. Missing or unreadable evidence is never a pass."""
    v = {"decision": None, "checks": [], "failures": [], "waiting": None, "now": None,
         "earliest": None, "deadline": None, "token_expires": None, "sync": None, "evidence": {}}
    def check(name, ok, evidence):
        v["checks"].append({"check": name, "ok": bool(ok), "evidence": evidence})
        if not ok:
            v["failures"].append(f"{name} ({evidence})")
        return bool(ok)
    def rows(label, n=None):
        r = snap.get(label)
        if r is None or (n is not None and len(r) != n):
            got = "no result" if r is None else f"{len(r)} rows"
            raise Stop(f"{label}: expected {n} row(s), got {got}")
        return r
    def done(decision, waiting=None):
        v["decision"], v["waiting"] = decision, waiting
        return v
    try:
        ro = rows("ro", 1)[0]
        check("database session is read-only", ro["transaction_read_only"] == "on",
              f"transaction_read_only={ro['transaction_read_only']}, user={ro['db_user']}")
        db_now = ts(ro["db_now"])
        skew = abs(runner_now - db_now)
        check("runner and database clocks agree", skew <= MAX_CLOCK_SKEW,
              f"runner {iso(runner_now)}, database {iso(db_now)}, skew {skew.total_seconds():.1f}s")
        now = max(runner_now, db_now)
        day = now.date()
        hard = at(day, HARD_DEADLINE)
        v["now"], v["deadline"] = now, hard
        check("before the hard deadline", now <= hard, f"now {iso(now)}, hard deadline {iso(hard)}")

        w4 = rows("W4", 1)[0]
        v["evidence"]["baseline"] = w4
        for key, want in BASELINE.items():
            got = w4[key]
            check(f"baseline {key} = {want}", got == str(want), f"got {got}")

        f1 = rows("F1")
        v["evidence"]["fypd_players"] = f1
        v["evidence"]["proposed_yahoo_ids_in_use"] = rows("F2")
        found = {r["id"]: r for r in f1}
        check("all seven FYPD players present", set(found) == set(FYPD_PLAYERS),
              f"found {len(found)}: missing {sorted(set(FYPD_PLAYERS) - set(found))}")
        linked = [f"{r['name']}={r['yahooPlayerId']}" for r in f1 if r["yahooPlayerId"] != ""]
        check("all seven FYPD players still lack Yahoo ids", not linked and len(f1) == 7, ", ".join(linked) or f"{len(f1)} rows")

        w1 = rows("W1", 1)[0]
        v["evidence"]["connection"] = w1
        v["evidence"]["write_probe"] = rows("P1", 1)[0]
        if v["failures"]:
            return done("STOP")

        cron_open = at(day, CRON_OPENS)
        w3 = rows("W3")
        cron = w3[0] if w3 and ts(w3[0]["createdAt"]) >= cron_open else None
        if cron is None:
            last = iso(ts(w3[0]["createdAt"])) if w3 else "never"
            return done("WAIT", f"today's scheduled sync hasn't been recorded yet (last scheduled run {last})")

        w2 = rows("W2", 1)[0]
        v["evidence"]["sync"] = w2
        v["evidence"]["cron"] = cron
        result = json.loads(cron["result"] or "null") or {}
        started, finished = ts(w2["startedAt"]), ts(w2["finishedAt"])
        v["sync"] = {"id": w2["id"], "startedAt": iso(started), "finishedAt": iso(finished), "status": w2["status"]}
        check("today's sync ran from the schedule", cron["actorName"] == "Vercel Cron" and result.get("outcome") == "synced",
              f"actor {cron['actorName']}, outcome {result.get('outcome')}, at {iso(ts(cron['createdAt']))}")
        check("the latest sync log is the scheduled run's", result.get("syncLogId") == w2["id"],
              f"cron logged {result.get('syncLogId')}, latest is {w2['id']}")
        check("the sync started today after 12:00 UTC", started is not None and started >= cron_open, f"started {iso(started)}")
        check("the sync finished", finished is not None, f"finished {iso(finished)}")
        check(f"sync status {EXPECTED_SYNC['status']}", w2["status"] == EXPECTED_SYNC["status"], f"got {w2['status']}")
        check(f"{EXPECTED_SYNC['legacy_awaiting']} transactions awaiting recovery",
              w2["legacy_awaiting"] == str(EXPECTED_SYNC["legacy_awaiting"]), f"got {w2['legacy_awaiting'] or 'missing'}")
        check(f"{EXPECTED_SYNC['write_errors']} write errors", w2["write_errors"] == str(EXPECTED_SYNC["write_errors"]),
              f"got {w2['write_errors'] or 'missing'}")
        expires = ts(w1["tokenExpiresAt"])
        v["token_expires"] = expires
        check("the token was refreshed by today's sync", expires is not None and started is not None and expires > started,
              f"token expires {iso(expires)}, sync started {iso(started)}")
        if v["failures"]:
            return done("STOP")

        earliest = finished + SYNC_SETTLE
        deadline = min(hard, expires - TOKEN_MARGIN)
        v["earliest"], v["deadline"] = earliest, deadline
        check("a start window exists today", earliest <= deadline, f"earliest {iso(earliest)}, deadline {iso(deadline)}")
        check("inside the token margin", now <= deadline,
              f"now {iso(now)}, deadline {iso(deadline)} (token expires {iso(expires)})")
        if v["failures"]:
            return done("STOP")
        if now < earliest:
            return done("WAIT", f"letting Yahoo's rate limit recover until {iso(earliest)}")
        return done("GO")
    except Stop as e:
        v["failures"].append(str(e))
        return done("STOP")
    except (KeyError, ValueError, TypeError, AttributeError) as e:
        v["failures"].append(f"unreadable evidence: {type(e).__name__}: {e}")
        return done("STOP")


# Everything the dry run must leave untouched. Volatile values (now, remaining) are left out.
INVARIANTS = {
    "W1": ["tokenExpiresAt", "lastSyncAttemptAt", "lastSyncSuccessAt", "lastSyncStatus"],
    "W2": ["id", "startedAt", "finishedAt", "status", "tx_counts"],
    "W3": ["createdAt", "actorName", "result"],
    "W4": None, "F1": None, "F2": None, "P1": None,
}


def changed(before, after):
    diffs = []
    for label, cols in INVARIANTS.items():
        b, a = before.get(label), after.get(label)
        if b is None or a is None:
            diffs.append(f"{label} missing")
            continue
        pick = (lambda rs: rs) if cols is None else (lambda rs: [{c: r.get(c) for c in cols} for r in rs])
        if pick(b) != pick(a):
            diffs.append(f"{label}: {pick(b)} -> {pick(a)}")
    return diffs


def crosscheck_expectations(report):
    """What validate_dry_run.py's cross-check queries must return, recomputed from the report."""
    recs = report["records"]
    ids = sorted(x["yahooTransactionId"] for x in recs)
    ready = [x for x in recs if x["status"] == "ready"]
    players = {q["playerId"] for x in ready for q in x["proposed"]["players"] if q["playerId"]}
    teams = {t["teamId"] for x in ready for t in x["proposed"]["teams"]}
    return [
        ("C1 targets match production's legacy rows", {"n": str(len(ids)), "md5": hashlib.md5(",".join(ids).encode()).hexdigest()}),
        ("C2 every matched player exists", {"count": str(len(players))}),
        ("C3 every team exists and is linked to the league", {"count": str(len(teams))}),
        ("C4 no player-to-create already exists", {"count": "0"}),
        ("C5 nothing written since the report", {"detailed_before_report": "0", "recovery_audits": "0"}),
    ]


# --- HTTP ----------------------------------------------------------------------

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # a redirect is answered as an HTTPError, and the token never follows it


def http_get(url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json", "User-Agent": "antlerboard-recovery-preflight"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT_SECONDS) as r:
            return r.status, r.headers.get("content-type", ""), r.read(MAX_REPORT_BYTES + 1)
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", "") if e.headers else "", e.read(MAX_REPORT_BYTES + 1)
    except Exception as e:
        raise Stop(f"dry-run request failed: {type(e).__name__}")


# --- Evidence ------------------------------------------------------------------

class Evidence:
    def __init__(self, out_dir):
        self.dir = out_dir
        self.data = {"tool": "scripts/recovery/preflight.py", "startedAt": iso(utcnow()), "outcome": "STOP",
                     "stopReasons": [], "hashes": {}, "polls": [], "gate": None, "dryRun": None, "steps": []}

    def path(self, name):
        return os.path.join(self.dir, name)

    def log(self, msg):
        print(f"{iso(utcnow())}  {redact(msg)}", flush=True)

    def poll(self, v):
        entry = {"at": iso(v["now"]) if v["now"] else iso(utcnow()), "decision": v["decision"],
                 "reason": v["waiting"] or "; ".join(v["failures"]) or None}
        self.data["polls"].append(entry)
        self.log(f"{entry['decision']}: {entry['reason'] or 'every check passed'}")

    def gate(self, v):
        self.data["gate"] = {
            "decision": v["decision"], "now": iso(v["now"]), "earliestStart": iso(v["earliest"]),
            "latestStart": iso(v["deadline"]), "tokenExpiresAt": iso(v["token_expires"]), "sync": v["sync"],
            "checks": v["checks"], "failures": v["failures"], "evidence": v["evidence"]}

    def step(self, name, ok, **extra):
        self.data["steps"].append({"step": name, "ok": ok, **extra})

    def write(self):
        self.data["finishedAt"] = iso(utcnow())
        with open(self.path("preflight.json"), "w") as f:
            f.write(redact(json.dumps(self.data, indent=2, default=str)) + "\n")
        with open(self.path("summary.md"), "w") as f:
            f.write(redact(self.markdown()))

    def markdown(self):
        d, g = self.data, self.data["gate"] or {}
        ok = d["outcome"] == "DRY_RUN_VALIDATED"
        md = ["# Recovery preflight: " + ("DRY RUN VALIDATED" if ok else "STOP"), ""]
        md.append("Read-only. Nothing was applied, linked or written. " +
                  ("The report is ready for the commissioner's review; this is not an approval to apply."
                   if ok else "Nothing further runs today."))
        if d["stopReasons"]:
            md += ["", "## Why it stopped", ""] + [f"- {r}" for r in d["stopReasons"]]
        md += ["", "## Window", "", "| | UTC |", "|---|---|",
               f"| Run started | {d['startedAt']} |", f"| Last check | {g.get('now') or '-'} |",
               f"| Sync finished | {(g.get('sync') or {}).get('finishedAt') or '-'} |",
               f"| Earliest start (finish + 10 min) | {g.get('earliestStart') or '-'} |",
               f"| Latest start (min of 12:45, token expiry - 5 min) | {g.get('latestStart') or '-'} |",
               f"| Token expires | {g.get('tokenExpiresAt') or '-'} |",
               f"| Polls | {len(d['polls'])} |"]
        if g.get("checks"):
            md += ["", "## Preflight checks (last poll)", "", "| Check | Result | Evidence |", "|---|---|---|"]
            md += [f"| {c['check']} | {'pass' if c['ok'] else '**FAIL**'} | {c['evidence']} |" for c in g["checks"]]
        if d["hashes"]:
            md += ["", "## Audited script hashes", ""] + [f"- `{k}` {v}" for k, v in d["hashes"].items()]
        if d["dryRun"]:
            md += ["", "## Dry run", ""] + [f"- {k}: {v}" for k, v in d["dryRun"].items()]
        if d["steps"]:
            md += ["", "## Steps", "", "| Step | Result | Detail |", "|---|---|---|"]
            md += [f"| {s['step']} | {'pass' if s['ok'] else '**FAIL**'} | {s.get('detail', '')} |" for s in d["steps"]]
        for name in ("validate_dry_run.output.txt", "waiver_fa_check.output.txt"):
            if os.path.exists(self.path(name)):
                md += ["", f"## `{name}`", "", "```", read_text(self.path(name)).rstrip(), "```"]
        for name in sorted(os.listdir(self.dir)):
            if name.endswith((".yahoo-sample.md", ".waiver-fa.md", "unresolved.md")):
                md += ["", read_text(self.path(name))]
        return "\n".join(md) + "\n"


# --- The run -------------------------------------------------------------------

def verify_hashes(ev):
    for name, want in AUDITED_HASHES.items():
        got = sha256_file(os.path.join(HERE, name))
        ev.data["hashes"][name] = got
        if got != want:
            raise Stop(f"{name} hash {got} differs from the audited {want}")
    ev.step("audited script hashes unchanged", True, detail=", ".join(f"{k} {v[:8]}" for k, v in AUDITED_HASHES.items()))


def run_script(ev, name, args, out_name):
    p = subprocess.run([sys.executable, "-I", os.path.join(HERE, name), *args], capture_output=True, text=True,
                       cwd=ev.dir, timeout=300)
    with open(ev.path(out_name), "w") as f:
        f.write(redact(p.stdout) + (("\n--- stderr ---\n" + redact(p.stderr)) if p.stderr else "") + f"\n--- exit code {p.returncode} ---\n")
    ev.step(f"python3 -I {name}", p.returncode == 0, detail=f"exit {p.returncode}; output in {out_name}")
    if p.returncode != 0:
        raise Stop(f"{name} exited {p.returncode} (see {out_name})")


def unresolved_markdown(report):
    rows = [x for x in report["records"] if x["status"] != "ready"]
    md = ["# Records that are not ready", "", f"{len(rows)} of {len(report['records'])}.", "",
          "| Yahoo key | Status | Issues |", "|---|---|---|"]
    md += [f"| {x['yahooTransactionId']} | {x['status']} | {'; '.join(x.get('issues') or [])} |" for x in rows]
    return "\n".join(md) + "\n"


def run(ev):
    verify_hashes(ev)
    url, token = os.environ.get("PREFLIGHT_DATABASE_URL", ""), os.environ.get("RECOVERY_DRYRUN_TOKEN", "")
    SECRETS.extend([url, token])
    if not url or not token:
        raise Stop("PREFLIGHT_DATABASE_URL or RECOVERY_DRYRUN_TOKEN isn't set")
    if shutil.which("psql") is None:
        raise Stop("psql isn't installed on the runner")
    db = Db(url)

    while True:
        snap = db.snapshot()
        v = evaluate(snap, utcnow())
        ev.poll(v)
        ev.gate(v)
        if v["decision"] == "STOP":
            raise Stop("; ".join(v["failures"]))
        if v["decision"] == "GO":
            break
        now, target = v["now"], v["earliest"] or (v["now"] + timedelta(seconds=POLL_SECONDS))
        hard = at(now.date(), HARD_DEADLINE)
        sleep(max(5, min(POLL_SECONDS, (min(target, hard + timedelta(seconds=1)) - now).total_seconds())))
    before, deadline, expires = snap, v["deadline"], v["token_expires"]
    ev.step("preflight", True, detail=f"GO at {iso(v['now'])}; latest start {iso(deadline)}")

    day = v["now"].date().isoformat()
    start = utcnow()
    if start > deadline:
        raise Stop(f"the deadline {iso(deadline)} passed before the request could start")
    ev.log(f"GET {DRY_RUN_URL}")
    status, ctype, body = http_get(DRY_RUN_URL, token)
    end = utcnow()
    ev.data["dryRun"] = {"url": DRY_RUN_URL, "requestStartedAt": iso(start), "requestFinishedAt": iso(end),
                         "httpStatus": status, "contentType": ctype, "bytes": len(body)}
    if status != 200:
        with open(ev.path("dry-run-error.txt"), "w") as f:
            f.write(redact(body[:4000].decode("utf-8", "replace")) + "\n")
        raise Stop(f"the dry run answered HTTP {status} (see dry-run-error.txt)")
    if len(body) > MAX_REPORT_BYTES:
        raise Stop("the dry-run report is larger than 20 MB")
    report_path = ev.path(f"dry-run-{day}.json")
    with open(report_path, "wb") as f:
        f.write(body)  # byte for byte as served
    ev.data["dryRun"].update({"file": os.path.basename(report_path), "sha256": hashlib.sha256(body).hexdigest()})

    after = db.snapshot()
    diffs = changed(before, after)
    ev.step("production unchanged by the dry run", not diffs, detail="; ".join(diffs) or "every snapshot value identical before and after")
    if diffs:
        raise Stop("production changed while the dry run ran: " + "; ".join(diffs))

    try:
        report = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Stop(f"the report isn't valid JSON: {e}")
    generated = ts(report.get("generatedAt")) if isinstance(report, dict) else None
    ev.data["dryRun"].update({"generatedAt": iso(generated), "fingerprint": report.get("fingerprint") if isinstance(report, dict) else None})
    envelope = isinstance(report, dict) and report.get("mode") == "dry-run" and report.get("leagueKey") == LEAGUE_KEY \
        and report.get("seasonYear") == SEASON and isinstance(report.get("records"), list) \
        and re.fullmatch(r"[0-9a-f]{64}", str(report.get("fingerprint"))) is not None
    in_window = generated is not None and start - timedelta(seconds=5) <= generated <= end + timedelta(seconds=5) and generated <= expires
    ev.step("original JSON, intact envelope, generatedAt inside the request and the token's life", envelope and in_window,
            detail=f"generatedAt {iso(generated)}, request {iso(start)}..{iso(end)}, token expires {iso(expires)}")
    if not (envelope and in_window):
        raise Stop("the report's envelope or generatedAt failed the check")

    run_script(ev, "validate_dry_run.py", [report_path, ev.dir], "validate_dry_run.output.txt")

    cc_path = ev.path(f"dry-run-{day}.crosscheck.sql")
    stmts = select_statements(read_text(cc_path))
    expect = crosscheck_expectations(report)
    if len(stmts) != len(expect):
        raise Stop(f"cross-check SQL has {len(stmts)} statements, expected {len(expect)}")
    res = db.query([(f"C{i + 1}", s) for i, s in enumerate(stmts)])
    results, failed = [], []
    for i, (name, want) in enumerate(expect):
        got = res[f"C{i + 1}"][0] if len(res[f"C{i + 1}"]) == 1 else {}
        ok = all(got.get(k) == val for k, val in want.items())
        results.append({"check": name, "expected": want, "got": got, "ok": ok})
        if not ok:
            failed.append(name)
    c1 = res["C1"][0] if res["C1"] else {}
    base_ok = c1.get("n") == str(BASELINE["legacy"]) and c1.get("md5") == BASELINE["keys_md5"]
    results.append({"check": "C1 equals the baseline", "expected": {"n": str(BASELINE["legacy"]), "md5": BASELINE["keys_md5"]}, "got": c1, "ok": base_ok})
    if not base_ok:
        failed.append("C1 equals the baseline")
    with open(ev.path("crosscheck-results.json"), "w") as f:
        json.dump({"readOnly": res["ro"], "results": results}, f, indent=2)
    ev.step("cross-check SELECTs", not failed and res["ro"][0]["transaction_read_only"] == "on",
            detail="; ".join(failed) or f"{len(results)} checks match (crosscheck-results.json)")
    if failed:
        raise Stop("cross-check mismatch: " + "; ".join(failed))

    run_script(ev, "waiver_fa_check.py", [report_path], "waiver_fa_check.output.txt")
    with open(ev.path("unresolved.md"), "w") as f:
        f.write(unresolved_markdown(report))
    ev.data["outcome"] = "DRY_RUN_VALIDATED"


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 1
    os.makedirs(argv[1], exist_ok=True)
    ev = Evidence(argv[1])
    try:
        run(ev)
        code = 0
    except Stop as e:
        ev.data["outcome"], code = "STOP", 1
        ev.data["stopReasons"].append(str(e))
    except Exception as e:  # anything unexpected is a STOP as well
        ev.data["outcome"], code = "STOP", 1
        ev.data["stopReasons"].append(f"unexpected error: {type(e).__name__}: {e}")
    ev.write()
    ev.log(f"outcome {ev.data['outcome']}" + (": " + "; ".join(ev.data["stopReasons"]) if ev.data["stopReasons"] else ""))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
