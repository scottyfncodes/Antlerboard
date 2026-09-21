/**
 * FYPD (First-Year Player Draft) database bridge. Wraps the pure
 * src/lib/fypd-order-engine.ts and src/lib/fypd-snake-engine.ts with
 * Prisma reads/writes - the engines stay DB-free and cheap to test
 * exhaustively; this layer is what commissioner-facing API routes call.
 */

import { prisma } from "./db";
import { computeFypdDraftOrder } from "./fypd-order-engine";
import { getSnakeSlot } from "./fypd-snake-engine";
import type { FypdDraft, FypdSelection } from "@prisma/client";

export class FypdActionError extends Error {}

/**
 * Creates a new FYPD draft and computes its round-1 order from the
 * *previous* season's final standings, per C&A's 9th-Brigade rule. The
 * 9th Brigade designation itself isn't derivable from standings (see
 * fypd-order-engine.ts) so it's a required input here.
 */
export async function createFypdDraft(
  leagueId: string,
  year: number,
  rounds: number,
  ninthBrigadeTeamId: string
): Promise<FypdDraft> {
  const prevSeason = await prisma.season.findFirst({ where: { leagueId, year: year - 1 } });
  if (!prevSeason) {
    throw new FypdActionError(`No ${year - 1} season found to read standings from.`);
  }

  const standings = await prisma.teamStanding.findMany({ where: { seasonId: prevSeason.id } });
  if (standings.some((s) => s.rank === null)) {
    throw new FypdActionError(`Every team needs a final rank recorded for ${year - 1} before the FYPD order can be set.`);
  }

  let order;
  try {
    order = computeFypdDraftOrder(
      standings.map((s) => ({ teamId: s.teamId, rank: s.rank! })),
      ninthBrigadeTeamId
    );
  } catch (err) {
    throw new FypdActionError(err instanceof Error ? err.message : "Could not compute the FYPD draft order.");
  }

  return prisma.fypdDraft.create({
    data: {
      leagueId,
      year,
      rounds,
      order: { create: order.map((o) => ({ teamId: o.teamId, slot: o.slot, reason: o.reason })) },
    },
  });
}

export async function startFypdDraft(draftId: string): Promise<void> {
  await prisma.fypdDraft.update({ where: { id: draftId }, data: { status: "IN_PROGRESS", startedAt: new Date() } });
}

export async function pauseFypdDraft(draftId: string): Promise<void> {
  await prisma.fypdDraft.update({ where: { id: draftId }, data: { status: "PAUSED" } });
}

export async function resumeFypdDraft(draftId: string): Promise<void> {
  await prisma.fypdDraft.update({ where: { id: draftId }, data: { status: "IN_PROGRESS" } });
}

/**
 * Records the next pick. Whose turn it is and which round/pickInRound this
 * is are computed from the draft's stored round-1 order via the snake
 * engine - never trusted from client input - so the turn order can't be
 * spoofed or drift out of sync.
 */
export async function makeFypdSelection(draftId: string, playerId: string): Promise<FypdSelection> {
  const draft = await prisma.fypdDraft.findUnique({
    where: { id: draftId },
    include: { order: { orderBy: { slot: "asc" } } },
  });
  if (!draft) throw new FypdActionError("Draft not found.");
  if (draft.status !== "IN_PROGRESS") {
    throw new FypdActionError(`Draft is ${draft.status.toLowerCase().replace("_", " ")}, not in progress.`);
  }

  const orderTeamIds = draft.order.map((o) => o.teamId);
  const totalPicks = orderTeamIds.length * draft.rounds;
  if (draft.currentOverallPick > totalPicks) {
    throw new FypdActionError("Draft has no picks remaining.");
  }

  const alreadyTaken = await prisma.fypdSelection.findFirst({ where: { draftId, playerId } });
  if (alreadyTaken) throw new FypdActionError("That player has already been selected in this draft.");

  const slot = getSnakeSlot(draft.currentOverallPick, orderTeamIds.length);
  const teamId = orderTeamIds[slot.orderIndex];
  const nextPick = draft.currentOverallPick + 1;
  const isComplete = nextPick > totalPicks;

  const [selection] = await prisma.$transaction([
    prisma.fypdSelection.create({
      data: {
        draftId,
        round: slot.round,
        pickInRound: slot.pickInRound,
        overallPick: draft.currentOverallPick,
        teamId,
        playerId,
      },
    }),
    prisma.fypdDraft.update({
      where: { id: draftId },
      data: {
        currentOverallPick: nextPick,
        ...(isComplete ? { status: "COMPLETE", completedAt: new Date() } : {}),
      },
    }),
  ]);

  return selection;
}

/**
 * Commissioner correction for a misclick - removes the most recent
 * selection and rewinds the pick pointer, reopening a draft that had just
 * auto-completed if that was its last pick. Never touches any selection
 * but the most recent one, so earlier history can't be disturbed by an
 * undo chain leaving gaps.
 */
export async function undoLastFypdSelection(draftId: string): Promise<void> {
  const draft = await prisma.fypdDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw new FypdActionError("Draft not found.");

  const last = await prisma.fypdSelection.findFirst({ where: { draftId }, orderBy: { overallPick: "desc" } });
  if (!last) throw new FypdActionError("No selections to undo.");

  await prisma.$transaction([
    prisma.fypdSelection.delete({ where: { id: last.id } }),
    prisma.fypdDraft.update({
      where: { id: draftId },
      data: {
        currentOverallPick: last.overallPick,
        status: draft.status === "COMPLETE" ? "IN_PROGRESS" : draft.status,
        completedAt: null,
      },
    }),
  ]);
}

/**
 * Marks FYPD call-up rights as exercised. This NEVER deletes the
 * FypdSelection row - the historical fact "Manager X drafted Player Y in
 * the {year} FYPD" is permanent. It only records that the call-up
 * happened and clears isDpud, since an active roster player isn't sitting
 * protected on the waiver wire anymore. (Once Yahoo sync exists, this is
 * the function it should call when it detects the corresponding Yahoo
 * acquisition - see project notes on FYPD/DPUD/Yahoo reconciliation.)
 */
export async function exerciseFypdCallUp(selectionId: string): Promise<void> {
  await prisma.fypdSelection.update({
    where: { id: selectionId },
    data: { callUpExercised: true, callUpExercisedAt: new Date(), isDpud: false },
  });
}

/** Commissioner-maintained until Yahoo sync can compute this automatically. */
export async function setDpudStatus(selectionId: string, isDpud: boolean): Promise<void> {
  await prisma.fypdSelection.update({ where: { id: selectionId }, data: { isDpud } });
}
