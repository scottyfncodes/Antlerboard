/**
 * Parses the "Off Season Trades" sheet: rows of (Date of Trade, Team 1,
 * Team 1's outgoing players, Team 2, Team 2's outgoing players, Team 1
 * drops, Team 2 drops), grouped by a bare-year marker row the same way as
 * prop-bets.ts. A real trade row always carries its own exact date - that
 * date is read as-is (never used to *infer* a season year on its own,
 * since an offseason trade's calendar date and its season attribution
 * aren't reliably the same thing without an explicit marker).
 */

import type { ParsedTrade } from "./types";

type Cell = string | number | Date | null | undefined;

function asTrimmedString(v: Cell): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function isYearMarkerRow(row: Cell[]): number | null {
  const [a, b, c, d] = row;
  return typeof a === "number" && b == null && c == null && d == null ? a : null;
}

export function parseTradeRows(rows: Cell[][]): ParsedTrade[] {
  const results: ParsedTrade[] = [];
  let currentYear: number | null = null;

  rows.forEach((row, idx) => {
    const marker = isYearMarkerRow(row);
    if (marker !== null) {
      currentYear = marker;
      return;
    }

    const [dateVal, teamA, teamAPlayers, teamB, teamBPlayers, teamADrops, teamBDrops] = row;
    const teamAName = asTrimmedString(teamA);
    const teamBName = asTrimmedString(teamB);
    if (!teamAName && !teamBName) return; // blank row

    const flags: string[] = [];
    if (currentYear === null) {
      flags.push("No season-year marker precedes this row - only the trade's own date (if present) is known.");
    }
    if (!teamAName) flags.push("Missing Team 1 name.");
    if (!teamBName) flags.push("Missing Team 2 name.");

    let tradeDate: string | null = null;
    if (dateVal instanceof Date) {
      tradeDate = dateVal.toISOString();
    } else {
      flags.push("No trade date recorded.");
    }

    results.push({
      seasonYear: currentYear,
      tradeDate,
      teamAName: teamAName ?? "",
      teamAPlayersRaw: asTrimmedString(teamAPlayers),
      teamADropsRaw: asTrimmedString(teamADrops),
      teamBName: teamBName ?? "",
      teamBPlayersRaw: asTrimmedString(teamBPlayers),
      teamBDropsRaw: asTrimmedString(teamBDrops),
      sourceRef: `row ${idx + 1}`,
      flags,
    });
  });

  return results;
}
