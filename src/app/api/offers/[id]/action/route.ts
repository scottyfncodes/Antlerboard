import { NextResponse } from "next/server";
import { withdrawOffer, rejectOffer, acceptOffer, OfferActionError } from "@/lib/offers";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { action } = await req.json();

  try {
    if (action === "withdraw") {
      await withdrawOffer(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "reject") {
      await rejectOffer(id);
      return NextResponse.json({ ok: true });
    }
    if (action === "accept") {
      await acceptOffer(id);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    if (err instanceof OfferActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
