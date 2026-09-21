import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { notifyManagers } from "@/lib/notifications";
import { CURRENT_SEASON_YEAR } from "@/lib/config";

export async function GET() {
  const trades = await prisma.trade.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      teamA: { include: { manager: true } },
      teamB: { include: { manager: true } },
      proposer: true,
      assets: { include: { player: true } },
    },
  });
  return NextResponse.json({ trades });
}

interface AssetInput {
  fromTeamId: string;
  toTeamId: string;
  assetType: "PLAYER" | "DRAFT_PICK";
  playerId?: string;
  draftPickDescription?: string;
}

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const body = await req.json();
  const { teamAId, teamBId, notes, assets } = body as {
    teamAId: string;
    teamBId: string;
    notes?: string;
    assets: AssetInput[];
  };

  if (!teamAId || !teamBId || teamAId === teamBId) {
    return NextResponse.json({ error: "Two different teams are required" }, { status: 400 });
  }
  if (!assets || assets.length === 0) {
    return NextResponse.json({ error: "At least one asset is required" }, { status: 400 });
  }

  const season = await prisma.season.findFirst({ where: { year: CURRENT_SEASON_YEAR } });
  if (!season) return NextResponse.json({ error: "No current season" }, { status: 500 });

  const trade = await prisma.trade.create({
    data: {
      seasonId: season.id,
      seasonYear: CURRENT_SEASON_YEAR,
      teamAId,
      teamBId,
      proposerId: manager.id,
      notes,
      status: "PROPOSED",
      assets: { create: assets },
    },
    include: { teamA: { include: { manager: true } }, teamB: { include: { manager: true } } },
  });

  const receivingManagerId =
    trade.teamA.managerId === manager.id ? trade.teamB.managerId : trade.teamA.managerId;

  await notifyManagers([receivingManagerId], {
    type: "TRADE_PROPOSED",
    title: `Trade proposed: ${trade.teamA.name} ↔ ${trade.teamB.name}`,
    body: notes || "A new trade proposal is waiting on you in the Trade Center.",
    link: "/trades",
    relatedEntityType: "Trade",
    relatedEntityId: trade.id,
  });

  return NextResponse.json({ trade });
}
