#!/usr/bin/env python3
"""
Read-only validator for an Antlerboard Yahoo transaction-recovery dry-run report.

Usage:  python3 -I validate_dry_run.py REPORT.json [OUT_DIR]

Reads the JSON file only. Never touches the database, Yahoo, or the network.
Writes three files into OUT_DIR (default: next to the report):
  - <report>.crosscheck.sql   read-only SELECTs to run against production
  - <report>.yahoo-sample.md  a stratified sample to compare against Yahoo's own pages
  - <report>.summary.txt      everything printed below
Exit code 0 = no blocking findings, 1 = blocking findings (do not apply).
"""
import json, os, re, sys, random, hashlib
from collections import Counter

if len(sys.argv) < 2:
    sys.exit(__doc__)
path = sys.argv[1]
out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(path))
base = os.path.join(out_dir, os.path.basename(path).rsplit(".", 1)[0])
r = json.load(open(path))
lines, blocking, warnings = [], [], []
def say(s=""): lines.append(s); print(s)
def block(s): blocking.append(s)
def warn(s): warnings.append(s)

EXPECT_LEAGUE, EXPECT_SEASON = "469.l.8891", 2026
TYPE_FOR = {"drop": {"DROP"}, "trade": {"TRADE"}, "commish": {"COMMISSIONER_CORRECTION"},
            "add": {"WAIVER_ADD", "FREE_AGENT_ADD"}, "add/drop": {"WAIVER_ADD", "FREE_AGENT_ADD"}}
STATUSES = ["ready", "unresolved", "unsupported", "malformed", "missing_in_yahoo", "not_checked"]

# --- A. Envelope ---------------------------------------------------------------
say("== A. Report envelope")
if r.get("mode") != "dry-run": block(f"mode is {r.get('mode')!r}, not 'dry-run'")
if r.get("leagueKey") != EXPECT_LEAGUE: block(f"leagueKey {r.get('leagueKey')} != {EXPECT_LEAGUE}")
if r.get("seasonYear") != EXPECT_SEASON: block(f"seasonYear {r.get('seasonYear')} != {EXPECT_SEASON}")
if not re.fullmatch(r"[0-9a-f]{64}", r.get("fingerprint", "")): block("fingerprint missing or malformed")
y = r.get("yahoo", {})
say(f"generatedAt {r.get('generatedAt')}  fingerprint {r.get('fingerprint')}")
say(f"Yahoo: pages={y.get('pages')} read={y.get('transactionsRead')} keyless={y.get('entriesWithoutKey')} complete={y.get('complete')} reason={y.get('incompleteReason')}")
if y.get("complete") is not True: block(f"Yahoo log not read to the end: {y.get('incompleteReason')} - re-run the dry run; apply would refuse anyway")
if y.get("entriesWithoutKey"): warn(f"{y.get('entriesWithoutKey')} Yahoo entries had no transaction_key")

recs = r.get("records", [])
ids = [x["yahooTransactionId"] for x in recs]
if len(recs) != r.get("targets"): block(f"records ({len(recs)}) != targets ({r.get('targets')})")
if len(set(ids)) != len(ids): block("duplicate yahooTransactionId in records")
if any(not i.startswith(EXPECT_LEAGUE + ".tr.") for i in ids): block("a record key is not from league " + EXPECT_LEAGUE)
recount = Counter(x["status"] for x in recs)
if any(recount.get(s, 0) != r["summary"].get(s, 0) for s in STATUSES): block(f"summary {r['summary']} disagrees with records {dict(recount)}")

# --- B. Counts -----------------------------------------------------------------
say("\n== B. Counts")
say(f"targets {r.get('targets')}  " + "  ".join(f"{s}={r['summary'].get(s,0)}" for s in STATUSES))
say(f"proposedTypes {r.get('proposedTypes')}")
say(f"playersToCreate {len(r.get('playersToCreate', []))}   onlyInYahoo {len(r.get('onlyInYahoo', []))}")
if r["summary"].get("not_checked"): block("not_checked > 0 - log incomplete")
if r["summary"].get("missing_in_yahoo"): warn(f"{r['summary']['missing_in_yahoo']} stored rows are not in Yahoo's complete log - review before apply (they are never written)")

# --- C. Ready-record integrity --------------------------------------------------
say("\n== C. Ready-record integrity")
ready = [x for x in recs if x["status"] == "ready"]
legacy_label = re.compile(r"^Synced from Yahoo \((.+)\)$")
problems = Counter(); examples = {}
def bad(kind, rec, detail=""):
    problems[kind] += 1; examples.setdefault(kind, f"{rec['yahooTransactionId']} {detail}".strip())
for x in ready:
    p = x.get("proposed")
    if not p: bad("ready without proposal", x); continue
    if x.get("issues"): bad("ready with issues", x, str(x["issues"][:1]))
    if p["type"] not in TYPE_FOR.get(p["yahooType"], set()): bad("type does not match Yahoo type", x, f"{p['yahooType']}->{p['type']}")
    m = legacy_label.match(x["current"].get("notes") or "")
    if not m: bad("current row lacks the first sync's 'Synced from Yahoo (...)' note", x)
    elif m.group(1) != p["yahooType"]: bad("Yahoo type differs from what the first sync recorded", x, f"{m.group(1)} vs {p['yahooType']}")
    if p["dateUnavailable"] or not p["date"]: bad("ready but date unavailable", x)
    elif x["current"]["date"] != p["date"]: bad("date differs from the stored (first-sync) date", x, f"{x['current']['date']} vs {p['date']}")
    if p["yahooStatus"] != "successful": bad("status is not 'successful'", x, str(p["yahooStatus"]))
    pl = p["players"]
    if p["yahooType"] != "commish" and not pl: bad("non-commish without players", x)
    for q in pl:
        if not q["playerId"] and not q["createsPlayer"]: bad("player neither matched nor created", x, q["name"])
    acts = Counter(q["action"] for q in pl)
    if p["yahooType"] == "add/drop" and not (acts["add"] and acts["drop"]): bad("add/drop missing a half", x, str(dict(acts)))
    if p["yahooType"] == "trade" and len({t["teamId"] for t in p["teams"]}) < 2: bad("trade with <2 teams", x)
    if p["yahooType"] in ("add", "add/drop", "drop") and not p["teams"]: bad("move without a team", x)
    if p["faabBid"] is not None and p["type"] != "WAIVER_ADD": bad("FAAB on a non-waiver move", x, f"{p['type']} ${p['faabBid']}")
    if p["faabBid"] is not None and not (0 <= p["faabBid"] <= 1000): bad("FAAB out of range", x, str(p["faabBid"]))
for k, n in problems.most_common():
    say(f"  {n:4d}  {k}   e.g. {examples[k]}")
    (warn if k.startswith("date differs") else block)(f"{n} ready record(s): {k}")
if not problems: say("  all ready records pass")

# --- D. Why records are not ready -----------------------------------------------
say("\n== D. Not-ready reasons (grouped)")
def bucket(msg):
    for pat, name in [(r"gave no team key", "Yahoo sent no team key"), (r"isn't linked to an Antlerboard team", "Yahoo team key not linked"),
                      (r"more than one Antlerboard player", "ambiguous player (duplicate Yahoo id)"), (r"unlinked player\(s\) share the name", "unlinked same-name player"),
                      (r"no usable timestamp", "no timestamp"), (r"Unreadable player", "unreadable player"), (r"Not in Yahoo", "not in Yahoo log"),
                      (r"isn't supported|can't be determined", "unsupported type/source"), (r"Fewer than two teams", "trade with <2 teams")]:
        if re.search(pat, msg): return name
    return "other: " + msg[:80]
reasons = Counter(bucket(i) for x in recs if x["status"] != "ready" for i in x["issues"])
for k, n in reasons.most_common(): say(f"  {n:4d}  {k}")
if reasons.get("Yahoo sent no team key", 0) > 0.5 * max(1, len(recs)):
    block("Most records lack Yahoo team keys - the team-key field assumption failed; stop and fix the parser before any apply")
names = Counter(bucket(i) for x in recs for i in x["issues"] if "share the name" in i)

# --- E. Players to create --------------------------------------------------------
say("\n== E. Players the apply would create (Yahoo id, name)")
for p in sorted(r.get("playersToCreate", []), key=lambda p: p["name"]): say(f"  {p['yahooPlayerId']:>8}  {p['name']}")

# --- F. Outputs: SQL cross-check + Yahoo sample ----------------------------------
keys_sorted = sorted(ids)
md5 = hashlib.md5(",".join(keys_sorted).encode()).hexdigest()
player_ids = sorted({q["playerId"] for x in ready for q in x["proposed"]["players"] if q["playerId"]})
team_ids = sorted({t["teamId"] for x in ready for t in x["proposed"]["teams"]})
create_ids = sorted({p["yahooPlayerId"] for p in r.get("playersToCreate", [])})
lit = lambda xs: ",".join("'" + s.replace("'", "''") + "'" for s in xs) or "NULL"
sql = f"""-- Read-only cross-checks for dry run {r.get('fingerprint')}  (run as SELECTs only)
-- 1. Targets: the report's records are exactly production's legacy rows (expect md5 = {md5}, n = {len(ids)})
SELECT count(*) n, md5(string_agg("yahooTransactionId", ',' ORDER BY "yahooTransactionId" COLLATE "C")) md5
FROM "Transaction" WHERE "yahooTransactionId" LIKE '{EXPECT_LEAGUE}.tr.%' AND "yahooType" IS NULL;
-- 2. Every matched player exists (expect {len(player_ids)})
SELECT count(*) FROM "Player" WHERE id IN ({lit(player_ids)});
-- 3. Every team exists and is Yahoo-linked to this league (expect {len(team_ids)})
SELECT count(*) FROM "Team" WHERE id IN ({lit(team_ids)}) AND "yahooTeamId" LIKE '{EXPECT_LEAGUE}.t.%';
-- 4. No player-to-create already exists under any Yahoo id form (expect 0)
SELECT count(*) FROM "Player" WHERE "yahooPlayerId" IN ({lit(create_ids)})
   OR substring("yahooPlayerId" from '\\.p\\.(\\d+)$') IN ({lit(create_ids)});
-- 5. Nothing changed since the dry run: no detailed rows yet, no recovery audit entries
SELECT (SELECT count(*) FROM "Transaction" WHERE "yahooType" IS NOT NULL AND "yahooTransactionId" LIKE '{EXPECT_LEAGUE}.tr.%' AND "yahooDetailSyncedAt" < '{r.get('generatedAt')}') detailed_before_report,
       (SELECT count(*) FROM "AuditLogEntry" WHERE action LIKE 'YAHOO_TRANSACTION_RECOVERY%') recovery_audits;
"""
open(base + ".crosscheck.sql", "w").write(sql)

random.seed(r.get("fingerprint"))
pick = []
for want in ["trade", "add/drop", "commish", "drop", "add"]:
    pool = [x for x in ready if x["proposed"]["yahooType"] == want and x not in pick]
    pick += random.sample(pool, min(2 if want in ("trade", "add/drop") else 1, len(pool)))
faab = [x for x in ready if x["proposed"]["faabBid"] and x not in pick]
pick += random.sample(faab, min(2, len(faab)))
rest = [x for x in ready if x not in pick]
pick += random.sample(rest, min(max(0, 12 - len(pick)), len(rest)))
md = ["# Yahoo comparison sample", f"Report {r.get('fingerprint')}. For each row, open the league's transaction history on Yahoo",
      "(https://baseball.fantasysports.yahoo.com/b1/8891/transactions) and confirm date/time, teams, players, add vs drop, FAAB.", "",
      "| Yahoo key | Yahoo type -> stored type | When (UTC) | FAAB | Moves | Matches Yahoo? |", "|---|---|---|---|---|---|"]
for x in sorted(pick, key=lambda x: x["proposed"]["date"] or ""):
    p = x["proposed"]
    moves = "; ".join(f"{q['action']} {q['name']} ({q['from']} -> {q['to']})" + (" [new player]" if q["createsPlayer"] else "") for q in p["players"]) or "(no players - commissioner move)"
    md.append(f"| {x['yahooTransactionId']} | {p['yahooType']} -> {p['type']} | {p['date']} | {p['faabBid'] if p['faabBid'] is not None else ''} | {moves} | ☐ |")
open(base + ".yahoo-sample.md", "w").write("\n".join(md) + "\n")

say("\n== Verdict")
for b in blocking: say("  BLOCKING: " + b)
for w in warnings: say("  review:   " + w)
say("  " + ("NO BLOCKING FINDINGS - ready for your review (not an approval)" if not blocking else "DO NOT APPLY - resolve the blocking findings first"))
say(f"\nwrote {base}.crosscheck.sql, {base}.yahoo-sample.md")
open(base + ".summary.txt", "w").write("\n".join(lines) + "\n")
sys.exit(1 if blocking else 0)
