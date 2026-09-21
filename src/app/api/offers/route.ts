import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentManager } from "@/lib/current-manager";
import { notifyManagers } from "@/lib/notifications";

export async function GET() {
  const offers = await prisma.offer.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      sendingTeam: true,
      receivingTeam: { include: { manager: true } },
      targetPlayer: true,
    },
  });
  return NextResponse.json({ offers });
}

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const body = await req.json();
  const { targetPlayerId, sendingTeamId, receivingTeamId, playersOffered, playersRequested, draftPicksOffered, message } = body;

  if (!sendingTeamId || !receivingTeamId) {
    return NextResponse.json({ error: "Both teams are required" }, { status: 400 });
  }

  const offer = await prisma.offer.create({
    data: {
      targetPlayerId,
      sendingTeamId,
      sendingManagerId: manager.id,
      receivingTeamId,
      playersOffered: playersOffered ?? [],
      playersRequested: playersRequested ?? [],
      draftPicksOffered: draftPicksOffered ?? [],
      message,
      status: "PENDING",
    },
    include: { receivingTeam: { include: { manager: true } }, targetPlayer: true },
  });

  await notifyManagers([offer.receivingTeam.managerId], {
    type: "OFFER_RECEIVED",
    title: `Offer received${offer.targetPlayer ? ` for ${offer.targetPlayer.name}` : ""}`,
    body: message || "You've received a new offer in the Trade Center.",
    link: "/trades",
    relatedEntityType: "Offer",
    relatedEntityId: offer.id,
  });

  return NextResponse.json({ offer });
}
