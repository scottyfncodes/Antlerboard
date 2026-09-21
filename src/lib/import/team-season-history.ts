/**
 * Parses a manager sheet's season-block header labels (e.g.
 * "Dallas Eagles - 2025 - 10th", "Bluth Co. Softball - 2021") into
 * structured records. Source format, confirmed against the real workbook:
 * "<team name> - <4-digit year>[ - <finish>]" - the year is always
 * present and unambiguous; only the trailing finish segment is optional,
 * and it can be plain text ("10th") or an emoji medal.
 *
 * Deliberately does not guess a year for a label that doesn't contain
 * one - see YEAR_PATTERN below. A label failing to parse at all is
 * returned with a flag rather than silently dropped.
 */

import type { ParsedTeamSeasonBlock, ResolvedTeamSeasonRecord } from "./types";
import { KNOWN_HANDOFFS, CONFIRMED_ORIGINALS, resolveSeasonManager } from "./known-league-history";

// The trailing "- finish" segment is optional and, in the real data, can be
// present but empty (a dangling "- " with nothing after it) - `(.*)` (not
// `(.+)`) so that still matches instead of failing the whole label.
const YEAR_PATTERN = /-\s*(\d{4})(?:\s*-\s*(.*))?$/;

export function parseTeamSeasonLabel(managerSheetName: string, label: string): ParsedTeamSeasonBlock {
  const trimmed = label.trim();
  const match = trimmed.match(YEAR_PATTERN);

  if (!match) {
    return {
      managerSheetName,
      teamName: trimmed,
      seasonYear: null,
      finish: null,
      sourceLabel: label,
      flags: ["No 4-digit year found in this label - season year could not be determined."],
    };
  }

  const year = Number(match[1]);
  const teamName = trimmed.slice(0, match.index).replace(/-\s*$/, "").trim();
  const finish = match[2]?.trim() || null;

  const flags: string[] = [];
  if (!teamName) flags.push("Team name segment was empty after stripping the year/finish.");

  return { managerSheetName, teamName, seasonYear: year, finish, sourceLabel: label, flags };
}

/** Parses every season-block label for one manager sheet's header row. */
export function parseManagerSheetSeasonBlocks(
  managerSheetName: string,
  headerLabels: (string | null | undefined)[]
): ParsedTeamSeasonBlock[] {
  return headerLabels
    .filter((label): label is string => !!label && label.trim().length > 0)
    .map((label) => parseTeamSeasonLabel(managerSheetName, label));
}

/**
 * Attributes each parsed season block to whoever actually ran it, using
 * the confirmed handoff history in known-league-history.ts. This is the
 * one place a franchise's sheet-name label ("this is filed under Andrew")
 * gets corrected to the real historical manager ("but 2021-2023 was
 * Stan") - see that module's own docs for why the raw spreadsheet can't
 * tell us this on its own.
 */
export function resolveTeamSeasonRecords(records: ParsedTeamSeasonBlock[]): ResolvedTeamSeasonRecord[] {
  return records.map((r) => {
    if (r.seasonYear === null) {
      return { ...r, resolvedManagerName: r.managerSheetName, attribution: "unattributed" };
    }
    const hasHandoff = KNOWN_HANDOFFS.some((h) => h.currentManagerSheetName === r.managerSheetName);
    if (hasHandoff) {
      return {
        ...r,
        resolvedManagerName: resolveSeasonManager(r.managerSheetName, r.seasonYear),
        attribution: "confirmed_handoff",
      };
    }
    if (CONFIRMED_ORIGINALS.has(r.managerSheetName)) {
      return { ...r, resolvedManagerName: r.managerSheetName, attribution: "confirmed_original" };
    }
    return { ...r, resolvedManagerName: r.managerSheetName, attribution: "inferred_continuous" };
  });
}
