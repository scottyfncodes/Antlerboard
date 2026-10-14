import { describe, it, expect } from "vitest";
import {
  buildPlayerCostRows,
  classifyAcquisitionCost,
  classifyAuctionCost,
  classifyKeeperCost,
  costLabel,
  filterPlayerCostRows,
  paginate,
  type BuildPlayerCostRowsInput,
} from "./player-costs";

const A = { id: "ta", name: "Alpha" };
const B = { id: "tb", name: "Bravo" };
const judge = { id: "p1", name: "Aaron Judge", mlbTeam: "NYY", positions: ["OF"] };
const skubal = { id: "p2", name: "Tarik Skubal", mlbTeam: "DET", positions: ["SP"] };

function input(overrides: Partial<BuildPlayerCostRowsInput> = {}): BuildPlayerCostRowsInput {
  return {
    season: 2026,
    players: [judge, skubal],
    auctionPicks: [],
    acquisitions: [],
    keeperRecords: [],
    currentRoster: [],
    currentRosterSynced: false,
    isCurrentSeason: true,
    ...overrides,
  };
}

const acq = (o: Partial<Parameters<typeof classifyAcquisitionCost>[0]> = {}) => ({
  method: "WAIVER" as const,
  cost: 7,
  notes: null,
  sourceRef: "league-history:yahoo:458.l.1.tr.5",
  ...o,
});

describe("classifyAcquisitionCost", () => {
  it("returns a recorded FAAB price", () => {
    expect(classifyAcquisitionCost(acq())).toEqual({ status: "recorded", amount: 7 });
  });

  it("keeps a real $0 Yahoo claim as $0 (Yahoo omits faab_bid on $0 claims)", () => {
    expect(classifyAcquisitionCost(acq({ cost: 0 }))).toEqual({ status: "recorded", amount: 0 });
  });

  it("treats the import's 'recorded as 0' placeholder as Unavailable, not $0", () => {
    const v = classifyAcquisitionCost(acq({ method: "DRAFT", cost: 0, notes: "Auction row had no salary - cost recorded as 0." }));
    expect(v.status).toBe("unavailable");
    expect(costLabel(v)).toBe("Unavailable");
  });

  it("treats an import-inferred origin price as Unavailable", () => {
    const v = classifyAcquisitionCost(
      acq({ cost: 11, notes: "Kept in 2025 with no acquisition on record - origin assumed to be a 2024 pickup priced to match the recorded keeper cost." })
    );
    expect(v.status).toBe("unavailable");
  });

  it("treats a $0 from a season-end roster sheet as Unavailable (blank and $0 look the same there)", () => {
    expect(classifyAcquisitionCost(acq({ cost: 0, sourceRef: "league-history:workbook:Scott/2024/eoy" })).status).toBe("unavailable");
    expect(classifyAcquisitionCost(acq({ cost: 4, sourceRef: "league-history:workbook:Scott/2024/eoy" }))).toEqual({ status: "recorded", amount: 4 });
  });

  it("never prices a trade - it carries the existing cost", () => {
    const v = classifyAcquisitionCost(acq({ method: "TRADE", cost: 0 }));
    expect(v.status).toBe("not-applicable");
    expect(costLabel(v)).toBe("Carried");
  });

  it("shows an FYPD call-up as a free $0 with the keeper-clock note", () => {
    const v = classifyAcquisitionCost(acq({ method: "FYPD", cost: 0 }));
    expect(v).toMatchObject({ status: "recorded", amount: 0 });
  });
});

describe("auction and keeper cost", () => {
  it("never turns a missing auction price into $0", () => {
    expect(classifyAuctionCost(null).status).toBe("unavailable");
    expect(classifyAuctionCost(23)).toEqual({ status: "recorded", amount: 23 });
  });

  it("formats recorded keeper costs and rejects invalid ones", () => {
    expect(costLabel(classifyKeeperCost(12.5))).toBe("$12.50");
    expect(classifyKeeperCost(undefined).status).toBe("unavailable");
    expect(classifyKeeperCost(Number.NaN).status).toBe("unavailable");
  });
});

describe("buildPlayerCostRows", () => {
  it("lists players with every cost Unavailable when nothing is on record", () => {
    const rows = buildPlayerCostRows(input());
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.auction).toEqual([]);
      expect(r.acquisitions).toEqual([]);
      expect(r.keeper).toBeNull();
      expect(r.hasRecordedCost).toBe(false);
      expect(r.currentStatus.kind).toBe("unknown");
    }
  });

  it("keeps the four cost facts separate when they're all on record", () => {
    const rows = buildPlayerCostRows(
      input({
        auctionPicks: [{ id: "d1", playerId: "p1", seasonYear: 2026, overallPick: 4, cost: 41, isKeeperSlot: false, team: A }],
        acquisitions: [{ id: "a1", playerId: "p1", seasonYear: 2026, method: "DRAFT", cost: 41, notes: null, sourceRef: "league-history:auction:x", date: new Date("2026-03-20"), team: A }],
        keeperRecords: [
          { id: "k1", playerId: "p1", seasonYear: 2026, keeperYear: 0, keeperCost: 41, yearsRemaining: 5, status: "KEPT", stintIndex: 0, commissionerOverride: false, team: A, startTeam: A },
        ],
      })
    );
    const judgeRow = rows.find((r) => r.player.id === "p1")!;
    expect(judgeRow.auction[0].cost).toEqual({ status: "recorded", amount: 41 });
    expect(judgeRow.acquisitions[0]).toMatchObject({ method: "DRAFT", methodLabel: "Auction", cost: { status: "recorded", amount: 41 } });
    expect(judgeRow.keeper).toMatchObject({ keeperYear: 0, cost: { status: "recorded", amount: 41 }, statusLabel: "Kept" });
    expect(judgeRow.hasRecordedCost).toBe(true);
    expect(rows.find((r) => r.player.id === "p2")!.hasRecordedCost).toBe(false);
  });

  it("never shows another season's costs (season separation)", () => {
    const rows = buildPlayerCostRows(
      input({
        auctionPicks: [{ id: "d1", playerId: "p1", seasonYear: 2025, overallPick: 4, cost: 41, isKeeperSlot: false, team: A }],
        keeperRecords: [
          { id: "k1", playerId: "p1", seasonYear: 2025, keeperYear: 2, keeperCost: 45, yearsRemaining: 3, status: "KEPT", stintIndex: 0, commissionerOverride: false, team: A, startTeam: A },
        ],
      })
    );
    const r = rows.find((x) => x.player.id === "p1")!;
    expect(r.auction).toEqual([]);
    expect(r.keeper).toBeNull();
    expect(r.hasRecordedCost).toBe(false);
  });

  it("excludes keeper-slot draft rows from the auction price", () => {
    const rows = buildPlayerCostRows(
      input({ auctionPicks: [{ id: "d1", playerId: "p1", seasonYear: 2026, overallPick: 1, cost: 9, isKeeperSlot: true, team: A }] })
    );
    expect(rows.find((r) => r.player.id === "p1")!.auction).toEqual([]);
  });

  it("flags a player with duplicate auction records instead of silently picking one", () => {
    const rows = buildPlayerCostRows(
      input({
        auctionPicks: [
          { id: "d1", playerId: "p1", seasonYear: 2026, overallPick: 4, cost: 41, isKeeperSlot: false, team: A },
          { id: "d2", playerId: "p1", seasonYear: 2026, overallPick: 90, cost: 3, isKeeperSlot: false, team: B },
        ],
      })
    );
    const r = rows.find((x) => x.player.id === "p1")!;
    expect(r.auction).toHaveLength(2);
    expect(r.flags.join(" ")).toContain("2 auction records");
  });

  it("uses the live (latest) keeper stint when a player has two in one season", () => {
    const rows = buildPlayerCostRows(
      input({
        keeperRecords: [
          { id: "k0", playerId: "p1", seasonYear: 2026, keeperYear: 3, keeperCost: 20, yearsRemaining: 2, status: "DROPPED", stintIndex: 0, commissionerOverride: false, team: A, startTeam: A },
          { id: "k1", playerId: "p1", seasonYear: 2026, keeperYear: 0, keeperCost: 2, yearsRemaining: 5, status: "KEPT", stintIndex: 1, commissionerOverride: false, team: B, startTeam: B },
        ],
      })
    );
    expect(rows.find((x) => x.player.id === "p1")!.keeper).toMatchObject({ key: "k1", cost: { amount: 2 } });
  });

  it("reports current team / free agent only once a roster sync exists", () => {
    const synced = buildPlayerCostRows(input({ currentRoster: [{ playerId: "p1", team: A }], currentRosterSynced: true }));
    expect(synced.find((r) => r.player.id === "p1")!.currentStatus).toEqual({ kind: "team", team: A });
    expect(synced.find((r) => r.player.id === "p2")!.currentStatus).toEqual({ kind: "free-agent" });
  });

  it("never uses today's roster as a past season's team", () => {
    const rows = buildPlayerCostRows(input({ season: 2025, isCurrentSeason: false, currentRoster: [{ playerId: "p1", team: A }], currentRosterSynced: true }));
    const r = rows.find((x) => x.player.id === "p1")!;
    expect(r.seasonTeams).toEqual([]);
    expect(r.currentStatus).toEqual({ kind: "team", team: A });
  });
});

describe("filterPlayerCostRows", () => {
  const rows = buildPlayerCostRows(
    input({
      currentRoster: [
        { playerId: "p1", team: A },
        { playerId: "p2", team: B },
      ],
      currentRosterSynced: true,
      keeperRecords: [
        { id: "k1", playerId: "p2", seasonYear: 2026, keeperYear: 1, keeperCost: 6, yearsRemaining: 4, status: "KEPT", stintIndex: 0, commissionerOverride: false, team: B, startTeam: B },
      ],
    })
  );

  it("filters by team, position, search and cost status", () => {
    expect(filterPlayerCostRows(rows, { teamId: "ta" }).map((r) => r.player.id)).toEqual(["p1"]);
    expect(filterPlayerCostRows(rows, { position: "SP" }).map((r) => r.player.id)).toEqual(["p2"]);
    expect(filterPlayerCostRows(rows, { q: "judge" }).map((r) => r.player.id)).toEqual(["p1"]);
    expect(filterPlayerCostRows(rows, { q: "det" }).map((r) => r.player.id)).toEqual(["p2"]);
    expect(filterPlayerCostRows(rows, { cost: "recorded" }).map((r) => r.player.id)).toEqual(["p2"]);
    expect(filterPlayerCostRows(rows, { cost: "missing" }).map((r) => r.player.id)).toEqual(["p1"]);
  });
});

describe("paginate", () => {
  it("clamps out-of-range and garbage page numbers", () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(items, 1).items).toHaveLength(50);
    expect(paginate(items, 3)).toMatchObject({ page: 3, pageCount: 3, total: 120 });
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate(items, Number("abc")).page).toBe(1);
    expect(paginate([], 1)).toMatchObject({ page: 1, pageCount: 1, total: 0 });
  });
});
