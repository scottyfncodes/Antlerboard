import { NextResponse } from "next/server";
import { getCurrentManager } from "@/lib/current-manager";
import { withdrawTrade, rejectTrade, counterTrade, acceptTrade, TradeActionError } from "@/lib/trades";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const { action, counterAssets, notes } = await req.json();

  try {
    if (action === "withdraw") {
      await withdrawTrade(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "reject") {
      await rejectTrade(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "counter") {
      const trade = await counterTrade(id, manager.id, counterAssets ?? [], notes);
      return NextResponse.json({ ok: true, trade });
    }
    if (action === "accept") {
      await acceptTrade(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof TradeActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
