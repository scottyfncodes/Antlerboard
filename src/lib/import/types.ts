/**
 * Shared preview types for the historical-spreadsheet import pipeline.
 *
 * Every parser in this directory is pure (plain arrays in, typed records
 * out - no Prisma, no file I/O) so they're cheap to test against small
 * synthetic fixtures that mirror the real workbook's shapes without
 * embedding the league's actual historical data (people's real names,
 * real trades, real bets) into the committed test suite.
 *
 * A parser's job stops at "here is what the source says, and here is
 * what I'm not confident about" - it never guesses a missing value. Every
 * result type below carries a `flags` array for exactly that: reasons a
 * human should look at this row before it's committed to the database.
 */

export interface ParsedTeamSeasonBlock {
  managerSheetName: string;
  teamName: string;
  seasonYear: number | null;
  finish: string | null;
  /** The raw, unparsed label this was extracted from - for auditability. */
  sourceLabel: string;
  flags: string[];
}

export type SeasonAttribution = "confirmed_handoff" | "confirmed_original" | "inferred_continuous" | "unattributed";

export interface ResolvedTeamSeasonRecord extends ParsedTeamSeasonBlock {
  /** Who actually ran the team this season - may differ from managerSheetName (see known-league-history.ts). */
  resolvedManagerName: string;
  attribution: SeasonAttribution;
}

export interface ParsedPropBet {
  seasonYear: number | null;
  teamAName: string;
  teamBName: string;
  amount: number | null;
  description: string;
  sourceRef: string;
  flags: string[];
}

export interface ParsedTrade {
  seasonYear: number | null;
  tradeDate: string | null;
  teamAName: string;
  teamAPlayersRaw: string | null;
  teamADropsRaw: string | null;
  teamBName: string;
  teamBPlayersRaw: string | null;
  teamBDropsRaw: string | null;
  sourceRef: string;
  flags: string[];
}

export interface ParsedDraftDayEvent {
  seasonYear: number | null;
  venue: string | null;
  dateRangeRaw: string | null;
  attendeesRaw: string | null;
  /** Raw hour-by-hour agenda, if the sheet has one below the attendee list. */
  scheduleRaw: string | null;
  sourceRef: string;
  flags: string[];
}

/** One raw pick from an FYPD table whose draft year isn't labeled in the source. */
export interface ParsedFypdPick {
  overallPickInSource: number | null;
  teamNameRaw: string | null;
  playerName: string | null;
  positionRaw: string | null;
  extra: Record<string, unknown>;
}

export interface ParsedFypdSection {
  sourceSheet: string;
  label: string;
  picks: ParsedFypdPick[];
  /** Only ever non-null via an explicit out-of-band confirmation - see parseFypdRawSection. */
  seasonYear: number | null;
  flags: string[];
}
