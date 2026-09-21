import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { buildAuthorizationUrl, isYahooConfigured } from "@/lib/yahoo/client";

export async function GET() {
  if (!isYahooConfigured()) {
    return NextResponse.json(
      { error: "Yahoo OAuth is not configured. Set YAHOO_CLIENT_ID/YAHOO_CLIENT_SECRET/YAHOO_REDIRECT_URI." },
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
