import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { notifyManagers } from "@/lib/notifications";
import { CURRENT_SEASON_YEAR } from "@/lib/config";
import { isTradeParty, visibleTradesWhere } from "@/lib/trade-access";

export async function GET() {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const trades = await prisma.trade.findMany({
    where: visibleTradesWhere(manager),
    orderBy: { updatedAt: "desc" },
    include: {
      teamA: { include: { manager: true } },
      teamB: { include: { manager: true } },
      proposer: true,
      assets: { include: { player: true } },
    },
  });
  // Notes are part of the negotiation - only the two sides see them, even on an accepted trade.
  return NextResponse.json({
    trades: trades.map((t) => (isTradeParty(t, manager) ? t : { ...t, notes: null })),
  });
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
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

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
  // You can only propose trades your own team is part of, and every asset
  // has to move between the two teams in the deal.
  const myTeamIds = manager.teams.map((t) => t.id);
  if (!myTeamIds.includes(teamAId) && !myTeamIds.includes(teamBId)) {
    return NextResponse.json({ error: "You can only propose trades involving your own team" }, { status: 403 });
  }
  const parties = [teamAId, teamBId];
  const badAsset = assets.some(
    (a) => !parties.includes(a.fromTeamId) || !parties.includes(a.toTeamId) || a.fromTeamId === a.toTeamId
  );
  if (badAsset) {
    return NextResponse.json({ error: "Every asset must move between the two teams in the trade" }, { status: 400 });
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
      assets: {
        create: assets.map((a) => ({
          fromTeamId: a.fromTeamId,
          toTeamId: a.toTeamId,
          assetType: a.assetType,
          playerId: a.playerId,
          draftPickDescription: a.draftPickDescription,
        })),
      },
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
