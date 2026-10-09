import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { withdrawTrade, rejectTrade, acceptTrade, TradeActionError } from "@/lib/trades";
import { resolveTradeAction } from "@/lib/trade-access";

// Countering goes through POST /api/trades with counterOfTradeId, since it
// carries a whole new proposal.
const ACTIONS = ["accept", "reject", "withdraw"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { action } = (await req.json()) as { action: Action };
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const trade = await prisma.trade.findUnique({
    where: { id },
    select: { proposerId: true, status: true, participants: { select: { teamId: true, isProposer: true, response: true } } },
  });
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });

  const access = resolveTradeAction(trade, manager, action);
  if (access.denial) return NextResponse.json({ error: access.denial.error }, { status: access.denial.status });

  try {
    if (action === "withdraw") await withdrawTrade(id);
    if (action === "reject") await rejectTrade(id, access.teamId);
    if (action === "accept") {
      const executed = await acceptTrade(id, access.teamId);
      return NextResponse.json({ ok: true, executed });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TradeActionError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
