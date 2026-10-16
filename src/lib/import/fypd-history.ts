/**
 * Extracts a raw pick table from the "FYPD" sheet into an unconfirmed
 * FypdImportBatch-shaped preview. The real workbook has two such tables
 * side by side with no year label anywhere on the sheet (checked row 1
 * and row 2 across every column) - so `seasonYear` here is always null,
 * always flagged, and this never becomes a real FypdDraft/FypdSelection
 * until a commissioner confirms the year through the review step.
 *
 * Column positions differ between the two real tables, so the caller
 * supplies which column holds what (0-based, matching a plain
 * row-major array read of the sheet).
 */

import type { ParsedFypdPick, ParsedFypdSection } from "./types";

type Cell = string | number | Date | null | undefined;

export interface FypdColumnMap {
  pick: number;
  team: number;
  player: number;
  position?: number;
}

function asTrimmedString(v: Cell): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function parseFypdRawSection(
  sourceSheet: string,
  label: string,
  rows: Cell[][],
  columns: FypdColumnMap,
  /**
   * The year isn't labeled anywhere on the source sheet, so it can only
   * ever be filled in here from an explicit, out-of-band confirmation
   * (e.g. known-fypd-drafts.ts) - never guessed from row content.
   */
  confirmedSeasonYear?: number
): ParsedFypdSection {
  const picks: ParsedFypdPick[] = [];

  for (const row of rows) {
    const pickVal = row[columns.pick];
    const teamVal = row[columns.team];
    const playerVal = row[columns.player];
    // A real pick always has a player name. Rows with only a bare pick
    // number and no player (seen as a long dangling tail past the last
    // real pick in the real sheet) and the sheet's own header row (caught
    // upstream by slicing it off before this is called) are not picks.
    if (asTrimmedString(playerVal) === null) continue;

    picks.push({
      overallPickInSource: typeof pickVal === "number" ? pickVal : null,
      teamNameRaw: asTrimmedString(teamVal),
      playerName: asTrimmedString(playerVal),
      positionRaw: columns.position !== undefined ? asTrimmedString(row[columns.position]) : null,
      extra: {},
    });
  }

  return {
    sourceSheet,
    label,
    picks,
    seasonYear: confirmedSeasonYear ?? null,
    flags:
      confirmedSeasonYear === undefined
        ? [
            "Draft year is not labeled anywhere on the source sheet - this batch stays PENDING_REVIEW until a commissioner confirms the year (see FypdImportBatch).",
          ]
        : [],
  };
}

/**
 * The FYPD sheet's real layout (0-based columns of the rows below its two
 * title/header rows):
 *
 * - Table 1, A-D: the 2026 FYPD (2025 MLB class) - pick, team, player.
 * - Table 2, R-T: the 2025 FYPD (2024 MLB class) - pick, team, player.
 * - U-Y, right beside Table 2: a separate reference list of the 2024 MLB
 *   draft (MLB pick #, name, POS, drafted by, school), one MLB pick per
 *   row. Its POS on a given row belongs to that MLB pick, not to the FYPD
 *   pick on the same row - e.g. FYPD #2 Travis Bazzana sits beside MLB
 *   #2's "RHP / Cincinnati Reds / Wake Forest" (Chase Burns). So no
 *   position is read for Table 2; Yahoo supplies real positions once a
 *   prospect is on a roster. (Production's 2025 FYPD prospects carried
 *   these until 2026-10-16 - see the fypd-2025-position-clear audit entry.)
 */
export const FYPD_TABLE_1_COLUMNS: FypdColumnMap = { pick: 0, team: 1, player: 2 };
export const FYPD_TABLE_2_COLUMNS: FypdColumnMap = { pick: 17, team: 18, player: 19 };

/** Both pick tables from the FYPD sheet's rows (title and header rows already removed). */
export function parseFypdSheet(rows: Cell[][], table1Year: number, table2Year: number): ParsedFypdSection[] {
  return [
    parseFypdRawSection("FYPD", "Table 1 (cols A-D)", rows, FYPD_TABLE_1_COLUMNS, table1Year),
    parseFypdRawSection("FYPD", "Table 2 (cols R-Y)", rows, FYPD_TABLE_2_COLUMNS, table2Year),
  ];
}
