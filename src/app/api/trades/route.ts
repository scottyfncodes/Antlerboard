import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { createTrade, counterTrade, TradeActionError } from "@/lib/trades";
import { isTradeParty, resolveTradeAction, visibleTradesWhere } from "@/lib/trade-access";
import type { TradeAssetInput } from "@/lib/trade-proposal";

export async function GET() {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const trades = await prisma.trade.findMany({
    where: visibleTradesWhere(manager),
    orderBy: { updatedAt: "desc" },
    include: {
      // Names only - never a manager's email or other account fields.
      participants: { include: { team: { include: { manager: { select: { id: true, name: true } } } } } },
      proposer: { select: { id: true, name: true } },
      assets: { include: { player: true } },
    },
  });
  // Notes are part of the negotiation - only the teams in it see them, even on an accepted trade.
  return NextResponse.json({
    trades: trades.map((t) => (isTradeParty(t, manager) ? t : { ...t, notes: null })),
  });
}

/**
 * Propose a trade between 2-4 teams, or - with `counterOfTradeId` - counter
 * an open trade you're a receiving party in. Your own team is always the
 * proposing side; you can't propose a deal you aren't part of.
 */
export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = (await req.json()) as {
    teamIds?: string[];
    proposingTeamId?: string;
    assets?: TradeAssetInput[];
    notes?: string;
    counterOfTradeId?: string;
  };
  const teamIds = Array.isArray(body.teamIds) ? body.teamIds : [];
  const myTeamIds = manager.teams.map((t) => t.id);
  const proposingTeamId = body.proposingTeamId ?? teamIds.find((id) => myTeamIds.includes(id));
  if (!proposingTeamId || !myTeamIds.includes(proposingTeamId)) {
    return NextResponse.json({ error: "You can only propose trades involving your own team" }, { status: 403 });
  }

  const input = {
    proposerId: manager.id,
    proposingTeamId,
    teamIds,
    assets: Array.isArray(body.assets) ? body.assets : [],
    notes: body.notes,
  };

  try {
    if (body.counterOfTradeId) {
      const original = await prisma.trade.findUnique({
        where: { id: body.counterOfTradeId },
        select: { proposerId: true, status: true, participants: { select: { teamId: true, isProposer: true, response: true } } },
      });
      if (!original) return NextResponse.json({ error: "Trade not found" }, { status: 404 });
      const access = resolveTradeAction(original, manager, "counter");
      if (access.denial) return NextResponse.json({ error: access.denial.error }, { status: access.denial.status });
      if (access.teamId !== proposingTeamId) {
        return NextResponse.json({ error: "Counter from the team that's in the original trade" }, { status: 400 });
      }
      const trade = await counterTrade(body.counterOfTradeId, input);
      return NextResponse.json({ trade });
    }

    const trade = await createTrade(input);
    return NextResponse.json({ trade });
  } catch (err) {
    if (err instanceof TradeActionError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
