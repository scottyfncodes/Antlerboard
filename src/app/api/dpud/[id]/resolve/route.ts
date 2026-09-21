import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { resolveBet, cancelBet, DpudActionError } from "@/lib/dpud";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { result, winnerParticipantId, cancel } = await req.json();

  const manager = await getCurrentManager();
  const bet = await prisma.dpudBet.findUnique({ where: { id } });
  if (!bet) return NextResponse.json({ error: "Bet not found" }, { status: 404 });
  if (!manager || (manager.id !== bet.creatorId && !manager.isCommissioner)) {
    return NextResponse.json({ error: "Only the bet's creator or a commissioner can resolve it" }, { status: 403 });
  }

  try {
    if (cancel) {
      await cancelBet(id);
      return NextResponse.json({ ok: true });
    }
    await resolveBet(id, result, winnerParticipantId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DpudActionError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
