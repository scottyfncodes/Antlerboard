import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { createFypdDraft, FypdActionError } from "@/lib/fypd";

export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const league = await prisma.league.findFirst();
  if (!league) return NextResponse.json({ error: "No league configured" }, { status: 500 });

  const { year, rounds, ninthBrigadeTeamId } = await req.json();
  if (!year || !ninthBrigadeTeamId) {
    return NextResponse.json({ error: "year and ninthBrigadeTeamId are required" }, { status: 400 });
  }

  try {
    const draft = await createFypdDraft(league.id, Number(year), Number(rounds) || 1, ninthBrigadeTeamId);
    return NextResponse.json({ draft });
  } catch (err) {
    if (err instanceof FypdActionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
