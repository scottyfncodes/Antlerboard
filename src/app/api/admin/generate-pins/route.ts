import { NextRequest, NextResponse } from "next/server";
import { generatePins } from "@/lib/auth/generate-pins";

/**
 * Protected, deployment-side twin of scripts/generate-pins.ts - for when
 * the database only resolves from inside a running Vercel deployment (see
 * the comment on /api/admin/seed/route.ts for why that can happen here).
 *
 * Gated behind CRON_SECRET, same as /api/admin/seed. The PIN table comes
 * back in this response only, to whoever holds that secret (the
 * commissioner) - it is never logged, stored, or otherwise exposed. Body:
 * {"resetAll"?: boolean, "resetName"?: string} - same semantics as the
 * script's --reset-all / --reset "Name" flags.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  return NextResponse.json({ rows: result.rows });
}
