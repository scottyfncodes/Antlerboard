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
  columns: FypdColumnMap
): ParsedFypdSection {
  const picks: ParsedFypdPick[] = [];

  for (const row of rows) {
    const pickVal = row[columns.pick];
    const teamVal = row[columns.team];
    const playerVal = row[columns.player];
    if (pickVal == null && teamVal == null && playerVal == null) continue; // blank row

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
    seasonYear: null,
    flags: [
      "Draft year is not labeled anywhere on the source sheet - this batch stays PENDING_REVIEW until a commissioner confirms the year (see FypdImportBatch).",
    ],
  };
}
