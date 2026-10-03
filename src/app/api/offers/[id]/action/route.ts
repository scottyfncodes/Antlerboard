import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { withdrawOffer, rejectOffer, acceptOffer, OfferActionError } from "@/lib/offers";
import { offerActionDenial, type OfferAction } from "@/lib/trade-access";

const ACTIONS: OfferAction[] = ["accept", "reject", "withdraw"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { action } = await req.json();
  if (!ACTIONS.includes(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const offer = await prisma.offer.findUnique({
    where: { id },
    select: { sendingTeamId: true, receivingTeamId: true, sendingManagerId: true, status: true },
  });
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 });

  const denial = offerActionDenial(offer, manager, action);
  if (denial) return NextResponse.json({ error: denial.error }, { status: denial.status });

  try {
    if (action === "withdraw") await withdrawOffer(id);
    if (action === "reject") await rejectOffer(id);
    if (action === "accept") await acceptOffer(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof OfferActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
