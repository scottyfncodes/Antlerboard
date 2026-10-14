/**
 * Database reads for /history/drafts. Read-only - nothing here writes.
 * The shaping and every data-quality rule live in draft-history.ts.
 */

import { prisma } from "./db";
import {
  auctionCompleteness,
  buildAuctionHistory,
  buildFypdHistory,
  fypdCompleteness,
  nominationOrderOf,
  validateFypdOrder,
  type Completeness,
  type DraftHistory,
  type DraftKind,
} from "./draft-history";

export interface DraftSeasonSummary {
  year: number;
  auction: Completeness;
  fypd: Completeness | null;
}

const playerSelect = { id: true, name: true, mlbTeam: true, positions: true } as const;
const teamSelect = { id: true, name: true } as const;

/**
 * Every season with either kind of draft on record, newest first. An auction
 * entry exists for every Season row (it may be "none"); an FYPD entry only
 * where an FypdDraft exists for that year.
 */
export async function listDraftSeasons(leagueId: string): Promise<DraftSeasonSummary[]> {
  const [seasons, pickNumbers, fypdDrafts] = await Promise.all([
    prisma.season.findMany({ where: { leagueId }, select: { id: true, year: true } }),
    prisma.draftPick.findMany({ where: { season: { leagueId } }, select: { seasonYear: true, overallPick: true, sourceRef: true } }),
    prisma.fypdDraft.findMany({
      where: { leagueId },
      select: {
        year: true,
        rounds: true,
        order: { select: { slot: true, team: { select: teamSelect } } },
        selections: { select: { overallPick: true } },
      },
    }),
  ]);

  const years = new Set<number>([...seasons.map((s) => s.year), ...pickNumbers.map((p) => p.seasonYear), ...fypdDrafts.map((d) => d.year)]);
  return [...years]
    .sort((a, b) => b - a)
    .map((year) => {
      const draft = fypdDrafts.find((d) => d.year === year);
      let fypd: Completeness | null = null;
      if (draft) {
        const order = validateFypdOrder(draft.order);
        const expected = order.teams && draft.rounds > 0 ? order.teams.length * draft.rounds : null;
        const numbers = [...new Set(draft.selections.map((s) => s.overallPick))];
        fypd = fypdCompleteness(numbers.length, expected, numbers, order.teams ? null : order.reason);
      }
      const auction = pickNumbers.filter((p) => p.seasonYear === year).map((p) => ({ overallPick: p.overallPick, order: nominationOrderOf(p.sourceRef) }));
      return { year, auction: auctionCompleteness(auction), fypd };
    });
}

export async function loadDraftHistory(leagueId: string, year: number, kind: DraftKind): Promise<DraftHistory> {
  if (kind === "auction") {
    const picks = await prisma.draftPick.findMany({
      where: { seasonYear: year, season: { leagueId } },
      orderBy: { overallPick: "asc" },
      select: {
        id: true,
        round: true,
        pick: true,
        overallPick: true,
        cost: true,
        isKeeperSlot: true,
        sourceRef: true,
        team: { select: teamSelect },
        player: { select: playerSelect },
      },
    });
    return buildAuctionHistory(year, picks);
  }

  const draft = await prisma.fypdDraft.findUnique({
    where: { leagueId_year: { leagueId, year } },
    select: {
      year: true,
      rounds: true,
      order: { select: { slot: true, team: { select: teamSelect } } },
      selections: {
        orderBy: { overallPick: "asc" },
        select: {
          id: true,
          round: true,
          pickInRound: true,
          overallPick: true,
          notes: true,
          team: { select: teamSelect },
          player: { select: playerSelect },
        },
      },
    },
  });
  if (!draft) {
    return {
      kind: "fypd",
      year,
      completeness: { status: "none", recorded: 0, expected: null, note: `No ${year} FYPD draft is stored.` },
      picks: [],
      notes: [],
    };
  }
  return buildFypdHistory(draft);
}
