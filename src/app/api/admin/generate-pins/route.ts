import { NextRequest, NextResponse } from "next/server";
import { generatePins } from "@/lib/auth/generate-pins";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { prisma } from "@/lib/db";

/**
 * Protected, deployment-side twin of scripts/generate-pins.ts - the
 * commissioner's way back in if they can't sign in to use
 * /api/commissioner/pins. Gated behind CRON_SECRET (compared in constant
 * time) and refused on Preview deployments, which share Production's
 * database. The PIN table comes back in this response only - never logged
 * or stored - and the run is recorded in the audit log, like the
 * commissioner's own PIN tools. Body: {"resetAll"?: boolean,
 * "resetName"?: string} - same semantics as the script's --reset-all /
 * --reset "Name" flags.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (process.env.VERCEL_ENV === "preview") {
    return NextResponse.json({ error: "PIN generation isn't available on Preview deployments." }, { status: 403 });
  }

  let body: { resetAll?: boolean; resetName?: string } = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine - defaults to generating for managers missing a PIN.
  }

  const result = await generatePins({ resetAll: body.resetAll, resetName: body.resetName });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await prisma.auditLogEntry.create({
    data: {
      actorName: "Admin route (CRON_SECRET)",
      action: body.resetAll ? "RESET_ALL_PINS" : body.resetName ? "RESET_MANAGER_PIN" : "GENERATE_PINS",
      entityType: "ManagerCredential",
      entityId: body.resetName ? result.rows[0]?.managerId : undefined,
      after: { managersAffected: result.rows.map((r) => r.name) },
    },
  });

  return NextResponse.json({ rows: result.rows });
}
