import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { buildAuthorizationUrl, missingYahooEnvVars } from "@/lib/yahoo/client";
import { requireCommissioner } from "@/lib/current-manager";

export async function GET() {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const missing = missingYahooEnvVars();
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Yahoo OAuth is not configured in this environment. Missing or blank: ${missing.join(", ")}.` },
      { status: 400 }
    );
  }

  const state = randomBytes(16).toString("hex");
  const url = buildAuthorizationUrl(state);
  const res = NextResponse.redirect(url);
  res.cookies.set("yahoo_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
