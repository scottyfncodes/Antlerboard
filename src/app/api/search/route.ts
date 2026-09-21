import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ players: [], teams: [], managers: [], trades: [], dpudBets: [] });
  }

  const [players, teams, managers, trades, dpudBets] = await Promise.all([
    prisma.player.findMany({
      where: { name: { contains: q, mode: "insensitive" } },
      take: 8,
      include: {
        keeperRecords: {
          orderBy: { seasonYear: "desc" },
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
        OR: [
          { teamA: { name: { contains: q, mode: "insensitive" } } },
          { teamB: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      take: 5,
      include: { teamA: true, teamB: true },
    }),
    prisma.dpudBet.findMany({
      where: { title: { contains: q, mode: "insensitive" } },
      take: 5,
    }),
  ]);

  return NextResponse.json({
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      mlbTeam: p.mlbTeam,
      team: p.keeperRecords[0]?.team.name ?? null,
      keeperCost: p.keeperRecords[0]?.keeperCost ?? null,
      keeperYear: p.keeperRecords[0]?.keeperYear ?? null,
      yearsRemaining: p.keeperRecords[0]?.yearsRemaining ?? null,
    })),
    teams: teams.map((t) => ({ id: t.id, name: t.name, manager: t.manager.name })),
    managers: managers.map((m) => ({
      id: m.id,
      name: m.name,
      teamId: m.teams[0]?.id ?? null,
      teamName: m.teams[0]?.name ?? null,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      label: `${t.teamA.name} ↔ ${t.teamB.name}`,
      status: t.status,
    })),
    dpudBets: dpudBets.map((b) => ({ id: b.id, title: b.title, status: b.status })),
  });
}
