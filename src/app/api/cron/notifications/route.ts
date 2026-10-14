import { NextRequest, NextResponse } from "next/server";
import { runKeeperDeadlineChecks, runDpudEndingSoonChecks } from "@/lib/notification-jobs";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [keeper, dpud] = await Promise.all([runKeeperDeadlineChecks(), runDpudEndingSoonChecks()]);

  return NextResponse.json({ keeper, dpud });
}
