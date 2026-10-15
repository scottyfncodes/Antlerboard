/**
 * Builds the league-history import's auction-history workbook
 * (Auctions_AllSeasons + Keepers_AllSeasons) from Yahoo's draft results and
 * the commissioner's master workbook, for when the original auction file
 * isn't available.
 *
 * Yahoo's draft results list every player each team took at the auction,
 * kept players included, with the price, but carry no keeper marker. A
 * pick is a keeper here only when it matches that franchise's keeper list
 * for the season in the master workbook. Everything else is an auction buy.
 * So no Yahoo pick is ever written twice, and keepers are never counted as
 * auction purchases.
 *
 *   - Auction buys: Yahoo's player, price and order. Picks are numbered
 *     1..N in Yahoo's order with the keepers left out; Yahoo's own overall
 *     pick is kept alongside (Yahoo_Pick).
 *   - Keepers: the workbook's recorded keeper cost (the league's ladder,
 *     commissioner overrides included). Yahoo's price for the same pick
 *     is kept alongside (Yahoo_Salary), and any difference is reported.
 *   - Fantasy_Team is the workbook's own team name for that franchise and
 *     season, so the importer resolves it exactly.
 *
 * Every disagreement between the two sources is reported, never settled
 * quietly. A workbook player listed as both a keeper and an auction buy,
 * when Yahoo has only one pick for him, blocks the output until the
 * commissioner decides which it was (`decisions`). Nothing here reads or
 * writes the database.
 */

import ExcelJS from "exceljs";
import { parseCsv } from "../csv/parse";
import { matchPlayerName, normalizePlayerName } from "./player-names";
import type { FranchiseResolver } from "./team-aliases";
import type { ManagerSeasonBlock } from "./league-history-types";

export interface YahooDraftPick {
  seasonYear: number;
  pick: number;
  round: number | null;
  playerName: string;
  /** Yahoo's player_id - the same id across seasons and in the transaction log. */
  playerId: string | null;
  playerKey: string | null;
  mlbTeam: string | null;
  positions: string[];
  cost: number | null;
  teamKey: string | null;
  teamName: string;
  /** The source's own keeper flag, when it has one (the league's pasted auction history does). */
  sourceKeeper?: boolean | null;
  line: number;
}

/** The history export's draft CSV undoes its spreadsheet-formula guard ("'=..." -> "=..."). */
const unguard = (s: string) => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s);

export function parseYahooDraftCsv(text: string): { picks: YahooDraftPick[]; flags: string[] } {
  const rows = parseCsv(text);
  const flags: string[] = [];
  if (rows.length === 0) return { picks: [], flags: ["Empty file."] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const c = {
    season: col("season"),
    pick: col("pick"),
    round: col("round"),
    player: col("player"),
    playerId: col("player_id"),
    playerKey: col("player_key"),
    mlbTeam: col("mlb_team"),
    positions: col("positions"),
    salary: col("salary"),
    teamKey: col("team_key"),
    team: col("fantasy_team"),
    isKeeper: col("iskeeper"),
  };
  if (c.season === -1 || c.pick === -1 || c.player === -1 || c.salary === -1 || c.team === -1) {
    return { picks: [], flags: ["Expected the history export's draft CSV (Season, Pick, Player, Salary, Fantasy_Team ...)."] };
  }
  const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const picks: YahooDraftPick[] = [];
  rows.slice(1).forEach((r, i) => {
    if (r.every((v) => v.trim() === "")) return;
    const seasonYear = num(r[c.season]);
    const pick = num(r[c.pick]);
    if (seasonYear === null || pick === null) {
      flags.push(`Line ${i + 2}: no season or pick number - skipped.`);
      return;
    }
    picks.push({
      seasonYear,
      pick,
      round: c.round === -1 ? null : num(r[c.round]),
      playerName: unguard(r[c.player] ?? "").trim(),
      playerId: c.playerId === -1 ? null : r[c.playerId] || null,
      playerKey: c.playerKey === -1 ? null : r[c.playerKey] || null,
      mlbTeam: c.mlbTeam === -1 ? null : r[c.mlbTeam] || null,
      positions: c.positions === -1 ? [] : (r[c.positions] ?? "").split("/").map((p) => p.trim()).filter(Boolean),
      cost: num(r[c.salary]),
      teamKey: c.teamKey === -1 ? null : r[c.teamKey] || null,
      teamName: unguard(r[c.team] ?? "").trim(),
      sourceKeeper: c.isKeeper === -1 || (r[c.isKeeper] ?? "").trim() === "" ? null : num(r[c.isKeeper]) !== 0,
      line: i + 2,
    });
  });
  return { picks, flags };
}

/** The commissioner's ruling on a player the workbook lists as both a keeper and an auction buy. */
export interface DuplicateDecision {
  season: number;
  /** Manager sheet name, e.g. "Andrew". */
  franchise: string;
  player: string;
  /** "keeper": the auction-buy row is the duplicate. "auction": the keeper-list entry is. */
  was: "keeper" | "auction";
  /** Who approved it and when, for the record. */
  approvedBy: string;
}

export interface GeneratedRow {
  season: number;
  pick: number;
  player: string;
  mlbTeam: string | null;
  positions: string[];
  salary: number | null;
  fantasyTeam: string;
  franchise: string;
  yahooPick: number;
  yahooSalary: number | null;
  yahooPlayerId: string | null;
  yahooPlayerKey: string | null;
  /** How the row was classified, in words. */
  source: string;
}

export interface Issue {
  season: number;
  franchise: string | null;
  /** blocking: no files are produced until it's resolved. review: listed for the commissioner. */
  severity: "blocking" | "review";
  kind:
    | "unresolved-team"
    | "team-mapping"
    | "unpriced-pick"
    | "keeper-not-in-yahoo"
    | "keeper-and-auction"
    | "keeper-cost-differs"
    | "auction-cost-differs"
    | "workbook-buy-not-in-yahoo"
    | "yahoo-buy-not-in-workbook"
    | "name-differs"
    | "keeper-flag-differs"
    | "missing-season";
  message: string;
}

export interface SeasonReconciliation {
  season: number;
  yahooPicks: number;
  keepers: number;
  auctionBuys: number;
  workbookKeepers: number;
  workbookAuctionRows: number;
  /** Workbook rows the commissioner ruled duplicates (see DuplicateDecision). */
  approvedDuplicates: number;
  yahooTotalSalary: number;
  keeperSalary: number;
  auctionSalary: number;
  /** Every Yahoo pick written exactly once, and keepers = the workbook's keeper list (after approved decisions). */
  reconciled: boolean;
}

export interface GeneratedAuctionHistory {
  auctions: GeneratedRow[];
  keepers: GeneratedRow[];
  seasons: SeasonReconciliation[];
  issues: Issue[];
  /** No blocking issues: the workbook can be written. */
  ok: boolean;
}

export interface GenerateOptions {
  picks: YahooDraftPick[];
  blocks: ManagerSeasonBlock[];
  resolver: FranchiseResolver;
  seasons: number[];
  decisions?: DuplicateDecision[];
}

/**
 * The same player? Full names must agree in full; an initial-only name
 * ("C.Keith") may match by initial and surname. So "Jhoan Duran" is never
 * "Jarren Duran", and a two-way player's halves stay apart.
 */
function sameName(a: string, b: string): boolean {
  const x = normalizePlayerName(a);
  const y = normalizePlayerName(b);
  if (x.twoWayMarker !== y.twoWayMarker && x.twoWayMarker !== null && y.twoWayMarker !== null) return false;
  return x.abbreviated || y.abbreviated ? x.initialKey === y.initialKey : x.fullKey === y.fullKey;
}

/**
 * The workbook row's pick among this team's picks. A name the workbook
 * abbreviates can fit two picks ("A. Nola": Aaron and Austin, same team,
 * 2021), so a pick at the row's own price is tried first - by exact or
 * initial name only - before the whole list (typo tolerance included).
 */
function matchPick(name: string, cost: number | null, picks: YahooDraftPick[]): YahooDraftPick | null {
  const atPrice = picks.filter((p) => cost !== null && p.cost === cost);
  const m = matchPlayerName(name, atPrice.map((p) => ({ name: p.playerName, value: p })));
  if (m && m.confidence !== "fuzzy") return m.value;
  const any = matchPlayerName(name, picks.map((p) => ({ name: p.playerName, value: p })));
  if (any) return any.value;
  // A multi-word surname written as one ("E.DeLaCruz" = Elly De La Cruz):
  // same first initial, same surname with the spaces taken out.
  const surname = (n: string) => {
    const t = normalizePlayerName(n).fullKey.split(" ");
    return { initial: t[0]?.charAt(0) ?? "", rest: t.slice(1).join("").replace(/-/g, "") };
  };
  const want = surname(name);
  const joined = picks.filter((p) => {
    const got = surname(p.playerName);
    return want.rest.length >= 5 && got.initial === want.initial && got.rest === want.rest;
  });
  return joined.length === 1 ? joined[0] : null;
}

export function generateAuctionHistory(opts: GenerateOptions): GeneratedAuctionHistory {
  const issues: Issue[] = [];
  const auctions: GeneratedRow[] = [];
  const keepers: GeneratedRow[] = [];
  const seasons: SeasonReconciliation[] = [];
  const decisions = opts.decisions ?? [];

  for (const season of opts.seasons) {
    const picks = opts.picks.filter((p) => p.seasonYear === season).sort((a, b) => a.pick - b.pick);
    const blocks = opts.blocks.filter((b) => b.seasonYear === season);
    const issue = (franchise: string | null, severity: Issue["severity"], kind: Issue["kind"], message: string) =>
      issues.push({ season, franchise, severity, kind, message });
    if (picks.length === 0) {
      issue(null, "blocking", "missing-season", `${season}: no Yahoo draft results in the file.`);
      continue;
    }

    // Yahoo team -> franchise, which must be one-to-one.
    const franchiseOfTeam = new Map<string, string>();
    for (const name of new Set(picks.map((p) => p.teamName))) {
      const r = opts.resolver.resolve(name);
      if (!r) issue(null, "blocking", "unresolved-team", `${season}: Yahoo team "${name}" doesn't match any franchise.`);
      else franchiseOfTeam.set(name, r.managerSheetName);
    }
    const owners = new Map<string, string[]>();
    for (const [team, f] of franchiseOfTeam) owners.set(f, [...(owners.get(f) ?? []), team]);
    for (const [f, teams] of owners) {
      // Yahoo's draft page truncates long names, and not always at the same
      // length ("Cron & Cronenwort..." / "Cron & Cronenworth..."): one team.
      const stem = (t: string) => t.replace(/\s*(\.\.\.|…)$/, "");
      const sameTeam = teams.every((t) => teams.every((u) => stem(t).startsWith(stem(u)) || stem(u).startsWith(stem(t))));
      if (teams.length > 1 && !sameTeam) issue(f, "blocking", "team-mapping", `${season}: Yahoo teams ${teams.map((t) => `"${t}"`).join(" and ")} both resolve to ${f}.`);
    }
    for (const p of picks) if (p.cost === null) issue(franchiseOfTeam.get(p.teamName) ?? null, "blocking", "unpriced-pick", `${season} pick ${p.pick} (${p.playerName}) has no price in Yahoo.`);

    const rec: SeasonReconciliation = {
      season,
      yahooPicks: picks.length,
      keepers: 0,
      auctionBuys: 0,
      workbookKeepers: blocks.reduce((s, b) => s + b.keepers.length, 0),
      workbookAuctionRows: blocks.reduce((s, b) => s + b.draft.length, 0),
      approvedDuplicates: 0,
      yahooTotalSalary: picks.reduce((s, p) => s + (p.cost ?? 0), 0),
      keeperSalary: 0,
      auctionSalary: 0,
      reconciled: false,
    };
    let expectedKeepers = rec.workbookKeepers;
    const written = new Set<YahooDraftPick>();

    for (const block of blocks) {
      const f = block.managerSheetName;
      const own = picks.filter((p) => franchiseOfTeam.get(p.teamName) === f);
      const keeperOf = new Map<YahooDraftPick, { name: string; cost: number | null }>();
      const buyOf = new Map<YahooDraftPick, { name: string; cost: number | null }>();
      const free = () => own.filter((p) => !keeperOf.has(p) && !buyOf.has(p));

      for (const k of block.keepers) {
        const m = matchPick(k.name, k.cost, free());
        if (m) keeperOf.set(m, k);
        else issue(f, "blocking", "keeper-not-in-yahoo", `${season} ${f}: keeper "${k.name}" ($${k.cost ?? "?"}) has no matching pick in Yahoo's draft results.`);
      }

      const extraBuyRows: { name: string; cost: number | null }[] = [];
      for (const d of block.draft) {
        const m = matchPick(d.name, d.cost, free());
        if (m) {
          buyOf.set(m, d);
          continue;
        }
        // Not among the remaining picks. Already taken as one of this team's keepers?
        const asKeeper = [...keeperOf.keys()].find((p) => sameName(d.name, p.playerName));
        if (!asKeeper) {
          extraBuyRows.push(d);
          continue;
        }
        const decision = decisions.find((x) => x.season === season && x.franchise === f && sameName(x.player, asKeeper.playerName));
        const evidence = `Yahoo has one ${season} pick for ${asKeeper.playerName} (pick ${asKeeper.pick}, $${asKeeper.cost ?? "?"}, ${asKeeper.teamName}); the workbook lists him as keeper "${keeperOf.get(asKeeper)!.name}" ($${keeperOf.get(asKeeper)!.cost ?? "?"}) and as auction buy "${d.name}" ($${d.cost ?? "?"}).`;
        if (!decision) {
          issue(f, "blocking", "keeper-and-auction", `${season} ${f}: ${evidence} Needs the commissioner's decision: keeper or auction buy.`);
          continue;
        }
        rec.approvedDuplicates++;
        if (decision.was === "auction") {
          // The keeper-list entry was the mistake: the pick is an auction buy.
          keeperOf.delete(asKeeper);
          buyOf.set(asKeeper, d);
          expectedKeepers--;
        }
      }

      for (const [p, k] of keeperOf) {
        written.add(p);
        const decided = decisions.some((x) => x.season === season && x.franchise === f && x.was === "keeper" && sameName(x.player, p.playerName));
        keepers.push(row(p, block, k.cost ?? p.cost, decided ? "Keeper (workbook keeper list; duplicate auction row ruled out by the commissioner)" : "Keeper (workbook keeper list)"));
        if (k.cost === null) issue(f, "review", "keeper-cost-differs", `${season} ${f}: keeper ${p.playerName} has no recorded cost in the workbook; Yahoo's $${p.cost} is used.`);
        else if (p.cost !== null && p.cost !== k.cost)
          issue(f, "review", "keeper-cost-differs", `${season} ${f}: keeper ${p.playerName} - workbook $${k.cost}, Yahoo $${p.cost}. The workbook's cost is used.`);
      }
      for (const [p, d] of buyOf) {
        written.add(p);
        if (d.cost !== null && p.cost !== null && d.cost !== p.cost)
          issue(f, "review", "auction-cost-differs", `${season} ${f}: auction buy ${p.playerName} - Yahoo $${p.cost}, workbook $${d.cost}. Yahoo's price is used.`);
      }
      // One unmatched row on each side at the same price: almost always the
      // same player spelled differently ("T.Stroy" / Trevor Story). Said as a pair.
      const unmatchedPicks = free();
      const paired = new Set<YahooDraftPick>();
      for (const d of extraBuyRows) {
        const samePrice = unmatchedPicks.filter((p) => !paired.has(p) && d.cost !== null && p.cost === d.cost);
        const rowsAtPrice = extraBuyRows.filter((x) => x.cost === d.cost);
        if (samePrice.length === 1 && rowsAtPrice.length === 1) {
          paired.add(samePrice[0]);
          issue(f, "review", "name-differs", `${season} ${f}: workbook "${d.name}" and Yahoo pick ${samePrice[0].pick} ${samePrice[0].playerName}, both $${d.cost} - probably one player spelled differently. Written as Yahoo's ${samePrice[0].playerName}.`);
        } else {
          issue(f, "review", "workbook-buy-not-in-yahoo", `${season} ${f}: workbook auction row "${d.name}" ($${d.cost ?? "?"}) has no matching Yahoo pick. Not written.`);
        }
      }
      for (const p of unmatchedPicks) {
        written.add(p);
        if (!paired.has(p)) issue(f, "review", "yahoo-buy-not-in-workbook", `${season} ${f}: Yahoo pick ${p.pick} ${p.playerName} ($${p.cost ?? "?"}) isn't in the workbook's auction list. Written as an auction buy.`);
      }
    }

    // Auction buys in Yahoo's order, numbered without the keepers.
    const seasonBuys = picks.filter((p) => written.has(p) && !keepers.some((k) => k.season === season && k.yahooPick === p.pick));
    seasonBuys.forEach((p, i) => {
      const block = blocks.find((b) => b.managerSheetName === franchiseOfTeam.get(p.teamName))!;
      auctions.push({ ...row(p, block, p.cost, "Auction buy (Yahoo draft results)"), pick: i + 1 });
    });

    // Cross-check against the source's own keeper flags where they're usable
    // (some seasons flag every pick, or none - those say nothing).
    const flagged = picks.filter((p) => p.sourceKeeper === true).length;
    const flaggable = picks.every((p) => p.sourceKeeper !== undefined && p.sourceKeeper !== null) && flagged > 0 && flagged < picks.length;
    if (flaggable) {
      const keptPicks = new Set(keepers.filter((k) => k.season === season).map((k) => k.yahooPick));
      for (const p of picks) {
        if (!written.has(p) || p.sourceKeeper === keptPicks.has(p.pick)) continue;
        issue(franchiseOfTeam.get(p.teamName) ?? null, "review", "keeper-flag-differs", `${season}: pick ${p.pick} ${p.playerName} (${p.teamName}) is ${keptPicks.has(p.pick) ? "a keeper on the workbook's list" : "an auction buy by the workbook"} but the source file marks it ${p.sourceKeeper ? "a keeper" : "an auction buy"}.`);
      }
    }

    rec.keepers = keepers.filter((k) => k.season === season).length;
    rec.auctionBuys = seasonBuys.length;
    rec.keeperSalary = keepers.filter((k) => k.season === season).reduce((s, k) => s + (k.salary ?? 0), 0);
    rec.auctionSalary = seasonBuys.reduce((s, p) => s + (p.cost ?? 0), 0);
    const unwritten = picks.filter((p) => !written.has(p));
    for (const p of unwritten) {
      if (franchiseOfTeam.has(p.teamName)) issue(franchiseOfTeam.get(p.teamName)!, "blocking", "team-mapping", `${season} pick ${p.pick} ${p.playerName}: its team has no workbook block this season.`);
    }
    rec.reconciled =
      unwritten.length === 0 &&
      rec.keepers + rec.auctionBuys === rec.yahooPicks &&
      rec.keepers === expectedKeepers &&
      !issues.some((i) => i.season === season && i.severity === "blocking");
    seasons.push(rec);
  }

  return { auctions, keepers, seasons, issues, ok: !issues.some((i) => i.severity === "blocking") };
}

function row(p: YahooDraftPick, block: ManagerSeasonBlock, salary: number | null, source: string): GeneratedRow {
  return {
    season: p.seasonYear,
    pick: p.pick,
    player: p.playerName,
    mlbTeam: p.mlbTeam,
    positions: p.positions,
    salary,
    fantasyTeam: block.teamName,
    franchise: block.managerSheetName,
    yahooPick: p.pick,
    yahooSalary: p.cost,
    yahooPlayerId: p.playerId,
    yahooPlayerKey: p.playerKey,
    source,
  };
}

const HEADER = ["Season", "Pick", "Player", "MLB_Team", "Pos", "Salary", "Fantasy_Team", "Yahoo_Pick", "Yahoo_Salary", "Yahoo_Player_ID", "Yahoo_Player_Key", "Source"];

/** The importer's auction-history workbook, plus a README sheet (skipped by the importer) with the reconciliation. */
export async function auctionHistoryWorkbook(g: GeneratedAuctionHistory, provenance: string[]): Promise<Buffer> {
  if (!g.ok) throw new Error("Refusing to write the auction history while blocking issues remain.");
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, rows: GeneratedRow[]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(HEADER);
    for (const r of rows) {
      ws.addRow([r.season, r.pick, r.player, r.mlbTeam ?? "", r.positions.join("/"), r.salary, r.fantasyTeam, r.yahooPick, r.yahooSalary, r.yahooPlayerId ?? "", r.yahooPlayerKey ?? "", r.source]);
    }
  };
  sheet("Auctions_AllSeasons", g.auctions);
  sheet("Keepers_AllSeasons", g.keepers);
  const readme = wb.addWorksheet("README");
  for (const line of provenance) readme.addRow([line]);
  readme.addRow([]);
  readme.addRow(["Season", "Yahoo picks", "Keepers", "Auction buys", "Workbook keepers", "Workbook auction rows", "Approved duplicates", "Yahoo total $", "Keeper $", "Auction $", "Reconciled"]);
  for (const s of g.seasons) {
    readme.addRow([s.season, s.yahooPicks, s.keepers, s.auctionBuys, s.workbookKeepers, s.workbookAuctionRows, s.approvedDuplicates, s.yahooTotalSalary, s.keeperSalary, s.auctionSalary, s.reconciled ? "yes" : "NO"]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
