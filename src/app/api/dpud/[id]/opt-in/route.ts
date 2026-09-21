import { NextResponse } from "next/server";
import { getCurrentManager } from "@/lib/current-manager";
import { optIntoBet, DpudActionError } from "@/lib/dpud";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const manager = await getCurrentManager();
  if (!manager) return NextResponse.json({ error: "No current manager" }, { status: 400 });

  try {
    await optIntoBet(id, manager.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof DpudActionError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
