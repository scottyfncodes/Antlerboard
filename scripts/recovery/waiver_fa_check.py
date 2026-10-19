#!/usr/bin/env python3
"""
Supplementary read-only check (does not replace validate_dry_run.py): waiver vs free-agent adds.

Usage:  python3 -I waiver_fa_check.py REPORT.json
Reads the JSON file only. Writes <report>.waiver-fa.md next to it.

Evidence it gathers, per proposed add (WAIVER_ADD / FREE_AGENT_ADD):
  - the added player's Yahoo source_type as reported ("from": waivers / freeagents)
  - FAAB present or not
  - the hour (UTC) of the transaction: Yahoo processes waiver claims in a batch at a fixed
    time, so genuine waiver adds should cluster in one hour band; free-agent adds should not.
And picks a stratified comparison sample: 3 FREE_AGENT_ADD, 3 WAIVER_ADD without FAAB,
2 WAIVER_ADD with FAAB (seeded by the report fingerprint, so it is reproducible).
"""
import json, os, sys, random
from collections import Counter

r = json.load(open(sys.argv[1]))
ready = [x for x in r["records"] if x["status"] == "ready" and x.get("proposed")]
adds = [x for x in ready if x["proposed"]["type"] in ("WAIVER_ADD", "FREE_AGENT_ADD")]
out = []
def say(s=""): out.append(s); print(s)

def add_sources(x):
    return {q["from"] for q in x["proposed"]["players"] if q["action"] == "add"}

say(f"Adds (ready): {len(adds)}")
by = Counter((x["proposed"]["type"], ",".join(sorted(add_sources(x))), x["proposed"]["faabBid"] is not None) for x in adds)
say("type / Yahoo source of the added player / FAAB present -> count")
for (t, src, faab), n in sorted(by.items()): say(f"  {t:15} {src:12} faab={faab!s:5} {n}")
mismatch = [x for x in adds if (x["proposed"]["type"] == "WAIVER_ADD") != (add_sources(x) == {"waivers"})]
say(f"type vs source mismatches: {len(mismatch)}  (must be 0 - the type is derived from the source)")

def hour(x): return int(x["proposed"]["date"][11:13]) if x["proposed"]["date"] else None
for t in ("WAIVER_ADD", "FREE_AGENT_ADD"):
    h = Counter(hour(x) for x in adds if x["proposed"]["type"] == t)
    say(f"{t} by UTC hour: " + ", ".join(f"{k:02d}h={v}" for k, v in sorted(h.items(), key=lambda kv: (kv[0] is None, kv[0] or 0))))
faab = [x["proposed"]["faabBid"] for x in adds if x["proposed"]["faabBid"] is not None]
say(f"FAAB bids: {len(faab)} present" + (f", min {min(faab)}, max {max(faab)}, zero-dollar {sum(1 for f in faab if f == 0)}" if faab else ""))

random.seed(r["fingerprint"] + ":waiver-fa")
def take(pool, n): return random.sample(pool, min(n, len(pool)))
fa = take([x for x in adds if x["proposed"]["type"] == "FREE_AGENT_ADD"], 3)
wn = take([x for x in adds if x["proposed"]["type"] == "WAIVER_ADD" and x["proposed"]["faabBid"] is None], 3)
wf = take([x for x in adds if x["proposed"]["type"] == "WAIVER_ADD" and x["proposed"]["faabBid"] is not None], 2)
md = ["# Waiver vs free-agent sample", f"Report {r['fingerprint']}. On Yahoo's transaction page, confirm each add was a waiver claim or a free-agent pickup as listed, and the FAAB.", "",
      "| Yahoo key | Stored as | When (UTC) | FAAB | Added (from -> to) | Yahoo shows | Matches? |", "|---|---|---|---|---|---|---|"]
for x in sorted(fa + wn + wf, key=lambda x: x["proposed"]["date"] or ""):
    p = x["proposed"]
    added = "; ".join(f"{q['name']} ({q['from']} -> {q['to']})" for q in p["players"] if q["action"] == "add")
    md.append(f"| {x['yahooTransactionId']} | {p['type']} | {p['date']} | {'' if p['faabBid'] is None else p['faabBid']} | {added} | | ☐ |")
path = os.path.splitext(sys.argv[1])[0] + ".waiver-fa.md"
open(path, "w").write("\n".join(md) + "\n")
say(f"wrote {path} ({len(fa)} free-agent, {len(wn)} waiver no-FAAB, {len(wf)} waiver with FAAB)")
sys.exit(1 if mismatch else 0)
