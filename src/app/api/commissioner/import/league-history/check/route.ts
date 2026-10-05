import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCommissioner } from "@/lib/current-manager";
import { CURRENT_SEASON_YEAR, LEAGUE_FIRST_SEASON_YEAR } from "@/lib/config";
import { buildLeagueHistory } from "@/lib/import/league-history-builder";
import { buildResolver, loadWorkbook, readAuctionWorkbook, readMasterWorkbook, readYahooExport, MANAGER_SHEETS } from "@/lib/import/league-history-sources";

export const maxDuration = 120;

/**
 * Preview-only: parses the master workbook, the canonical auction file and
 * the Yahoo transaction export, builds the per-player event history, runs
 * the keeper engine over it and reports every disagreement with the
 * workbook's recorded costs. Writes nothing - see ../commit.
 */
export async function POST(req: Request) {
  if (!(await requireCommissioner())) {
    return NextResponse.json({ error: "Commissioner access required" }, { status: 403 });
  }

  const formData = await req.formData();
  const workbookFile = formData.get("workbook");
  const auctionFile = formData.get("auction");
  const yahooFile = formData.get("yahoo");
  if (!(workbookFile instanceof File) || !(auctionFile instanceof File) || !(yahooFile instanceof File)) {
    return NextResponse.json({ error: "All three files are required: the master workbook, the auction history, and the Yahoo transaction export." }, { status: 400 });
  }

  let master, auction;
  try {
    master = readMasterWorkbook(await loadWorkbook(Buffer.from(await workbookFile.arrayBuffer())));
  } catch {
    return NextResponse.json({ error: "Could not read the master workbook as an .xlsx file." }, { status: 400 });
  }
  if (master.sheetsFound.length === 0) {
    return NextResponse.json({ error: `The master workbook has none of the manager sheets (${MANAGER_SHEETS.join(", ")}).` }, { status: 400 });
  }
  try {
    auction = readAuctionWorkbook(await loadWorkbook(Buffer.from(await auctionFile.arrayBuffer())), LEAGUE_FIRST_SEASON_YEAR);
  } catch {
    return NextResponse.json({ error: "Could not read the auction history as an .xlsx file." }, { status: 400 });
  }
  if (auction.length === 0) {
    return NextResponse.json({ error: "The auction history workbook has no rows with Season / Player / Salary / Fantasy_Team columns." }, { status: 400 });
  }
  const yahoo = readYahooExport(await yahooFile.text());
  if (yahoo.transactions.length === 0) {
    return NextResponse.json({ error: `The Yahoo export has no transactions. ${yahoo.flags[0] ?? ""}`.trim() }, { status: 400 });
  }

  const league = await prisma.league.findFirst();
  const dbRecords = league
    ? (await prisma.teamSeasonRecord.findMany({ where: { team: { leagueId: league.id } }, include: { team: { include: { manager: true } } } })).map((r) => ({
        managerSheetName: r.team.manager.name,
        seasonYear: r.seasonYear,
        teamName: r.teamName,
      }))
    : [];
  const resolver = buildResolver(master.blocks, dbRecords);

  const preview = buildLeagueHistory({
    blocks: master.blocks,
    auctionRows: auction,
    yahoo: yahoo.transactions,
    offseasonTrades: master.offseasonTrades,
    prospectNames: master.prospectNames,
    resolver,
    firstSeason: LEAGUE_FIRST_SEASON_YEAR,
    currentSeason: league?.currentSeasonYear ?? CURRENT_SEASON_YEAR,
  });

  const existingTeams = league ? await prisma.manager.findMany({ where: { leagueId: league.id, name: { in: MANAGER_SHEETS } }, select: { name: true } }) : [];

  return NextResponse.json({
    ...preview,
    sources: {
      managerSheets: master.sheetsFound,
      auctionRows: auction.length,
      yahooTransactions: yahoo.transactions.length,
      yahooFlags: yahoo.flags,
      franchisesWithTeams: existingTeams.map((m) => m.name),
    },
  });
}
