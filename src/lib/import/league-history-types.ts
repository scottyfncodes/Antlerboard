/**
 * Shared types for the league-history import: the three sources that,
 * together, reconstruct every keeper-relevant event since 2021.
 *
 *  - Yahoo transaction export (CSV): in-season adds (with FAAB bids),
 *    drops, and trades, keyed by Yahoo's stable player ids.
 *  - Canonical auction history (xlsx): every auction price and every
 *    declared keeper per season, from Yahoo's draft results.
 *  - The commissioner's master workbook: per-manager season blocks
 *    (keepers / draft / end-of-year roster with recorded costs), the
 *    offseason trade log, and the FYPD prospect lists.
 *
 * Like the rest of this directory, every parser is pure and every result
 * carries `flags` for anything a human should look at before commit.
 */

export type YahooTransactionType = "add" | "drop" | "add/drop" | "trade" | "commish" | "other";

export interface YahooTransactionPlayer {
  yahooPlayerId: string;
  name: string;
  mlbTeam: string | null;
  positions: string[];
  /** What happened to this player inside the transaction. */
  action: "add" | "drop" | "trade" | "other";
  sourceType: string | null;
  sourceTeamName: string | null;
  destinationType: string | null;
  destinationTeamName: string | null;
}

export interface YahooTransaction {
  seasonYear: number;
  leagueKey: string;
  transactionKey: string;
  type: YahooTransactionType;
  status: string;
  timestamp: Date;
  faabBid: number | null;
  traderTeamName: string | null;
  tradeeTeamName: string | null;
  players: YahooTransactionPlayer[];
}

export interface ParsedYahooTransactions {
  transactions: YahooTransaction[];
  /** Distinct Yahoo team names seen per season - what the alias resolver has to map. */
  teamNamesBySeason: Record<number, string[]>;
  flags: string[];
}

export interface AuctionRow {
  seasonLabel: string;
  seasonYear: number | null;
  pick: number | null;
  playerName: string;
  mlbTeam: string | null;
  positions: string[];
  salary: number | null;
  teamName: string;
  isKeeper: boolean;
  sourceRef: string;
  flags: string[];
}

export interface CostedPlayer {
  name: string;
  cost: number | null;
}

export interface EoyRosterRow extends CostedPlayer {
  /** The workbook's own projection of what keeping this player next season would cost. */
  nextSeasonCost: number | null;
}

export interface ProspectRow {
  name: string;
  mlbTeam: string | null;
  position: string | null;
  draftAge: number | null;
}

/** One season's block (7 columns + spacer) from a manager sheet. */
export interface ManagerSeasonBlock {
  managerSheetName: string;
  seasonYear: number | null;
  teamName: string;
  finish: string | null;
  sourceLabel: string;
  keepers: CostedPlayer[];
  keeperTotal: number | null;
  draft: CostedPlayer[];
  eoyRoster: EoyRosterRow[];
  prospects: ProspectRow[];
  flags: string[];
}
