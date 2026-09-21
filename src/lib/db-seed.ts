/**
 * Antlerboard demo seed data.
 *
 * Builds a full fictional Claw & Antler League season history (2020-2028)
 * that exercises every scenario called out in the project spec: a year-1
 * keeper, a year-4 keeper, a year-5 keeper, a forced redraft, a dropped
 * player, a reacquired waiver player, every player tag, an accepted trade
 * and a live proposal, an Open to Discuss flow, DPUD bets in every status,
 * a browsable draft history, the full 2020-2028 draft-color cycle
 * (including the 2027 skip), and a mix of read/unread notifications.
 *
 * Safe to re-run: it wipes and rebuilds all C&A data in dependency order.
 *
 * Exported as `runSeed()` so it can be invoked both from the CLI
 * (`prisma/seed.ts`, for local dev) and from the protected
 * `/api/admin/seed` route (for databases - like a freshly connected
 * Vercel Postgres/Neon store - that this process can only ever reach from
 * inside a real Vercel build or deployment, never from an external
 * script, because the platform only exposes their credentials there).
 */

import type { AcquisitionMethod, PlayerTagType, DraftColor, TransactionType } from "@prisma/client";
import { prisma } from "./db";
import { getDraftColor } from "./draft-color-engine";
import { recomputeAllKeeperRecords } from "./keeper-sync";
import {
  LEAGUE_NAME,
  LEAGUE_ABBREVIATION,
  KEEPER_SLOT_COUNT,
  DEFAULT_TEAM_COUNT,
  CURRENT_SEASON_YEAR,
} from "./config";

const MLB_TEAMS = [
  "NYY", "BOS", "LAD", "SF", "HOU", "ATL", "NYM", "PHI", "SD", "TB",
  "TOR", "SEA", "TEX", "CHC", "STL", "MIL", "MIN", "CLE", "BAL", "DET",
  "KC", "CWS", "OAK", "LAA", "ARI", "COL", "MIA", "WSH", "PIT", "CIN",
];

const POSITIONS_POOL = ["C", "1B", "2B", "3B", "SS", "OF", "OF", "SP", "SP", "RP"];

const FILLER_FIRST_NAMES = [
  "Marcus", "Jalen", "Trey", "Casey", "Devon", "Wyatt", "Miles", "Cole",
  "Nate", "Reggie", "Silas", "Dalton", "Emmett", "Grady", "Hunter",
  "Isaiah", "Jackson", "Kendrick", "Landon", "Malik", "Nolan", "Orion",
  "Preston", "Quincy", "Rhett", "Spencer", "Tobias", "Vaughn", "Weston", "Xavier",
];
const FILLER_LAST_NAMES = [
  "Alvarado", "Beckham", "Castellanos", "Dorsey", "Ellison", "Fairbanks",
  "Garrity", "Holloway", "Ibarra", "Jennings", "Kowalski", "Lindgren",
  "Mercer", "Norwood", "Osei", "Pemberton", "Quintana", "Rourke",
  "Sandoval", "Thistlewood", "Underhill", "Vantrease", "Whitfield",
  "Yardley", "Zabinski",
];

function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(pool: T[], seed: number): T {
  return pool[seed % pool.length];
}

async function wipe() {
  const tables = [
    "AuditLogEntry",
    "SyncLog",
    "YahooConnection",
    "PushSubscription",
    "NotificationPreference",
    "Notification",
    "DpudParticipant",
    "DpudBetPlayer",
    "DpudBet",
    "Offer",
    "TradeAsset",
    "Trade",
    "PlayerTag",
    "TransactionTeam",
    "TransactionPlayer",
    "Transaction",
    "KeeperRecord",
    "TeamStanding",
    "DraftPick",
    "Acquisition",
    "Player",
    "Team",
    "Manager",
    "Season",
    "LeagueSettings",
    "League",
  ];
  const client = prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>;
  for (const t of tables) {
    await client[t.charAt(0).toLowerCase() + t.slice(1)].deleteMany();
  }
}

export async function runSeed(): Promise<void> {
  let fillerNameCursor = 0;
  function nextFillerName(): string {
    const first = FILLER_FIRST_NAMES[fillerNameCursor % FILLER_FIRST_NAMES.length];
    const last =
      FILLER_LAST_NAMES[
        Math.floor(fillerNameCursor / FILLER_FIRST_NAMES.length) % FILLER_LAST_NAMES.length
      ];
    fillerNameCursor++;
    return `${first} ${last}`;
  }

  console.log("Wiping existing data...");
  await wipe();

  console.log("Creating league + settings...");
  const league = await prisma.league.create({
    data: {
      name: LEAGUE_NAME,
      abbreviation: LEAGUE_ABBREVIATION,
      currentSeasonYear: CURRENT_SEASON_YEAR,
      settings: {
        create: {
          keeperSlotCount: KEEPER_SLOT_COUNT,
          maxConsecutiveKeeperYears: 5,
          keeperCostIncrementPerYear: 1,
          teamCount: DEFAULT_TEAM_COUNT,
        },
      },
    },
  });

  console.log("Creating seasons 2020-2028 with draft colors...");
  const seasonYears = Array.from({ length: 9 }, (_, i) => 2020 + i); // 2020..2028
  const seasonByYear = new Map<number, { id: string; year: number }>();
  for (const year of seasonYears) {
    const colorResult = getDraftColor(year);
    const season = await prisma.season.create({
      data: {
        leagueId: league.id,
        year,
        draftColor: colorResult.skipped ? null : (colorResult.color as DraftColor),
        colorSkipped: colorResult.skipped,
        colorOverridden: colorResult.overridden,
        status:
          year < CURRENT_SEASON_YEAR
            ? "COMPLETE"
            : year === CURRENT_SEASON_YEAR
              ? "IN_PROGRESS"
              : "UPCOMING",
        notes: colorResult.skipped
          ? "Draft color cycle paused this season - does not advance the 5-color sequence."
          : undefined,
        keeperDeadline: year === 2026 ? new Date("2027-02-15") : year === 2027 ? new Date("2028-02-15") : undefined,
        draftDate: year === 2026 ? new Date("2027-03-01") : year === 2027 ? new Date("2028-03-01") : undefined,
      },
    });
    seasonByYear.set(year, season);
  }

  console.log("Creating managers + teams...");
  const managerDefs = [
    { name: "Scott Lawrence", email: "scottlawrence325@gmail.com", isCommissioner: true, team: "Antler Avengers" },
    { name: "Maria Chen", team: "Rack Attack" },
    { name: "Diego Ramirez", team: "Velvet Horns" },
    { name: "Sam O'Brien", team: "The Rutting Season" },
    { name: "Priya Patel", team: "Bone Yard Bombers" },
    { name: "Chris Lee", team: "Twelve-Point Turnaround" },
    { name: "Alex Kim", team: "Shed Hunters" },
    { name: "Jordan Taylor", team: "Buck Wild" },
    { name: "Morgan Davis", team: "Antler Alliance" },
    { name: "Riley Nguyen", team: "The Whitetails" },
  ];

  const teamsByName = new Map<string, { id: string; managerId: string }>();
  for (const def of managerDefs) {
    const manager = await prisma.manager.create({
      data: {
        leagueId: league.id,
        name: def.name,
        email: def.email,
        isCommissioner: !!def.isCommissioner,
      },
    });
    const team = await prisma.team.create({
      data: {
        leagueId: league.id,
        name: def.team,
        managerId: manager.id,
      },
    });
    teamsByName.set(def.team, { id: team.id, managerId: manager.id });
  }

  const teamNames = [...teamsByName.keys()];

  console.log("Recording past champions...");
  const championsByYear: Record<number, string> = {
    2020: "The Rutting Season",
    2021: "Rack Attack",
    2022: "Velvet Horns",
    2023: "Antler Alliance",
    2024: "The Whitetails",
    2025: "Antler Avengers",
  };
  for (const [year, teamName] of Object.entries(championsByYear)) {
    await prisma.season.update({
      where: { id: seasonByYear.get(Number(year))!.id },
      data: { championTeamId: teamsByName.get(teamName)!.id },
    });
  }

  // -------------------------------------------------------------------
  // Players: named "scenario" players + generated filler roster players
  // -------------------------------------------------------------------

  const playerIdByName = new Map<string, string>();
  const draftBoardEntries: { year: number; team: string; playerName: string; cost: number }[] = [];

  async function createPlayer(name: string, mlbTeam: string, positions: string[]) {
    const player = await prisma.player.create({
      data: { leagueId: league.id, name, mlbTeam, positions },
    });
    playerIdByName.set(name, player.id);
    return player;
  }

  async function addAcquisition(
    playerName: string,
    season: number,
    team: string,
    method: AcquisitionMethod,
    cost: number,
    opts?: { draftRound?: number; draftPick?: number }
  ) {
    const playerId = playerIdByName.get(playerName)!;
    const teamRow = teamsByName.get(team)!;
    const seasonRow = seasonByYear.get(season)!;
    await prisma.acquisition.create({
      data: {
        seasonId: seasonRow.id,
        seasonYear: season,
        playerId,
        teamId: teamRow.id,
        method,
        cost,
        draftRound: opts?.draftRound,
        draftPick: opts?.draftPick,
      },
    });

    const txType: TransactionType =
      method === "DRAFT" ? "DRAFT" : method === "WAIVER" ? "WAIVER_ADD" : method === "TRADE" ? "TRADE" : "FREE_AGENT_ADD";
    await prisma.transaction.create({
      data: {
        seasonId: seasonRow.id,
        seasonYear: season,
        type: txType,
        notes: `${playerName} ${method === "DRAFT" ? "drafted by" : method === "TRADE" ? "traded to" : "added by"} ${team}`,
        players: { create: [{ playerId }] },
        teams: { create: [{ teamId: teamRow.id, role: "TO" }] },
      },
    });

    if (method === "DRAFT") {
      draftBoardEntries.push({ year: season, team, playerName, cost });
    }
  }

  async function addDrop(playerName: string, season: number, team: string) {
    const playerId = playerIdByName.get(playerName)!;
    const teamRow = teamsByName.get(team)!;
    const seasonRow = seasonByYear.get(season)!;
    await prisma.transaction.create({
      data: {
        seasonId: seasonRow.id,
        seasonYear: season,
        type: "DROP",
        notes: `${playerName} dropped by ${team}`,
        players: { create: [{ playerId }] },
        teams: { create: [{ teamId: teamRow.id, role: "FROM" }] },
      },
    });
  }

  async function tagPlayer(playerName: string, team: string, tag: PlayerTagType, note?: string) {
    const playerId = playerIdByName.get(playerName)!;
    const teamRow = teamsByName.get(team)!;
    await prisma.playerTag.create({
      data: { playerId, teamId: teamRow.id, tag, note },
    });
  }

  console.log("Seeding scenario players...");

  // 1. Year-1 keeper - drafted 2025, this is their first keeper season (2026)
  await createPlayer("Bobby Witt Jr.", "KC", ["SS"]);
  await addAcquisition("Bobby Witt Jr.", 2025, "Antler Avengers", "DRAFT", 18);
  await tagPlayer("Bobby Witt Jr.", "Antler Avengers", "KEEPING");

  // 2. Year-4 keeper - drafted 2022, kept every year since
  await createPlayer("Julio Rodriguez", "SEA", ["OF"]);
  await addAcquisition("Julio Rodriguez", 2022, "Rack Attack", "DRAFT", 25);
  await tagPlayer("Julio Rodriguez", "Rack Attack", "KEEPING", "Locked in through year 5.");

  // 3. Year-5 keeper (max) - drafted 2021, this is the final eligible keeper year
  await createPlayer("Ronald Acuna Jr.", "ATL", ["OF"]);
  await addAcquisition("Ronald Acuna Jr.", 2021, "Velvet Horns", "DRAFT", 30);
  await tagPlayer("Ronald Acuna Jr.", "Velvet Horns", "NEEDS_DECISION", "Final keeper year - forced back into the 2027 draft after this.");

  // 4. Forced redraft - drafted 2020, kept 5 straight years (2021-2025), forced
  // back into the 2026 draft pool where a different team drafted him fresh.
  await createPlayer("Corey Seager", "TEX", ["SS"]);
  await addAcquisition("Corey Seager", 2020, "The Rutting Season", "DRAFT", 22);
  await addAcquisition("Corey Seager", 2026, "Bone Yard Bombers", "DRAFT", 15);
  await tagPlayer("Corey Seager", "Bone Yard Bombers", "RECENTLY_ACQUIRED", "Forced back into the draft after 5 straight keeper years with The Rutting Season.");

  // 5 & 6. Dropped, then reacquired off waivers - old tenure preserved as
  // history but does not affect the new keeper clock or cost.
  await createPlayer("Anthony Volpe", "NYY", ["SS"]);
  await addAcquisition("Anthony Volpe", 2023, "Shed Hunters", "DRAFT", 10);
  await addDrop("Anthony Volpe", 2025, "Shed Hunters");
  await addAcquisition("Anthony Volpe", 2025, "Buck Wild", "WAIVER", 3);
  await tagPlayer("Anthony Volpe", "Buck Wild", "RECENTLY_ACQUIRED", "Picked up off waivers after being dropped by Shed Hunters.");

  // 8. On the Table
  await createPlayer("Corbin Carroll", "ARI", ["OF"]);
  await addAcquisition("Corbin Carroll", 2024, "Twelve-Point Turnaround", "DRAFT", 20);
  await tagPlayer("Corbin Carroll", "Twelve-Point Turnaround", "ON_THE_TABLE", "Open to the right offer.");

  // 9. Open to Discuss
  await createPlayer("Gunnar Henderson", "BAL", ["SS", "3B"]);
  await addAcquisition("Gunnar Henderson", 2023, "Antler Alliance", "DRAFT", 16);
  await tagPlayer("Gunnar Henderson", "Antler Alliance", "OPEN_TO_DISCUSS", "Willing to talk - reach out.");

  // A couple more Available / plain keepers for market variety
  await createPlayer("Elly De La Cruz", "CIN", ["SS"]);
  await addAcquisition("Elly De La Cruz", 2024, "The Whitetails", "DRAFT", 19);
  await tagPlayer("Elly De La Cruz", "The Whitetails", "KEEPING");

  await createPlayer("Yordan Alvarez", "HOU", ["OF"]);
  await addAcquisition("Yordan Alvarez", 2022, "The Whitetails", "DRAFT", 27);
  await tagPlayer("Yordan Alvarez", "The Whitetails", "AVAILABLE", "Off my roster - up for grabs.");

  // -------------------------------------------------------------------
  // Fill each team's remaining keeper slots + a small bench with
  // procedurally generated players so rosters, position breakdowns, and
  // the draft board have realistic depth.
  // -------------------------------------------------------------------

  console.log("Generating filler roster players...");
  const namedPlayersByTeam = new Map<string, number>();
  for (const [, teamName] of [
    ["Bobby Witt Jr.", "Antler Avengers"],
    ["Julio Rodriguez", "Rack Attack"],
    ["Ronald Acuna Jr.", "Velvet Horns"],
    ["Corey Seager", "Bone Yard Bombers"],
    ["Anthony Volpe", "Buck Wild"],
    ["Corbin Carroll", "Twelve-Point Turnaround"],
    ["Gunnar Henderson", "Antler Alliance"],
    ["Elly De La Cruz", "The Whitetails"],
    ["Yordan Alvarez", "The Whitetails"],
  ] as const) {
    namedPlayersByTeam.set(teamName, (namedPlayersByTeam.get(teamName) ?? 0) + 1);
  }

  let seed = 42;
  for (const teamName of teamNames) {
    const existing = namedPlayersByTeam.get(teamName) ?? 0;
    const keeperSlotFillers = KEEPER_SLOT_COUNT - existing;
    const benchFillers = 4;
    const totalFillers = Math.max(0, keeperSlotFillers) + benchFillers;

    for (let i = 0; i < totalFillers; i++) {
      seed++;
      const name = nextFillerName();
      const mlbTeam = pick(MLB_TEAMS, seed);
      const positions = [pick(POSITIONS_POOL, seed), pick(POSITIONS_POOL, seed + 7)];
      await createPlayer(name, mlbTeam, [...new Set(positions)]);

      const isBench = i >= keeperSlotFillers;
      // Keeper-slot fillers spread across recent years so keeper years vary
      // realistically. Bench players are freshly acquired this season, so
      // they aren't yet counted as one of the team's 10 keepers.
      const acquireSeason = isBench ? 2026 : pick([2022, 2023, 2024, 2025, 2026], seed);
      const method: AcquisitionMethod = i % 5 === 0 ? "WAIVER" : i % 7 === 0 ? "FREE_AGENT" : "DRAFT";
      const cost = method === "DRAFT" ? 1 + (seed % 20) : 1 + (seed % 4);
      await addAcquisition(name, acquireSeason, teamName, method, cost);

      const tagRoll = seed % 6;
      const tag: PlayerTagType =
        tagRoll === 0
          ? "ON_THE_TABLE"
          : tagRoll === 1
            ? "OPEN_TO_DISCUSS"
            : tagRoll === 2
              ? "NEEDS_DECISION"
              : "KEEPING";
      await tagPlayer(name, teamName, tag);
    }
  }

  // -------------------------------------------------------------------
  // Draft board: build DraftPick rows from every DRAFT-method acquisition
  // recorded above, grouped by season, in a stable shuffled order so the
  // "board" reads like real auction nomination order rather than
  // alphabetical. C&A runs a live auction draft, not a snake draft -
  // round/pick/overallPick here are nomination sequence, not draft slots.
  // -------------------------------------------------------------------

  console.log("Building draft board...");
  const entriesByYear = new Map<number, typeof draftBoardEntries>();
  for (const entry of draftBoardEntries) {
    if (!entriesByYear.has(entry.year)) entriesByYear.set(entry.year, []);
    entriesByYear.get(entry.year)!.push(entry);
  }

  for (const [year, entries] of entriesByYear) {
    const seasonRow = seasonByYear.get(year)!;
    const ordered = shuffled(entries, year * 7 + 3);
    for (let i = 0; i < ordered.length; i++) {
      const overallPick = i + 1;
      const round = Math.floor(i / DEFAULT_TEAM_COUNT) + 1;
      const pickInRound = (i % DEFAULT_TEAM_COUNT) + 1;
      const entry = ordered[i];
      const teamRow = teamsByName.get(entry.team)!;
      const playerId = playerIdByName.get(entry.playerName)!;
      await prisma.draftPick.create({
        data: {
          seasonId: seasonRow.id,
          seasonYear: year,
          round,
          pick: pickInRound,
          overallPick,
          teamId: teamRow.id,
          playerId,
          cost: entry.cost,
          acquisitionType: "DRAFT",
        },
      });
    }
  }

  // -------------------------------------------------------------------
  // Trades + trade offers
  // -------------------------------------------------------------------

  console.log("Seeding trades and offers...");
  const rackAttack = teamsByName.get("Rack Attack")!;
  const velvetHorns = teamsByName.get("Velvet Horns")!;
  const antlerAvengers = teamsByName.get("Antler Avengers")!;
  const buckWild = teamsByName.get("Buck Wild")!;
  const whitetails = teamsByName.get("The Whitetails")!;
  const antlerAlliance = teamsByName.get("Antler Alliance")!;

  const historicalTrade = await prisma.trade.create({
    data: {
      seasonId: seasonByYear.get(2025)!.id,
      seasonYear: 2025,
      teamAId: rackAttack.id,
      teamBId: velvetHorns.id,
      proposerId: rackAttack.managerId,
      status: "ACCEPTED",
      notes: "Rebuild-for-now-win swap, completed before the 2025 keeper deadline.",
    },
  });
  await prisma.tradeAsset.create({
    data: {
      tradeId: historicalTrade.id,
      fromTeamId: rackAttack.id,
      toTeamId: velvetHorns.id,
      assetType: "DRAFT_PICK",
      draftPickDescription: "2026 4th round pick",
    },
  });
  await prisma.tradeAsset.create({
    data: {
      tradeId: historicalTrade.id,
      fromTeamId: velvetHorns.id,
      toTeamId: rackAttack.id,
      assetType: "DRAFT_PICK",
      draftPickDescription: "2026 2nd round pick",
    },
  });

  const liveProposal = await prisma.trade.create({
    data: {
      seasonId: seasonByYear.get(CURRENT_SEASON_YEAR)!.id,
      seasonYear: CURRENT_SEASON_YEAR,
      teamAId: antlerAvengers.id,
      teamBId: buckWild.id,
      proposerId: antlerAvengers.managerId,
      status: "PROPOSED",
      notes: "Trying to add a bit more speed for the stretch run.",
    },
  });
  await prisma.tradeAsset.create({
    data: {
      tradeId: liveProposal.id,
      fromTeamId: antlerAvengers.id,
      toTeamId: buckWild.id,
      assetType: "PLAYER",
      playerId: playerIdByName.get("Bobby Witt Jr.")!,
    },
  });
  await prisma.tradeAsset.create({
    data: {
      tradeId: liveProposal.id,
      fromTeamId: buckWild.id,
      toTeamId: antlerAvengers.id,
      assetType: "PLAYER",
      playerId: playerIdByName.get("Anthony Volpe")!,
    },
  });

  await prisma.offer.create({
    data: {
      targetPlayerId: playerIdByName.get("Gunnar Henderson")!,
      sendingTeamId: whitetails.id,
      sendingManagerId: whitetails.managerId,
      receivingTeamId: antlerAlliance.id,
      playersOffered: [playerIdByName.get("Elly De La Cruz")!],
      playersRequested: [playerIdByName.get("Gunnar Henderson")!],
      draftPicksOffered: ["2027 3rd round pick"],
      message: "Saw he's Open to Discuss - would you consider this?",
      status: "PENDING",
    },
  });

  // -------------------------------------------------------------------
  // DPUD
  // -------------------------------------------------------------------

  console.log("Seeding DPUD bets...");
  const currentSeason = seasonByYear.get(CURRENT_SEASON_YEAR)!;

  const openBet = await prisma.dpudBet.create({
    data: {
      seasonId: currentSeason.id,
      seasonYear: CURRENT_SEASON_YEAR,
      creatorId: teamsByName.get("Shed Hunters")!.managerId,
      title: "Witt Jr. hits 35+ homers this season",
      description: "Bobby Witt Jr. finishes the season with 35 or more home runs.",
      statCondition: "HR >= 35",
      stakes: "Loser buys a round at the league draft party.",
      startDate: new Date(`${CURRENT_SEASON_YEAR}-04-01`),
      endDate: new Date(`${CURRENT_SEASON_YEAR}-10-01`),
      status: "OPEN",
    },
  });
  await prisma.dpudBetPlayer.create({
    data: { betId: openBet.id, playerId: playerIdByName.get("Bobby Witt Jr.")! },
  });

  const activeBet = await prisma.dpudBet.create({
    data: {
      seasonId: currentSeason.id,
      seasonYear: CURRENT_SEASON_YEAR,
      creatorId: teamsByName.get("Rack Attack")!.managerId,
      title: "Acuna vs. Rodriguez: better second half",
      description: "Whichever of Ronald Acuna Jr. or Julio Rodriguez has the higher OPS after the All-Star break wins it for their backer.",
      statCondition: "Higher second-half OPS",
      startDate: new Date(`${CURRENT_SEASON_YEAR}-07-15`),
      endDate: new Date(`${CURRENT_SEASON_YEAR}-10-01`),
      status: "ACTIVE",
    },
  });
  await prisma.dpudBetPlayer.createMany({
    data: [
      { betId: activeBet.id, playerId: playerIdByName.get("Ronald Acuna Jr.")! },
      { betId: activeBet.id, playerId: playerIdByName.get("Julio Rodriguez")! },
    ],
  });
  await prisma.dpudParticipant.createMany({
    data: [
      { betId: activeBet.id, managerId: teamsByName.get("Rack Attack")!.managerId },
      { betId: activeBet.id, managerId: teamsByName.get("Velvet Horns")!.managerId },
      { betId: activeBet.id, managerId: teamsByName.get("Antler Avengers")!.managerId },
    ],
  });

  const completeBet = await prisma.dpudBet.create({
    data: {
      seasonId: seasonByYear.get(2025)!.id,
      seasonYear: 2025,
      creatorId: teamsByName.get("Buck Wild")!.managerId,
      title: "Volpe steals 20+ bases in 2025",
      description: "Anthony Volpe finishes 2025 with 20 or more stolen bases.",
      statCondition: "SB >= 20",
      startDate: new Date("2025-04-01"),
      endDate: new Date("2025-10-01"),
      status: "COMPLETE",
      result: "Volpe finished with 24 stolen bases.",
    },
  });
  const p1 = await prisma.dpudParticipant.create({
    data: { betId: completeBet.id, managerId: teamsByName.get("Buck Wild")!.managerId },
  });
  await prisma.dpudParticipant.create({
    data: { betId: completeBet.id, managerId: teamsByName.get("Shed Hunters")!.managerId },
  });
  await prisma.dpudBet.update({
    where: { id: completeBet.id },
    data: { winnerParticipantId: p1.id },
  });

  // -------------------------------------------------------------------
  // Demo standings for the current season. In production these rows are
  // written exclusively by the Yahoo sync job (src/lib/yahoo/sync.ts) -
  // seeding them here is purely so the dashboard/teams pages have
  // something to render before a real Yahoo connection exists.
  // -------------------------------------------------------------------

  console.log("Seeding demo standings...");
  const standingsOrder = shuffled(teamNames, 99);
  for (let i = 0; i < standingsOrder.length; i++) {
    const teamRow = teamsByName.get(standingsOrder[i])!;
    const wins = 20 - i + (i % 3);
    const losses = 10 + i - (i % 2);
    await prisma.teamStanding.create({
      data: {
        seasonId: currentSeason.id,
        teamId: teamRow.id,
        wins,
        losses,
        ties: 0,
        rank: i + 1,
        gamesBack: i === 0 ? 0 : i * 1.5,
      },
    });
  }

  // -------------------------------------------------------------------
  // Yahoo connection stub (never synced - no real credentials in this env)
  // -------------------------------------------------------------------

  console.log("Seeding Yahoo connection placeholder...");
  await prisma.yahooConnection.create({
    data: {
      leagueId: league.id,
      lastSyncStatus: "NEVER_RUN",
      syncIntervalMinutes: 180,
    },
  });

  // -------------------------------------------------------------------
  // Notifications + preferences (off by default; a couple opted in for demo)
  // -------------------------------------------------------------------

  console.log("Seeding notifications...");
  const scott = await prisma.manager.findFirstOrThrow({ where: { email: "scottlawrence325@gmail.com" } });

  await prisma.notification.createMany({
    data: [
      {
        managerId: scott.id,
        type: "KEEPER_YEAR_FIVE",
        title: "Keeper Alert: Ronald Acuna Jr. is in his final keeper year",
        body: "Ronald Acuna Jr. (Velvet Horns) is entering Keeper Year 5/5 and will be forced back into the 2027 draft unless traded before then.",
        link: "/players",
        relatedEntityType: "Player",
        relatedEntityId: playerIdByName.get("Ronald Acuna Jr.")!,
        read: false,
      },
      {
        managerId: scott.id,
        type: "TRADE_PROPOSED",
        title: "Trade proposed: Antler Avengers ↔ Buck Wild",
        body: "You proposed Bobby Witt Jr. for Anthony Volpe. Waiting on Buck Wild.",
        link: "/trades",
        relatedEntityType: "Trade",
        relatedEntityId: liveProposal.id,
        read: false,
      },
      {
        managerId: scott.id,
        type: "DPUD_NEW_BET",
        title: "New DPUD bet: Witt Jr. hits 35+ homers",
        body: "Shed Hunters started a new prop bet you can opt into.",
        link: "/dpud",
        relatedEntityType: "DpudBet",
        relatedEntityId: openBet.id,
        read: true,
      },
      {
        managerId: scott.id,
        type: "SYNC_FAILED",
        title: "Yahoo sync not yet connected",
        body: "Connect your Yahoo account in Commissioner settings to start syncing rosters and standings.",
        link: "/commissioner/yahoo",
        read: true,
      },
    ],
  });

  const allManagers = await prisma.manager.findMany();
  for (const manager of allManagers) {
    await prisma.notificationPreference.createMany({
      data: [
        { managerId: manager.id, type: "KEEPER_YEAR_FIVE", channel: "IN_APP", enabled: manager.id === scott.id },
        { managerId: manager.id, type: "TRADE_PROPOSED", channel: "IN_APP", enabled: manager.id === scott.id },
        { managerId: manager.id, type: "DPUD_NEW_BET", channel: "IN_APP", enabled: false },
        { managerId: manager.id, type: "SYNC_FAILED", channel: "IN_APP", enabled: false },
        { managerId: manager.id, type: "TRADE_PROPOSED", channel: "PUSH", enabled: false },
        { managerId: manager.id, type: "KEEPER_YEAR_FIVE", channel: "EMAIL", enabled: false },
      ],
    });
  }

  // -------------------------------------------------------------------
  // Materialize keeper records via the shared keeper engine
  // -------------------------------------------------------------------

  console.log("Computing keeper records via the keeper engine...");
  await recomputeAllKeeperRecords(CURRENT_SEASON_YEAR);

  console.log("Done.");
}
