/**
 * League-history import rehearsal: runs the real /check and /commit route
 * handlers twice against the local replica (seed-replica.ts) with the exact
 * files production will get, and proves what the runbook's §3 asks for.
 * See README.md. Writes a JSON report to REHEARSAL_OUT.
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { describe, it, expect, vi } from "vitest";
import { prisma } from "@/lib/db";
import { loadWorkbook, readAuctionWorkbook, readYahooExport, yahooCsvText } from "@/lib/import/league-history-sources";
import { LEAGUE_FIRST_SEASON_YEAR } from "@/lib/config";
import { canonicalYahooPlayerId } from "@/lib/yahoo/player-id";

vi.mock("@/lib/current-manager", () => ({
  requireCommissioner: vi.fn(async () => ({ id: "rehearsal", name: "Rehearsal" })),
  getCurrentManager: vi.fn(async () => ({ id: "rehearsal", name: "Rehearsal (commissioner)" })),
}));
import { POST as check } from "@/app/api/commissioner/import/league-history/check/route";
import { POST as commit } from "@/app/api/commissioner/import/league-history/commit/route";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const files = { workbook: env("REHEARSAL_WORKBOOK"), auction: env("REHEARSAL_AUCTION"), yahoo: env("REHEARSAL_YAHOO") };
/** Seasons the Yahoo transaction file covers (2026 is the sync's). */
const SEASONS = [2021, 2022, 2023, 2024, 2025];
/** Seasons the auction file covers: 2026 too, in Yahoo's real order. */
const AUCTION_SEASONS = [...SEASONS, 2026];
const LIMIT = 4.0 * 1024 * 1024; // the runbook's margin under Vercel's ~4.5 MB

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
const mb = (n: number) => Math.round((n / 1048576) * 100) / 100;

/** Everything the import must leave exactly as it found it. */
async function untouched(preexistingPlayerIds: string[]) {
  const [synced, roster, fypdDrafts, fypdSel, fypdSlots, tsr, trades, players, teams, managers, seasons, league] = await Promise.all([
    prisma.transaction.findMany({ where: { sourceRef: null }, select: { yahooTransactionId: true, type: true, date: true, seasonYear: true, notes: true }, orderBy: { yahooTransactionId: "asc" } }),
    prisma.rosterSpot.findMany({ select: { seasonId: true, teamId: true, playerId: true, selectedPosition: true }, orderBy: [{ teamId: "asc" }, { playerId: "asc" }] }),
    prisma.fypdDraft.findMany({ select: { year: true, rounds: true, status: true, currentOverallPick: true }, orderBy: { year: "asc" } }),
    prisma.fypdSelection.findMany({ select: { draftId: true, overallPick: true, teamId: true, playerId: true, callUpYear: true, isDpud: true }, orderBy: [{ draftId: "asc" }, { overallPick: "asc" }] }),
    prisma.fypdDraftOrderSlot.findMany({ select: { draftId: true, teamId: true, slot: true }, orderBy: [{ draftId: "asc" }, { slot: "asc" }] }),
    prisma.teamSeasonRecord.findMany({ select: { teamId: true, seasonYear: true, teamName: true, managerId: true, finish: true, sourceNote: true }, orderBy: [{ teamId: "asc" }, { seasonYear: "asc" }] }),
    // Team ids may be backfilled by design (counted separately); everything else must hold.
    prisma.historicalTrade.findMany({ select: { id: true, seasonYear: true, tradeDate: true, teamAName: true, teamBName: true, teamAPlayersRaw: true, teamBPlayersRaw: true, sourceRef: true }, orderBy: { id: "asc" } }),
    prisma.player.findMany({ where: { id: { in: preexistingPlayerIds } }, select: { id: true, name: true, yahooPlayerId: true, mlbTeam: true, positions: true, notes: true, mlbDraftYear: true }, orderBy: { id: "asc" } }),
    prisma.team.findMany({ select: { id: true, name: true, yahooTeamId: true, managerId: true, active: true }, orderBy: { id: "asc" } }),
    prisma.manager.findMany({ select: { id: true, name: true, active: true, isCommissioner: true }, orderBy: { id: "asc" } }),
    prisma.season.findMany({ where: { year: { in: [2022, 2026] } }, select: { year: true, status: true, draftColor: true, championTeamId: true }, orderBy: { year: "asc" } }),
    prisma.league.findMany({ select: { name: true, currentSeasonYear: true, settings: { select: { keeperSlotCount: true, maxConsecutiveKeeperYears: true, teamCount: true } } } }),
  ]);
  const t = { synced, roster, fypdDrafts, fypdSel, fypdSlots, tsr, trades, players, teams, managers, seasons, league };
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { rows: v.length, hash: sha(v) }]));
}

/** What the import wrote, for the repeat-run comparison and the reconciliation. */
async function imported() {
  const [acq, drops, picks, keepers, players, seasons, tradesWithIds] = await Promise.all([
    prisma.acquisition.findMany({ where: { sourceRef: { startsWith: "league-history:" } }, select: { seasonYear: true, playerId: true, teamId: true, method: true, cost: true, date: true, sourceRef: true } }),
    prisma.transaction.findMany({ where: { sourceRef: { startsWith: "league-history:" } }, select: { seasonYear: true, type: true, date: true, sourceRef: true, players: { select: { playerId: true } } } }),
    prisma.draftPick.findMany({ where: { sourceRef: { startsWith: "league-history:" } }, select: { seasonYear: true, overallPick: true, playerId: true, teamId: true, cost: true } }),
    prisma.keeperRecord.findMany({ select: { seasonYear: true, playerId: true, teamId: true, keeperYear: true, keeperCost: true, status: true, stintIndex: true, commissionerOverride: true } }),
    prisma.player.count(),
    prisma.season.findMany({ select: { year: true }, orderBy: { year: "asc" } }),
    prisma.historicalTrade.count({ where: { teamAId: { not: null }, teamBId: { not: null } } }),
  ]);
  const sorted = <T>(rows: T[]) => rows.map((r) => JSON.stringify(r)).sort();
  return {
    acq,
    drops,
    picks,
    keepers,
    counts: { acquisitions: acq.length, drops: drops.length, draftPicks: picks.length, keeperRecords: keepers.length, overrides: keepers.filter((k) => k.commissionerOverride).length, players, seasons: seasons.map((s) => s.year), tradesWithBothTeamIds: tradesWithIds },
    // Content hashes that ignore row ids and write order.
    hashes: { acq: sha(sorted(acq)), drops: sha(sorted(drops.map((d) => ({ ...d, players: d.players.length })))), picks: sha(sorted(picks)), keepers: sha(sorted(keepers)) },
  };
}

async function runOnce() {
  const fd = new FormData();
  const blob = (path: string) => new Blob([readFileSync(path)]);
  fd.append("workbook", blob(files.workbook), basename(files.workbook));
  fd.append("auction", blob(files.auction), basename(files.auction));
  fd.append("yahoo", blob(files.yahoo), basename(files.yahoo));
  const checkReq = new Request("http://localhost/api/commissioner/import/league-history/check", { method: "POST", body: fd });
  const uploadBytes = (await checkReq.clone().arrayBuffer()).byteLength;
  const checkRes = await check(checkReq);
  const checkText = await checkRes.text();
  expect(checkRes.status, checkText.slice(0, 500)).toBe(200);
  const preview = JSON.parse(checkText);

  const body = JSON.stringify({ ...preview, applyRecordedKeeperCosts: true });
  const commitRes = await commit(new Request("http://localhost/api/commissioner/import/league-history/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  const commitText = await commitRes.text();
  expect(commitRes.status, commitText.slice(0, 1000)).toBe(200);
  return { preview, result: JSON.parse(commitText), sizes: { uploadMB: mb(uploadBytes), checkResponseMB: mb(Buffer.byteLength(checkText)), commitBodyMB: mb(Buffer.byteLength(body)) } };
}

describe("league-history import rehearsal (local replica)", () => {
  it("commits cleanly, accounts for every Yahoo transaction, reconciles the auction file, and repeats identically", async () => {
    const report: Record<string, unknown> = { at: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { name: basename(p), bytes: readFileSync(p).length, sha256: createHash("sha256").update(readFileSync(p)).digest("hex") }])) };
    const preexisting = (await prisma.player.findMany({ select: { id: true } })).map((p) => p.id);
    const before = await untouched(preexisting);
    const tradesBefore = await prisma.historicalTrade.count({ where: { teamAId: { not: null }, teamBId: { not: null } } });
    // Team links already set must survive as they are; only empty ones may be filled.
    const linksBefore = await prisma.historicalTrade.findMany({ select: { id: true, teamAId: true, teamBId: true } });

    const first = await runOnce();
    const afterFirst = await imported();
    const second = await runOnce();
    const afterSecond = await imported();
    const after = await untouched(preexisting);

    // --- sizes ---------------------------------------------------------------
    report.sizes = { first: first.sizes, second: second.sizes, limitMB: mb(LIMIT) };

    // --- every Yahoo transaction accounted for -------------------------------
    const yahoo = readYahooExport(yahooCsvText(readFileSync(files.yahoo)));
    const keysInDb = new Set<string>();
    for (const r of [...afterSecond.acq, ...afterSecond.drops]) for (const m of (r.sourceRef ?? "").matchAll(/yahoo:([^|\s]+)/g)) keysInDb.add(m[1]);
    const bySeason = SEASONS.map((season) => {
      const txs = yahoo.transactions.filter((t) => t.seasonYear === season);
      const noPlayers = txs.filter((t) => t.type === "commish" || t.players.length === 0);
      const written = txs.filter((t) => keysInDb.has(t.transactionKey));
      const missing = txs.filter((t) => !(t.type === "commish" || t.players.length === 0) && !keysInDb.has(t.transactionKey));
      return { season, inFile: txs.length, written: written.length, commissionerOrNoPlayers: noPlayers.length, missing: missing.length, missingKeys: missing.slice(0, 20).map((t) => t.transactionKey) };
    });
    const totals = bySeason.reduce((s, r) => ({ inFile: s.inFile + r.inFile, written: s.written + r.written, noPlayers: s.noPlayers + r.commissionerOrNoPlayers, missing: s.missing + r.missing }), { inFile: 0, written: 0, noPlayers: 0, missing: 0 });
    report.transactions = { totals, bySeason, parserFlags: yahoo.flags, otherSeasonsInFile: yahoo.transactions.filter((t) => !SEASONS.includes(t.seasonYear)).length };

    // --- auction picks and keepers against the approved auction file ---------
    const auction = readAuctionWorkbook(await loadWorkbook(readFileSync(files.auction)), LEAGUE_FIRST_SEASON_YEAR);
    const yahooIdOf = new Map((await prisma.player.findMany({ select: { id: true, yahooPlayerId: true } })).map((p) => [p.id, canonicalYahooPlayerId(p.yahooPlayerId)]));
    const recon = AUCTION_SEASONS.map((season) => {
      const buys = auction.filter((r) => r.seasonYear === season && !r.isKeeper);
      const keepersDeclared = auction.filter((r) => r.seasonYear === season && r.isKeeper);
      const picks = afterSecond.picks.filter((p) => p.seasonYear === season);
      const pickPlayers = new Set(picks.map((p) => p.playerId));
      const dupPicks = picks.length - pickPlayers.size;
      // A declared keeper must never also be one of that season's auction picks (compared by Yahoo id).
      const keeperIds = new Set(keepersDeclared.map((k) => canonicalYahooPlayerId(k.yahooPlayerId)).filter((x): x is string => !!x));
      const keptAndPicked = keeperIds.size === 0 ? null : picks.filter((p) => p.playerId && keeperIds.has(yahooIdOf.get(p.playerId) ?? "")).length;
      const draftAcq = afterSecond.acq.filter((a) => a.seasonYear === season && a.method === "DRAFT");
      const draftAcqDup = draftAcq.length - new Set(draftAcq.map((a) => a.playerId)).size;
      return {
        season,
        auctionBuys: buys.length,
        auctionSalary: buys.reduce((s, r) => s + (r.salary ?? 0), 0),
        draftPicks: picks.length,
        draftPickSalary: picks.reduce((s, p) => s + (p.cost ?? 0), 0),
        keepersDeclared: keepersDeclared.length,
        keepersWithYahooId: keeperIds.size,
        keeperRecords: afterSecond.keepers.filter((k) => k.seasonYear === season).length,
        overrides: afterSecond.keepers.filter((k) => k.seasonYear === season && k.commissionerOverride).length,
        duplicatePicks: dupPicks,
        keptAndAlsoPicked: keptAndPicked,
        duplicateDraftAcquisitions: draftAcqDup,
      };
    });
    report.reconciliation = recon;
    report.preview = { summary: second.preview.summary, conflicts: second.preview.dbCheck?.conflicts ?? [], unresolvedTeams: second.preview.unresolvedTeams?.length ?? 0, flags: (second.preview.flags ?? []).slice(0, 40), identityCounts: second.preview.dbCheck?.identityCounts };
    report.commit = { first: first.result, second: { ...second.result, identityReview: second.result.identityReview?.length } };

    // --- untouched data and repeatability ------------------------------------
    report.untouched = Object.fromEntries(Object.keys(before).map((k) => [k, { before: before[k], after: after[k], unchanged: before[k].hash === after[k].hash }]));
    const linksAfter = new Map((await prisma.historicalTrade.findMany({ select: { id: true, teamAId: true, teamBId: true } })).map((t) => [t.id, t]));
    const linksChanged = linksBefore.filter((b) => (b.teamAId && linksAfter.get(b.id)?.teamAId !== b.teamAId) || (b.teamBId && linksAfter.get(b.id)?.teamBId !== b.teamBId)).length;
    report.historicalTradeLinksChanged = linksChanged;
    report.historicalTradeTeamIdsBackfilled = (await prisma.historicalTrade.count({ where: { teamAId: { not: null }, teamBId: { not: null } } })) - tradesBefore;
    const keySet = (rows: unknown[]) => new Set(rows.map((r) => JSON.stringify(r)));
    const k1 = keySet(afterFirst.keepers), k2 = keySet(afterSecond.keepers);
    report.keeperRecordDiff = { onlyFirst: [...k1].filter((x) => !k2.has(x)).slice(0, 10), onlySecond: [...k2].filter((x) => !k1.has(x)).slice(0, 10) };
    report.repeat = { first: afterFirst.counts, second: afterSecond.counts, hashes: { first: afterFirst.hashes, second: afterSecond.hashes }, identical: JSON.stringify(afterFirst.hashes) === JSON.stringify(afterSecond.hashes) && JSON.stringify(afterFirst.counts) === JSON.stringify(afterSecond.counts) };

    if (process.env.REHEARSAL_OUT) writeFileSync(process.env.REHEARSAL_OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ sizes: report.sizes, transactions: totals, reconciliation: recon, repeat: report.repeat, untouched: Object.fromEntries(Object.entries(report.untouched as Record<string, { unchanged: boolean }>).map(([k, v]) => [k, v.unchanged])) }, null, 1));

    // The gates.
    expect(first.sizes.uploadMB).toBeLessThan(mb(LIMIT));
    expect(first.sizes.commitBodyMB).toBeLessThan(mb(LIMIT));
    expect(first.sizes.checkResponseMB).toBeLessThan(mb(LIMIT));
    expect(totals.missing).toBe(0);
    for (const r of recon) {
      expect(r.duplicatePicks).toBe(0);
      if (r.keptAndAlsoPicked !== null) expect(r.keptAndAlsoPicked).toBe(0);
      expect(r.duplicateDraftAcquisitions).toBe(0);
      expect(r.draftPicks).toBe(r.auctionBuys);
      expect(r.draftPickSalary).toBe(r.auctionSalary);
    }
    for (const [k, v] of Object.entries(report.untouched as Record<string, { unchanged: boolean }>)) expect(v.unchanged, k).toBe(true);
    expect(linksChanged).toBe(0);
    expect((report.repeat as { identical: boolean }).identical).toBe(true);
  });
});
