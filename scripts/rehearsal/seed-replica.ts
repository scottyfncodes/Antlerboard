/**
 * Builds the league-history rehearsal database from a read-only snapshot of
 * production (see README.md): the rows the import reads - league, seasons,
 * managers, teams, team-season records, historical trades, players and the
 * 2026 synced transactions - plus the ones it must leave alone (roster
 * spots, FYPD drafts). No emails, credentials, tokens or sessions are in the
 * snapshot; the 2026 transactions are recreated by count, type and Yahoo key
 * prefix (the import reads only their keys and seasons).
 *
 *   REHEARSAL_DATABASE_URL=postgresql://.../antlerboard_rehearsal \
 *     npx tsx scripts/rehearsal/seed-replica.ts .rehearsal/replica
 *
 * Refuses to run against anything but a local database.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";

const url = process.env.REHEARSAL_DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("REHEARSAL_DATABASE_URL must point at a local database.");
  process.exit(2);
}
const dir = process.argv[2];
const prisma = new PrismaClient({ datasources: { db: { url } } });
const lines = (f: string) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim() !== "");
const opt = (v: string | undefined) => (v === undefined || v === "~" || v === "" ? null : v);

/** The 2026 synced log as production holds it: counts by type (2026-10-15). */
const TX_2026 = { FREE_AGENT_ADD: 658, TRADE: 33, DROP: 216 } as const;

async function main() {
  const base = lines("base.txt").map((l) => l.split("|"));
  const [, leagueName, abbr, current] = base.find((r) => r[0] === "L")!;
  const league = await prisma.league.create({ data: { name: leagueName, abbreviation: abbr, currentSeasonYear: Number(current) } });
  const ls = base.find((r) => r[0] === "LS")!;
  await prisma.leagueSettings.create({ data: { leagueId: league.id, keeperSlotCount: Number(ls[1]), maxConsecutiveKeeperYears: Number(ls[2]), teamCount: Number(ls[3]) } });

  const seasonId = new Map<number, string>();
  for (const r of base.filter((r) => r[0] === "S")) {
    const s = await prisma.season.create({ data: { leagueId: league.id, year: Number(r[1]), status: r[5] as "COMPLETE" | "IN_PROGRESS" } });
    seasonId.set(Number(r[1]), s.id);
  }
  const managerId = new Map<string, string>();
  for (const r of base.filter((r) => r[0] === "M")) {
    const m = await prisma.manager.create({ data: { leagueId: league.id, name: r[2], isCommissioner: r[3] === "true", active: r[4] === "true" } });
    managerId.set(r[1], m.id);
  }
  const teamId = new Map<string, string>();
  for (const r of base.filter((r) => r[0] === "T")) {
    const t = await prisma.team.create({ data: { leagueId: league.id, yahooTeamId: opt(r[2]), name: r[3], managerId: managerId.get(r[4])!, active: r[5] === "true" } });
    teamId.set(r[1], t.id);
  }
  for (const r of base.filter((r) => r[0] === "R")) {
    await prisma.teamSeasonRecord.create({ data: { teamId: teamId.get(r[1])!, seasonYear: Number(r[2]), teamName: r[3], managerId: managerId.get(r[4])!, finish: opt(r[5]), sourceNote: opt(r[6]) } });
  }
  // 44 distinct trades; production holds every one twice except "row 57" (87 rows).
  const trades = base.filter((r) => r[0] === "H");
  for (const copy of [0, 1]) {
    for (const r of trades) {
      if (copy === 1 && r[5] === "row 57") continue;
      await prisma.historicalTrade.create({
        data: { leagueId: league.id, seasonYear: opt(r[1]) ? Number(r[1]) : null, tradeDate: opt(r[2]) ? new Date(Number(r[2]) * 1000) : null, teamAName: r[3], teamBName: r[4], sourceRef: r[5], teamAPlayersRaw: `replica ${r[5]} A`, teamBPlayersRaw: `replica ${r[5]} B` },
      });
    }
  }

  const playerId = new Map<string, string>();
  for (const l of lines("players.txt")) {
    const [o, yid, name, mlb, pos, draftYear] = l.split("|");
    const p = await prisma.player.create({
      data: { leagueId: league.id, yahooPlayerId: opt(yid) ? `469.p.${yid}` : null, name, mlbTeam: opt(mlb), positions: pos ? pos.split(",") : [], mlbDraftYear: draftYear ? Number(draftYear) : null },
    });
    playerId.set(o, p.id);
  }

  const now = new Date("2026-10-15T12:00:00Z");
  const roster = readFileSync(join(dir, "roster.txt"), "utf8").trim().split(",");
  for (const entry of roster) {
    const [t, p, pos] = entry.split(":");
    await prisma.rosterSpot.create({ data: { seasonId: seasonId.get(2026)!, teamId: teamId.get(t)!, playerId: playerId.get(p)!, yahooPlayerKey: `469.p.${p}`, selectedPosition: pos || null, onTeamSince: now, lastSeenAt: now } });
  }

  const fypd = lines("fypd.txt").map((l) => l.split("|"));
  const draftId = new Map<number, string>();
  for (const r of fypd.filter((r) => r[0] === "FD")) {
    const d = await prisma.fypdDraft.create({ data: { leagueId: league.id, year: Number(r[1]), rounds: Number(r[2]), status: r[3] as "COMPLETE", currentOverallPick: Number(r[4]) } });
    draftId.set(Number(r[1]), d.id);
  }
  for (const r of fypd.filter((r) => r[0] === "FO")) {
    for (const s of r[2].split(",")) {
      const [t, slot] = s.split(":");
      await prisma.fypdDraftOrderSlot.create({ data: { draftId: draftId.get(Number(r[1]))!, teamId: teamId.get(t)!, slot: Number(slot), reason: "replica" } });
    }
  }
  for (const s of fypd.find((r) => r[0] === "FS")![1].split(",")) {
    const [year, overall, round, inRound, t, p, callUp, dpud] = s.split(":");
    await prisma.fypdSelection.create({
      data: { draftId: draftId.get(Number(year))!, overallPick: Number(overall), round: Number(round), pickInRound: Number(inRound), teamId: teamId.get(t)!, playerId: playerId.get(p)!, callUpYear: callUp ? Number(callUp) : null, isDpud: dpud === "true" },
    });
  }

  let n = 0;
  const rows = Object.entries(TX_2026).flatMap(([type, count]) =>
    Array.from({ length: count }, () => {
      n++;
      return { seasonId: seasonId.get(2026)!, seasonYear: 2026, type: type as keyof typeof TX_2026, date: new Date(Date.UTC(2026, 2, 1) + n * 3_600_000), yahooTransactionId: `469.l.8891.tr.${n}`, notes: "replica" };
    })
  );
  await prisma.transaction.createMany({ data: rows });
  console.log(`Seeded: ${playerId.size} players, ${roster.length} roster spots, ${rows.length} transactions, ${trades.length * 2 - 1} historical trades.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
