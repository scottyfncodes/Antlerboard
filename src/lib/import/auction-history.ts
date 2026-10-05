/**
 * Parses the canonical auction-history workbook: a flat table per sheet
 * with a header row of Season / Pick / Player / MLB_Team / Pos / Salary /
 * Fantasy_Team (and, in the combined PARSED_OUTPUT form, IsKeeper). The
 * "Keepers_AllSeasons" sheet lists declared keepers at their keeper
 * price; "Auctions_AllSeasons" lists live-auction buys.
 *
 * Seasons are labeled "Season_1" ... "Season_5" (one sheet has a bare 5
 * where "Season_5" was meant); the caller says which calendar year
 * Season_1 is, since the file itself never does. A 4-digit label is taken
 * as the year directly.
 */

import type { AuctionRow } from "./league-history-types";

type Cell = string | number | Date | null | undefined;

export interface AuctionSheetOptions {
  sheetName: string;
  /** Calendar year of "Season_1". */
  firstSeasonYear: number;
  /** Forces every row's keeper flag (for a sheet that is all keepers or all auction buys). */
  isKeeper?: boolean;
}

function asTrimmedString(v: Cell): string | null {
  if (typeof v === "string") return v.trim().length > 0 ? v.trim() : null;
  if (typeof v === "number") return String(v);
  return null;
}

function asNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

export function seasonLabelToYear(label: string, firstSeasonYear: number): number | null {
  const trimmed = label.trim();
  const direct = trimmed.match(/^(\d{4})$/);
  if (direct) return Number(direct[1]);
  const ordinal = trimmed.match(/^(?:season[_\s-]*)?(\d{1,2})(?:\.0)?$/i);
  if (ordinal) return firstSeasonYear + Number(ordinal[1]) - 1;
  return null;
}

function findColumn(header: string[], ...candidates: string[]): number {
  for (const c of candidates) {
    const idx = header.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

export function parseAuctionHistorySheet(rows: Cell[][], options: AuctionSheetOptions): AuctionRow[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => (typeof h === "string" ? h.trim().toLowerCase() : ""));
  const col = {
    season: findColumn(header, "season"),
    pick: findColumn(header, "pick"),
    player: findColumn(header, "player", "player_name", "name"),
    mlbTeam: findColumn(header, "mlb_team", "mlb team", "team_abbr"),
    pos: findColumn(header, "pos", "position", "positions"),
    salary: findColumn(header, "salary", "cost", "price"),
    team: findColumn(header, "fantasy_team", "fantasy team", "team"),
    isKeeper: findColumn(header, "iskeeper", "is_keeper", "keeper"),
  };
  if (col.player === -1 || col.team === -1 || col.season === -1) return [];

  const out: AuctionRow[] = [];
  rows.slice(1).forEach((row, i) => {
    const playerName = asTrimmedString(row[col.player]);
    const teamName = asTrimmedString(row[col.team]);
    const seasonLabel = asTrimmedString(row[col.season]);
    if (!playerName && !teamName) return;

    const flags: string[] = [];
    const seasonYear = seasonLabel ? seasonLabelToYear(seasonLabel, options.firstSeasonYear) : null;
    if (seasonYear === null) flags.push("Season label could not be mapped to a year.");
    if (!playerName) flags.push("Missing player name.");
    if (!teamName) flags.push("Missing fantasy team name.");
    const salary = col.salary === -1 ? null : asNumber(row[col.salary]);
    if (salary === null) flags.push("Missing salary.");

    const keeperCell = col.isKeeper === -1 ? null : asNumber(row[col.isKeeper]);
    const isKeeper = options.isKeeper ?? (keeperCell === null ? false : keeperCell !== 0);

    out.push({
      seasonLabel: seasonLabel ?? "",
      seasonYear,
      pick: col.pick === -1 ? null : asNumber(row[col.pick]),
      playerName: playerName ?? "",
      mlbTeam: col.mlbTeam === -1 ? null : asTrimmedString(row[col.mlbTeam]),
      positions:
        col.pos === -1
          ? []
          : (asTrimmedString(row[col.pos]) ?? "")
              .split(/[,/]/)
              .map((p) => p.trim())
              .filter(Boolean),
      salary,
      teamName: teamName ?? "",
      isKeeper,
      sourceRef: `${options.sheetName} row ${i + 2}`,
      flags,
    });
  });
  return out;
}
