/**
 * Parses the season blocks on a manager sheet of the commissioner's
 * master workbook. Confirmed layout (one block per season, side by side,
 * 7 columns plus a spacer):
 *
 *   row 2:  team-name label in the block's third column
 *           ("Ranger Thingz - 2025 - 4th")
 *   row 4:  Keepers | Keeper Cost | Draft | Draft Cost | EOY | cost | next cost
 *   row 5+: keepers (ending at a "Total" row whose cost cell is the sum),
 *           auction buys, and the end-of-year roster with this season's
 *           cost and the hand-projected next-season keeper cost.
 *
 * Below the lists sit three things that must NOT be read as roster rows:
 * the escalation legend in the keeper columns ("25 > 26", "Plus $9" ...),
 * an "FYPD" marker row followed by a prospect table (Player Name / Team /
 * Position / Draft Age) that reuses the draft and draft-cost columns, and
 * an offseason-trade mini-log. Every list therefore stops at the first
 * marker row, and the keeper list stops at "Total".
 */

import type { CostedPlayer, EoyRosterRow, ManagerSeasonBlock, ProspectRow } from "./league-history-types";
import { parseTeamSeasonLabel } from "./team-season-history";

type Cell = string | number | Date | null | undefined;

const BLOCK_WIDTH = 8;
const LABEL_ROW = 1; // 0-based row index of the team-name labels
const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;

function asTrimmedString(v: Cell): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function asNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function isTotalLabel(s: string | null): boolean {
  return !!s && /^total\b/i.test(s);
}

function isLegendText(s: string | null): boolean {
  return !!s && (/^plus\s*\$?\d+/i.test(s) || /^\d{2}\s*>\s*\d{2}/.test(s) || /^fr?e?om\s+\d{2}\s+to\s+\d{2}/i.test(s));
}

/** The "FYPD" marker and the "26 > 27 Off Season Trades" marker both end the roster lists. */
function markerKind(row: Cell[], start: number): "fypd" | "trades" | null {
  for (let c = start; c < start + BLOCK_WIDTH - 1; c++) {
    const s = asTrimmedString(row[c]);
    if (!s) continue;
    if (/^fypd$/i.test(s)) return "fypd";
    if (/off\s*season\s*trades/i.test(s)) return "trades";
  }
  return null;
}

/** Column indexes whose row-2 cell is a season label; each marks a block. */
export function findBlockStarts(rows: Cell[][]): number[] {
  const labelRow = rows[LABEL_ROW] ?? [];
  const starts: number[] = [];
  labelRow.forEach((cell, idx) => {
    const s = asTrimmedString(cell);
    if (s && /-\s*\d{4}/.test(s)) starts.push(Math.max(0, idx - 2));
  });
  return starts;
}

export function parseManagerSheetBlocks(managerSheetName: string, rows: Cell[][]): ManagerSeasonBlock[] {
  return findBlockStarts(rows).map((start) => parseBlock(managerSheetName, rows, start));
}

function parseBlock(managerSheetName: string, rows: Cell[][], start: number): ManagerSeasonBlock {
  const label = asTrimmedString(rows[LABEL_ROW]?.[start + 2]) ?? "";
  const parsedLabel = parseTeamSeasonLabel(managerSheetName, label);
  const flags = [...parsedLabel.flags];

  const header = rows[HEADER_ROW] ?? [];
  if (!/keeper/i.test(asTrimmedString(header[start]) ?? "")) {
    flags.push(`Block at column ${start + 1}: header row does not start with "Keepers" - layout may have shifted.`);
  }
  if (/2025 cost/i.test(asTrimmedString(header[start + 5]) ?? "") && parsedLabel.seasonYear !== 2025) {
    flags.push("End-of-year cost column still carries a stale \"2025 Cost\" header (copy-paste); read positionally.");
  }

  const keepers: CostedPlayer[] = [];
  const draft: CostedPlayer[] = [];
  const eoyRoster: EoyRosterRow[] = [];
  const prospects: ProspectRow[] = [];
  let keeperTotal: number | null = null;
  let keepersClosed = false;
  let section: "roster" | "fypd-header" | "fypd" | "trades" = "roster";

  for (let r = FIRST_DATA_ROW; r < rows.length; r++) {
    const row = rows[r] ?? [];

    // The EOY roster (columns 5-7 of the block) runs down the sheet past
    // the FYPD table and trade mini-log, which only ever occupy the first
    // four columns - so it is read on every row regardless of section.
    const eoyName = asTrimmedString(row[start + 4]);
    if (eoyName && !isLegendText(eoyName) && !/^eoy$/i.test(eoyName)) {
      eoyRoster.push({ name: eoyName, cost: asNumber(row[start + 5]), nextSeasonCost: asNumber(row[start + 6]) });
    }

    const marker = markerKind(row, start);
    if (marker === "fypd") {
      section = "fypd-header";
      continue;
    }
    if (marker === "trades") {
      section = "trades";
      continue;
    }

    if (section === "trades") continue;

    if (section === "fypd-header") {
      // Expect the "Player Name | Team | Position | Draft Age" header next.
      if (/player\s*name/i.test(asTrimmedString(row[start]) ?? "")) {
        section = "fypd";
        continue;
      }
      if (row.slice(start, start + 4).every((c) => asTrimmedString(c) === null)) continue;
      section = "fypd";
    }

    if (section === "fypd") {
      const name = asTrimmedString(row[start]);
      if (!name) continue;
      prospects.push({
        name,
        mlbTeam: asTrimmedString(row[start + 1]),
        position: asTrimmedString(row[start + 2]),
        draftAge: asNumber(row[start + 3]),
      });
      continue;
    }

    // --- keeper and draft columns (end at the FYPD marker) ---
    const keeperName = asTrimmedString(row[start]);
    if (!keepersClosed && keeperName) {
      if (isTotalLabel(keeperName)) {
        keeperTotal = asNumber(row[start + 1]);
        keepersClosed = true;
      } else if (!isLegendText(keeperName)) {
        keepers.push({ name: keeperName, cost: asNumber(row[start + 1]) });
      }
    }

    const draftName = asTrimmedString(row[start + 2]);
    if (draftName && !isLegendText(draftName)) {
      draft.push({ name: draftName, cost: asNumber(row[start + 3]) });
    }
  }

  if (keepers.length > 0 && keeperTotal !== null) {
    const sum = keepers.reduce((acc, k) => acc + (k.cost ?? 0), 0);
    if (sum !== keeperTotal) flags.push(`Keeper costs sum to ${sum} but the sheet's Total row says ${keeperTotal}.`);
  }
  if (keepers.length > 10) flags.push(`${keepers.length} keepers listed - the league maximum is 10.`);

  return {
    managerSheetName,
    seasonYear: parsedLabel.seasonYear,
    teamName: parsedLabel.teamName,
    finish: parsedLabel.finish,
    sourceLabel: label,
    keepers,
    keeperTotal,
    draft,
    eoyRoster,
    prospects,
    flags,
  };
}
