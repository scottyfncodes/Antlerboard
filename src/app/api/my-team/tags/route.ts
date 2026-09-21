import { NextResponse } from "next/server";
import { getCurrentManager } from "@/lib/current-manager";
import { setOwnPlayerTag, PlayerTagActionError } from "@/lib/player-tags";
import type { PlayerTagType } from "@prisma/client";

export async function POST(req: Request) {
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  const { playerId, tag, note } = (await req.json()) as {
    playerId: string;
    tag: PlayerTagType | null;
    note?: string;
  };
  if (!playerId) return NextResponse.json({ error: "playerId is required" }, { status: 400 });

  try {
    await setOwnPlayerTag(manager.id, playerId, tag, note);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof PlayerTagActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
