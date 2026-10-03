import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { withdrawTrade, rejectTrade, counterTrade, acceptTrade, TradeActionError } from "@/lib/trades";
import { tradeActionDenial, type TradeAction } from "@/lib/trade-access";

const ACTIONS: TradeAction[] = ["accept", "reject", "counter", "withdraw"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { action, counterAssets, notes } = await req.json();
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const trade = await prisma.trade.findUnique({
    where: { id },
    select: { teamAId: true, teamBId: true, proposerId: true, status: true },
  });
  if (!trade) return NextResponse.json({ error: "Trade not found" }, { status: 404 });

  const denial = tradeActionDenial(trade, manager, action);
  if (denial) return NextResponse.json({ error: denial.error }, { status: denial.status });

  try {
    if (action === "withdraw") await withdrawTrade(id);
    if (action === "reject") await rejectTrade(id);
    if (action === "accept") await acceptTrade(id);
    if (action === "counter") {
      const counter = await counterTrade(id, manager.id, counterAssets ?? [], notes);
      return NextResponse.json({ ok: true, trade: counter });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TradeActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
