import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { notifyManagers } from "@/lib/notifications";
import { CURRENT_SEASON_YEAR } from "@/lib/config";

export async function GET() {
  const bets = await prisma.dpudBet.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      creator: true,
      players: { include: { player: true } },
      participants: { include: { manager: true } },
    },
  });
  return NextResponse.json({ bets });
}

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const body = await req.json();
  const { title, description, statCondition, stakes, startDate, endDate, playerIds } = body;

  if (!title || !description || !statCondition || !startDate || !endDate) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) return NextResponse.json({ error: "No current season" }, { status: 500 });

  const bet = await prisma.dpudBet.create({
    data: {
      seasonId: season.id,
      seasonYear: CURRENT_SEASON_YEAR,
      creatorId: manager.id,
      title,
      description,
      statCondition,
      stakes,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: "OPEN",
      players: { create: (playerIds ?? []).map((playerId: string) => ({ playerId })) },
    },
  });

  const otherManagers = await prisma.manager.findMany({ where: { id: { not: manager.id } } });
  await notifyManagers(otherManagers.map((m) => m.id), {
    type: "DPUD_NEW_BET",
    title: `New DPUD bet: ${title}`,
    body: description,
    link: "/prop-bets",
    relatedEntityType: "DpudBet",
    relatedEntityId: bet.id,
  });

  return NextResponse.json({ bet });
}
