import { NextRequest, NextResponse } from "next/server";
import { requireCommissioner } from "@/lib/current-manager";
import { generatePins } from "@/lib/auth/generate-pins";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

/**
 * Browser-facing twin of /api/admin/generate-pins - same underlying
 * generatePins() logic, but authorized by the commissioner's own signed-in
 * session (requireCommissioner()) instead of the CRON_SECRET bearer token.
 * This is what lets the commissioner run PIN generation from Safari on a
 * phone with nothing more secret than "being logged in as the
 * commissioner" - CRON_SECRET never has to touch a browser.
 *
 * Independently re-checks isCommissioner here (not just via middleware or
 * the page hiding the button) - see current-manager.ts. Reads the session
 * cookie from the request directly (rather than next/headers' cookies())
 * so this route, like /api/auth/*, is callable directly in tests.
 */
export async function POST(req: NextRequest) {
  const commissioner = await requireCommissioner(req.cookies.get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!commissioner) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  let body: { action?: string; managerName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const action = body.action;
  if (action !== "generate" && action !== "reset-all" && action !== "reset-one") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  if (action === "reset-one" && !body.managerName) {
    return NextResponse.json({ error: "managerName is required for reset-one" }, { status: 400 });
  }

  const result = await generatePins(
    action === "reset-all"
      ? { resetAll: true }
      : action === "reset-one"
        ? { resetName: body.managerName }
        : {}
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Record that a generation happened and how many PINs it touched - never
  // the PINs themselves, not even hashed, since there's no reason for the
  // audit trail to carry credential material at all.
  await prisma.auditLogEntry.create({
    data: {
      actorName: commissioner.name,
      action:
        action === "reset-all" ? "RESET_ALL_PINS" : action === "reset-one" ? "RESET_MANAGER_PIN" : "GENERATE_PINS",
      entityType: "ManagerCredential",
      entityId: action === "reset-one" ? result.rows[0]?.managerId : undefined,
      after: { managersAffected: result.rows.map((r) => r.name) },
    },
  });

  return NextResponse.json({ rows: result.rows });
}
