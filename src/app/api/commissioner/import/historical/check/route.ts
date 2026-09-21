import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireCommissioner } from "@/lib/current-manager";
import { worksheetToRows } from "@/lib/import/workbook-reader";
import { parseManagerSheetSeasonBlocks, resolveTeamSeasonRecords } from "@/lib/import/team-season-history";
import { parsePropBetRows } from "@/lib/import/prop-bets";
import { parseTradeRows } from "@/lib/import/trades";
import { parseDraftDayHistorySheet } from "@/lib/import/draft-day-history";
import { parseFypdRawSection } from "@/lib/import/fypd-history";
import type { ParsedTeamSeasonBlock } from "@/lib/import/types";

/**
 * The 12 current managers' sheet names, and the two confirmed FYPD table
 * years - see src/lib/import/known-league-history.ts for how the former
 * gets corrected against pre-2021 handoffs, and the project notes for how
 * the latter was confirmed (real MLB draftees identifiable by name in
 * each table - Kilby in the cols A-D table is a 2025 draftee, Waldschmidt
 * in the cols R-Y table is a 2024 draftee).
 */
const MANAGER_SHEETS = ["Aaron", "Andrew", "Ed", "Hugo", "Jorge", "Kurt", "MattyJ", "Michael", "Neel", "Scott", "Tyler", "Zach"];
const FYPD_TABLE_1_YEAR = 2025; // cols A-D
const FYPD_TABLE_2_YEAR = 2024; // cols R-Y

/**
 * Preview-only: reads the uploaded workbook and runs it through every
 * parser in src/lib/import, but writes nothing to the database. See
 * /api/commissioner/import/historical/commit for the write step, which
 * only ever runs after a commissioner has reviewed this output.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as ArrayBuffer);
  } catch {
    return NextResponse.json({ error: "Could not read this file as an .xlsx workbook." }, { status: 400 });
  }

  const rawTeamSeasons: ParsedTeamSeasonBlock[] = [];
  for (const name of MANAGER_SHEETS) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    const headerRow = worksheetToRows(ws, 2, ws.columnCount)[1] ?? [];
    const labels = headerRow.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    rawTeamSeasons.push(...parseManagerSheetSeasonBlocks(name, labels));
  }
  const teamSeasons = resolveTeamSeasonRecords(rawTeamSeasons);

  const propBetsWs = wb.getWorksheet("Season prop bets");
  const propBets = propBetsWs ? parsePropBetRows(worksheetToRows(propBetsWs).slice(1)) : [];

  const tradesWs = wb.getWorksheet("Off Season Trades");
  const trades = tradesWs ? parseTradeRows(worksheetToRows(tradesWs).slice(1)) : [];

  const draftDayEvents = wb.worksheets
    .filter((ws) => /^Draft Weekend \d{4}$/.test(ws.name))
    .map((ws) => parseDraftDayHistorySheet(ws.name, worksheetToRows(ws)));

  const fypdSections = [];
  const fypdWs = wb.getWorksheet("FYPD");
  if (fypdWs) {
    // Row 1 is blank/title, row 2 is the header ("Pick"/"Team"/"Player" etc)
    // for both side-by-side tables - skip both before parsing pick rows.
    const rows = worksheetToRows(fypdWs).slice(2);
    fypdSections.push(
      parseFypdRawSection("FYPD", "Table 1 (cols A-D)", rows, { pick: 0, team: 1, player: 2 }, FYPD_TABLE_1_YEAR)
    );
    fypdSections.push(
      parseFypdRawSection(
        "FYPD",
        "Table 2 (cols R-Y)",
        rows,
        { pick: 17, team: 18, player: 19, position: 22 },
        FYPD_TABLE_2_YEAR
      )
    );
  }

  const summary = {
    totalTeamSeasons: teamSeasons.length,
    uniqueManagers: new Set(teamSeasons.map((r) => r.resolvedManagerName)).size,
    confirmedHandoff: teamSeasons.filter((r) => r.attribution === "confirmed_handoff").length,
    confirmedOriginal: teamSeasons.filter((r) => r.attribution === "confirmed_original").length,
    inferredContinuous: teamSeasons.filter((r) => r.attribution === "inferred_continuous").length,
    unattributed: teamSeasons.filter((r) => r.attribution === "unattributed").length,
    totalPropBets: propBets.length,
    unattributedPropBets: propBets.filter((b) => b.seasonYear === null).length,
    totalTrades: trades.length,
    unattributedTrades: trades.filter((t) => t.seasonYear === null).length,
    totalFypdPicks: fypdSections.reduce((sum, s) => sum + s.picks.length, 0),
  };

  return NextResponse.json({ teamSeasons, propBets, trades, draftDayEvents, fypdSections, summary });
}
