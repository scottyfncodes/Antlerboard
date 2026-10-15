/**
 * Builds the league-history import's auction-history workbook
 * (Auctions_AllSeasons + Keepers_AllSeasons) from Yahoo's draft results and
 * the master workbook. See src/lib/import/auction-from-yahoo.ts for the
 * rules. Reads local files only - no database, no network.
 *
 *   npx tsx scripts/build-auction-history.ts \
 *     --workbook Official_Keeper_Costs.xlsx \
 *     --draft antlerboard-yahoo-2021-2025-draft.csv \
 *     --out Auction_History_From_Yahoo.xlsx \
 *     [--decisions decisions.json] [--report report.json]
 *
 * --draft can repeat (one CSV per season works too). --decisions is a JSON
 * array of the commissioner's rulings on players the workbook lists as both
 * keeper and auction buy:
 *   [{ "season": 2024, "franchise": "Andrew", "player": "Colt Keith", "was": "keeper", "approvedBy": "Scott, 2026-10-16" }]
 *
 * Exits 1 without writing the workbook while any blocking issue remains.
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { LEAGUE_FIRST_SEASON_YEAR } from "../src/lib/config";
import { auctionHistoryWorkbook, generateAuctionHistory, parseYahooDraftCsv, type DuplicateDecision, type YahooDraftPick } from "../src/lib/import/auction-from-yahoo";
import { buildResolver, loadWorkbook, readMasterWorkbook } from "../src/lib/import/league-history-sources";

function args() {
  const a = process.argv.slice(2);
  const all = (flag: string) => a.flatMap((v, i) => (a[i - 1] === flag ? [v] : []));
  const one = (flag: string) => all(flag)[0];
  return { workbook: one("--workbook"), drafts: all("--draft"), out: one("--out"), decisions: one("--decisions"), report: one("--report"), lastSeason: Number(one("--last-season") ?? 2025) };
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const opt = args();
  if (!opt.workbook || opt.drafts.length === 0 || !opt.out) {
    console.error("Usage: --workbook <xlsx> --draft <csv> [--draft <csv> ...] --out <xlsx> [--decisions <json>] [--report <json>]");
    process.exit(2);
  }
  const workbookBuf = readFileSync(opt.workbook);
  const master = readMasterWorkbook(await loadWorkbook(workbookBuf));
  const picks: YahooDraftPick[] = [];
  const provenance = [`Generated ${new Date().toISOString()} by scripts/build-auction-history.ts from:`, `  master workbook ${basename(opt.workbook)} sha256 ${sha256(workbookBuf)}`];
  for (const path of opt.drafts) {
    const buf = readFileSync(path);
    const parsed = parseYahooDraftCsv(buf.toString("utf8"));
    if (parsed.flags.length) console.error(`${path}: ${parsed.flags.join(" ")}`);
    picks.push(...parsed.picks);
    provenance.push(`  Yahoo draft results ${basename(path)} sha256 ${sha256(buf)}`);
  }
  const decisions: DuplicateDecision[] = opt.decisions ? JSON.parse(readFileSync(opt.decisions, "utf8")) : [];
  for (const d of decisions) provenance.push(`  Decision: ${d.season} ${d.franchise} ${d.player} was a ${d.was} (approved by ${d.approvedBy})`);

  const seasons = Array.from({ length: opt.lastSeason - LEAGUE_FIRST_SEASON_YEAR + 1 }, (_, i) => LEAGUE_FIRST_SEASON_YEAR + i);
  const g = generateAuctionHistory({ picks, blocks: master.blocks, resolver: buildResolver(master.blocks), seasons, decisions });

  console.table(g.seasons);
  for (const i of g.issues) console.log(`[${i.severity}] ${i.kind}: ${i.message}`);
  if (opt.report) writeFileSync(opt.report, JSON.stringify({ seasons: g.seasons, issues: g.issues, provenance }, null, 2));
  if (!g.ok) {
    console.error(`Not written: ${g.issues.filter((i) => i.severity === "blocking").length} blocking issue(s).`);
    process.exit(1);
  }
  const out = await auctionHistoryWorkbook(g, provenance);
  writeFileSync(opt.out, out);
  console.log(`Wrote ${opt.out} (${out.length} bytes, sha256 ${sha256(out)}): ${g.auctions.length} auction buys, ${g.keepers.length} keepers.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
