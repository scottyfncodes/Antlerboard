/**
 * Parses the "Season prop bets" sheet: rows of (Team1, Team2, Amount, Bet
 * description), with a season year given only by a marker row - a row
 * whose first cell is a bare number and whose other cells are empty
 * (confirmed shape: e.g. a lone `2023` before that year's bets). Rows
 * before the first marker have no explicit year anywhere and are flagged
 * rather than assigned a guessed one.
 */

import type { ParsedPropBet } from "./types";

type Cell = string | number | null | undefined;

function asTrimmedString(v: Cell): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function isYearMarkerRow(row: Cell[]): number | null {
  const [a, b, c, d] = row;
  return typeof a === "number" && b == null && c == null && d == null ? a : null;
}

export function parsePropBetRows(rows: Cell[][]): ParsedPropBet[] {
  const results: ParsedPropBet[] = [];
  let currentYear: number | null = null;

  rows.forEach((row, idx) => {
    const marker = isYearMarkerRow(row);
    if (marker !== null) {
      currentYear = marker;
      return;
    }

    const [a, b, c, d] = row;
    const teamAName = asTrimmedString(a);
    const teamBName = asTrimmedString(b);
    const description = asTrimmedString(d);
    if (!teamAName && !teamBName && !description) return; // blank row

    const flags: string[] = [];
    if (currentYear === null) flags.push("No season-year marker precedes this row.");
    if (!teamAName) flags.push("Missing Team 1 name.");
    if (!teamBName) flags.push("Missing Team 2 name.");
    if (!description) flags.push("Missing bet description.");

    results.push({
      seasonYear: currentYear,
      teamAName: teamAName ?? "",
      teamBName: teamBName ?? "",
      amount: typeof c === "number" ? c : null,
      description: description ?? "",
      sourceRef: `row ${idx + 1}`,
      flags,
    });
  });

  return results;
}
