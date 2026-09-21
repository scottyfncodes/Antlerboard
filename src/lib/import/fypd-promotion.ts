import type { Prisma } from "@prisma/client";
import { getSnakeSlot } from "../fypd-snake-engine";
import { resolveTeamIdByCurrentManagerName } from "./team-identity-resolution";

type Db = Prisma.TransactionClient;

// C&A runs its FYPD as a 12-team snake draft - see known-league-history.ts
// and the historical-import check route for how that count was confirmed
// against the workbook's own round-1 order.
const TEAM_COUNT = 12;

interface RawFypdPick {
  overallPickInSource: number | null;
  teamNameRaw: string | null;
  playerName: string | null;
  positionRaw: string | null;
}

export interface SkippedFypdPick {
  overallPickInSource: number | null;
  teamNameRaw: string | null;
  playerName: string | null;
  reason: string;
}

export interface FypdPromotionResult {
  draftId: string;
  seasonYear: number;
  picksPromoted: number;
  playersCreated: number;
  skipped: SkippedFypdPick[];
}

/**
 * Promotes a staged FypdImportBatch (see fypd-history.ts and the
 * historical-import commit route) into a real FypdDraft/FypdSelection -
 * the live structures the rest of the app (the /fypd board, call-up
 * tracking) actually reads. Never called automatically: a commissioner
 * confirms the batch's season year and reviews it first (that's the whole
 * point of staging it rather than writing FypdSelection directly at
 * import time - see the "never invent a year" rule in fypd-history.ts).
 *
 * Team assignment resolves each pick's raw "team" value - which is
 * always the *current* owner's manager name, not a team name and not
 * necessarily whoever ran the franchise the year the pick happened (see
 * resolveTeamIdByCurrentManagerName) - so a spelling quirk like
 * "Matty J" still resolves correctly. A pick whose name doesn't resolve
 * to any current manager is skipped and reported, never guessed onto
 * the nearest team.
 *
 * Round/pickInRound come from getSnakeSlot on the pick's own recorded
 * overall position - not from replaying a computed draft order - since
 * the source data already encodes the real snake sequence directly.
 */
export async function promoteFypdBatch(db: Db, batchId: string): Promise<FypdPromotionResult> {
  const batch = await db.fypdImportBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.status !== "PENDING_REVIEW") {
    throw new Error(`Batch is ${batch.status}, not PENDING_REVIEW - it may already have been promoted.`);
  }
  if (batch.seasonYear === null) {
    throw new Error("This batch's season year hasn't been confirmed yet - it can't be promoted until it is.");
  }
  const seasonYear = batch.seasonYear;

  const picks = (batch.rawPicks as unknown as RawFypdPick[])
    .filter((p): p is RawFypdPick & { overallPickInSource: number } => p.overallPickInSource !== null)
    .sort((a, b) => a.overallPickInSource - b.overallPickInSource);

  const rounds = picks.reduce((max, p) => Math.max(max, getSnakeSlot(p.overallPickInSource, TEAM_COUNT).round), 1);

  const draft = await db.fypdDraft.upsert({
    where: { leagueId_year: { leagueId: batch.leagueId, year: seasonYear } },
    create: {
      leagueId: batch.leagueId,
      year: seasonYear,
      rounds,
      status: "COMPLETE",
      currentOverallPick: picks.length + 1,
    },
    update: {},
  });

  const playerCache = new Map<string, string>(); // player name -> id
  async function getOrCreatePlayer(name: string, positionRaw: string | null): Promise<string> {
    if (playerCache.has(name)) return playerCache.get(name)!;
    const existing = await db.player.findFirst({ where: { leagueId: batch.leagueId, name } });
    const positions = positionRaw
      ? positionRaw
          .split("/")
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    const player =
      existing ?? (await db.player.create({ data: { leagueId: batch.leagueId, name, positions, mlbDraftYear: seasonYear } }));
    playerCache.set(name, player.id);
    return player.id;
  }

  const roundOneOrder = new Map<number, string>(); // slot -> teamId
  const skipped: SkippedFypdPick[] = [];
  let picksPromoted = 0;

  for (const pick of picks) {
    if (!pick.teamNameRaw || !pick.playerName) {
      skipped.push({ ...pick, reason: "Missing a team or player name in the source." });
      continue;
    }
    const teamId = await resolveTeamIdByCurrentManagerName(db, batch.leagueId, pick.teamNameRaw);
    if (!teamId) {
      skipped.push({ ...pick, reason: `No current manager/team found named "${pick.teamNameRaw}".` });
      continue;
    }

    const playerId = await getOrCreatePlayer(pick.playerName, pick.positionRaw);
    const slot = getSnakeSlot(pick.overallPickInSource, TEAM_COUNT);
    if (slot.round === 1) roundOneOrder.set(slot.pickInRound, teamId);

    await db.fypdSelection.upsert({
      where: { draftId_overallPick: { draftId: draft.id, overallPick: pick.overallPickInSource } },
      create: {
        draftId: draft.id,
        round: slot.round,
        pickInRound: slot.pickInRound,
        overallPick: pick.overallPickInSource,
        teamId,
        playerId,
      },
      update: { round: slot.round, pickInRound: slot.pickInRound, teamId, playerId },
    });
    picksPromoted++;
  }

  for (const [slot, teamId] of roundOneOrder) {
    await db.fypdDraftOrderSlot.upsert({
      where: { draftId_slot: { draftId: draft.id, slot } },
      create: { draftId: draft.id, teamId, slot, reason: "Historical import - round-1 order as recorded in the source workbook." },
      update: { teamId },
    });
  }

  await db.fypdImportBatch.update({ where: { id: batch.id }, data: { status: "CONFIRMED", confirmedAt: new Date() } });

  return { draftId: draft.id, seasonYear, picksPromoted, playersCreated: playerCache.size, skipped };
}
