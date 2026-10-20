import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { visibleTradesWhere } from "@/lib/trade-access";
import { tradeTitle } from "@/lib/trades";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { loadKeeperCostValues } from "@/lib/player-costs-data";
import { costDisplay } from "@/lib/player-costs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ players: [], teams: [], managers: [], trades: [], dpudBets: [] });
  }

  const viewer = await getCurrentManager();
  const [players, teams, managers, trades, dpudBets] = await Promise.all([
    prisma.player.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      take: 8,
      include: {
        keeperRecords: {
          orderBy: [{ seasonYear: "desc" }, { stintIndex: "desc" }],
          take: 1,
          include: { team: true },
        },
      },
    }),
    prisma.team.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      take: 5,
      include: { manager: true },
    }),
    prisma.manager.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      take: 5,
      include: { teams: true },
    }),
    prisma.trade.findMany({
      where: {
        AND: visibleTradesWhere(viewer),
        participants: { some: { team: { name: { contains: q, mode: "insensitive" } } } },
      },
      take: 5,
      include: { participants: { include: { team: true } } },
    }),
    prisma.dpudBet.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      take: 5,
    }),
  ]);

  // Keeper costs are checked like everywhere else (classifyKeeperCost): a
  // cost from a missing or guessed price reads Unavailable, forced back None.
  // A player whose latest record is a drop isn't on that team any more, so
  // they read as unrostered (as on the player page), not "Team · $X · Yr N".
  const current = (p: (typeof players)[number]) => {
    const r = p.keeperRecords[0];
    return r && r.status !== "DROPPED" ? r : undefined;
  };
  const latest = players.flatMap((p) => current(p) ?? []);
  const costs = await loadKeeperCostValues(latest);

  return NextResponse.json({
    players: players.map((p) => {
      const r = current(p);
      const cost = r ? costs.get(r.id) : undefined;
      return {
        id: p.id,
        name: p.name,
        mlbTeam: p.mlbTeam,
        team: r?.team.name ?? null,
        // The record may be from an earlier season - the view says which,
        // so an old cost never reads as this season's.
        keeperSeason: r && r.seasonYear !== CURRENT_SEASON_YEAR ? r.seasonYear : null,
        cost: cost ? costDisplay(cost) : null,
        keeperYear: r?.keeperYear ?? null,
        yearsRemaining: r?.yearsRemaining ?? null,
      };
    }),
    teams: teams.map((t) => ({ id: t.id, name: t.name, manager: t.manager.name })),
    managers: managers.map((m) => ({
      id: m.id,
      name: m.name,
      teamId: m.teams[0]?.id ?? null,
      teamName: m.teams[0]?.name ?? null,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      label: tradeTitle(t.participants),
      status: t.status,
    })),
    dpudBets: dpudBets.map((b) => ({ id: b.id, title: b.title, status: b.status })),
  });
}
