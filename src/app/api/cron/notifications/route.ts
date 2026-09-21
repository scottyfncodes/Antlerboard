import { NextRequest, NextResponse } from "next/server";
import { runKeeperDeadlineChecks, runDpudEndingSoonChecks } from "@/lib/notification-jobs";

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [keeper, dpud] = await Promise.all([runKeeperDeadlineChecks(), runDpudEndingSoonChecks()]);

  return NextResponse.json({ keeper, dpud });
}
