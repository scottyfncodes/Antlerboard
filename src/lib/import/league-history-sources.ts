/**
 * Reads the three league-history upload files into the builder's inputs.
 * Kept out of the route so the same code can run from a script or a test
 * against files on disk.
 */

import ExcelJS from "exceljs";
import { worksheetToRows } from "./workbook-reader";
import { parseManagerSheetBlocks } from "./manager-blocks";
import { parseTradeRows } from "./trades";
import { parseFypdRawSection } from "./fypd-history";
import { parseAuctionHistorySheet } from "./auction-history";
import { parseYahooTransactionsCsv } from "./yahoo-transactions";
import { FranchiseResolver, type FranchiseNameRecord } from "./team-aliases";
import type { AuctionRow, ManagerSeasonBlock, ParsedYahooTransactions } from "./league-history-types";
import type { ParsedTrade } from "./types";

/** The 12 current managers' sheet names - the franchise identities everything resolves to. */
export const MANAGER_SHEETS = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];

export interface MasterWorkbookSources {
  blocks: ManagerSeasonBlock[];
  offseasonTrades: ParsedTrade[];
  prospectNames: string[];
  sheetsFound: string[];
}

export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

export function readMasterWorkbook(wb: ExcelJS.Workbook): MasterWorkbookSources {
  const blocks: ManagerSeasonBlock[] = [];
  const sheetsFound: string[] = [];
  for (const name of MANAGER_SHEETS) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    sheetsFound.push(name);
    blocks.push(...parseManagerSheetBlocks(name, worksheetToRows(ws)));
  }

  const tradesWs = wb.getWorksheet("Off Season Trades");
  const offseasonTrades = tradesWs ? parseTradeRows(worksheetToRows(tradesWs).slice(1)) : [];

  const prospectNames: string[] = [];
  const fypdWs = wb.getWorksheet("FYPD");
  if (fypdWs) {
    const rows = worksheetToRows(fypdWs).slice(2);
    for (const section of [
      parseFypdRawSection("FYPD", "Table 1", rows, { pick: 0, team: 1, player: 2 }),
      parseFypdRawSection("FYPD", "Table 2", rows, { pick: 17, team: 18, player: 19, position: 22 }),
    ]) {
      for (const p of section.picks) if (p.playerName) prospectNames.push(p.playerName);
    }
  }
  const dpudWs = wb.getWorksheet("DPUD");
  if (dpudWs) {
    for (const row of worksheetToRows(dpudWs)) {
      if (typeof row[1] === "string" && row[1].trim()) prospectNames.push(row[1].trim());
    }
  }

  return { blocks, offseasonTrades, prospectNames, sheetsFound };
}

export function readAuctionWorkbook(wb: ExcelJS.Workbook, firstSeasonYear: number): AuctionRow[] {
  const rows: AuctionRow[] = [];
  const hasKeeperSheet = wb.worksheets.some((ws) => /keeper/i.test(ws.name));
  for (const ws of wb.worksheets) {
    if (/dictionary|readme|paste_here/i.test(ws.name)) continue;
    // Prefer the split Auctions/Keepers sheets; a combined PARSED_OUTPUT
    // sheet (with its own IsKeeper column) is only used when they're absent.
    if (/parsed_output/i.test(ws.name) && hasKeeperSheet) continue;
    const isKeeper = /keeper/i.test(ws.name) ? true : /auction/i.test(ws.name) ? false : undefined;
    rows.push(...parseAuctionHistorySheet(worksheetToRows(ws), { sheetName: ws.name, firstSeasonYear, isKeeper }));
  }
  return rows;
}

export function readYahooExport(text: string): ParsedYahooTransactions {
  return parseYahooTransactionsCsv(text);
}

export function buildResolver(blocks: ManagerSeasonBlock[], extraRecords: FranchiseNameRecord[] = []): FranchiseResolver {
  const records: FranchiseNameRecord[] = [
    ...blocks.filter((b) => b.seasonYear !== null).map((b) => ({ managerSheetName: b.managerSheetName, seasonYear: b.seasonYear, teamName: b.teamName })),
    ...extraRecords,
  ];
  return new FranchiseResolver(records, MANAGER_SHEETS);
}
