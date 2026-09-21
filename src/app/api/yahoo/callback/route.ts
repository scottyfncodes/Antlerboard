import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/yahoo/client";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get("yahoo_oauth_state")?.value;

  if (!code) {
    return NextResponse.redirect(new URL("/commissioner/yahoo?error=missing_code", req.url));
  }
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.redirect(new URL("/commissioner/yahoo?error=invalid_state", req.url));
  }

  try {
    const token = await exchangeCodeForToken(code);
    const league = await prisma.league.findFirst();
    if (!league) throw new Error("No league configured - run the seed script first.");

    await prisma.yahooConnection.upsert({
      where: { leagueId: league.id },
      create: {
        leagueId: league.id,
        yahooGuid: token.xoauth_yahoo_guid,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        lastSyncStatus: "NEVER_RUN",
      },
      update: {
        yahooGuid: token.xoauth_yahoo_guid,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      },
    });

    const res = NextResponse.redirect(new URL("/commissioner/yahoo?connected=1", req.url));
    res.cookies.delete("yahoo_oauth_state");
    return res;
  } catch (err) {
    console.error("Yahoo OAuth callback failed", err);
    return NextResponse.redirect(new URL("/commissioner/yahoo?error=token_exchange_failed", req.url));
  }
}
