/**
 * Shared fixtures for integration tests that hit the real (test) database.
 * Every test file using this must run against DATABASE_URL from .env.test
 * (see vitest.setup.ts) - never the dev database.
 */

import { prisma } from "./db";

export async function makeLeagueWithSeason(year = 2026) {
  const league = await prisma.league.create({
    data: { name: "Test League", abbreviation: "TL", currentSeasonYear: year },
  });
  const season = await prisma.season.create({
    data: { leagueId: league.id, year, status: "IN_PROGRESS" },
  });
  return { league, season };
}

export async function makeManagerAndTeam(leagueId: string, name: string, isCommissioner = false) {
  const manager = await prisma.manager.create({
    data: { leagueId, name, isCommissioner },
  });
  const team = await prisma.team.create({
    data: { leagueId, name: `${name}'s Team`, managerId: manager.id },
  });
  return { manager, team };
}

export async function makePlayer(leagueId: string, name: string) {
  return prisma.player.create({ data: { leagueId, name, positions: ["OF"] } });
}

export async function makePinCredential(managerId: string, pin: string) {
  const { hashPin } = await import("./auth/pin");
  return prisma.managerCredential.create({
    data: { managerId, provider: "pin", secretHash: hashPin(pin) },
  });
}

/** Wipes every table this test suite touches. Call in afterEach/afterAll. */
export async function resetDatabase() {
  const tables = [
    "AuditLogEntry",
    "SyncLog",
    "YahooConnection",
    "PushSubscription",
    "LoginAttempt",
    "ManagerCredential",
    "NotificationPreference",
    "Notification",
    "DpudParticipant",
    "DpudBetPlayer",
    "DpudBet",
    "Offer",
    "TradeAsset",
    "Trade",
    "PlayerTag",
    "TransactionTeam",
    "TransactionPlayer",
    "Transaction",
    "KeeperRecord",
    "TeamStanding",
    "DraftPick",
    "FypdSelection",
    "FypdDraftOrderSlot",
    "FypdDraft",
    "FypdImportBatch",
    "HistoricalTrade",
    "HistoricalPropBet",
    "TeamSeasonRecord",
    "Acquisition",
    "Player",
    "Team",
    "Manager",
    "DraftDayDetails",
    "Season",
    "LeagueSettings",
    "League",
  ];
  for (const t of tables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any)[t.charAt(0).toLowerCase() + t.slice(1)].deleteMany();
  }
}
