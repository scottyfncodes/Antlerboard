import { describe, it, expect } from "vitest";
import {
  buildPlayerCostRows,
  classifyAcquisitionCost,
  classifyAuctionCost,
  classifyKeeperCost,
  findStintOrigin,
  costLabel,
  costDisplay,
  compareCostDesc,
  summarizeKeeperBudget,
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

});

describe("provenance-tagged acquisition prices", () => {
  const tagged = (price: string, o: Partial<Parameters<typeof classifyAcquisitionCost>[0]> = {}) =>
    classifyAcquisitionCost(acq({ sourceRef: `league-history:x|price=${price}`, ...o }));

  it("shows a missing price as Unavailable even though the column holds 0", () => {
    const v = tagged("missing", { method: "DRAFT", cost: 0 });
    expect(v.status).toBe("unavailable");
    expect(costLabel(v)).toBe("Unavailable");
  });

  it("shows a guessed (inferred) price as Unavailable, never the guess", () => {
    expect(tagged("inferred", { cost: 12 }).status).toBe("unavailable");
  });

  it("keeps a legitimate $0 as $0 and says why", () => {
    expect(tagged("recorded", { cost: 0 })).toMatchObject({ status: "recorded", amount: 0, note: expect.stringContaining("$0") });
    expect(tagged("rule", { method: "FYPD", cost: 0 })).toMatchObject({ status: "recorded", amount: 0 });
  });

  it("trusts a tag over legacy note wording (a sheet $0 that really was $0)", () => {
    expect(tagged("recorded", { cost: 0, sourceRef: "league-history:workbook:A/2024/eoy|price=recorded" })).toMatchObject({ status: "recorded", amount: 0 });
  });

  it("never prices a trade, tagged or not", () => {
    expect(tagged("recorded", { method: "TRADE", cost: 0 }).status).toBe("not-applicable");
  });
});

describe("keeper cost provenance", () => {
  const rec = (o: Partial<Parameters<typeof classifyKeeperCost>[0]> = {}) => ({
    seasonYear: 2025,
    keeperYear: 2,
    keeperCost: 14,
    status: "KEPT" as const,
    commissionerOverride: false,
    ...o,
  });
  const origin = (price: string, o: Partial<NonNullable<Parameters<typeof classifyKeeperCost>[1]>> = {}) => ({
    seasonYear: 2023,
    method: "DRAFT" as const,
    cost: 10,
    notes: null,
    sourceRef: `league-history:auction:x|price=${price}`,
    ...o,
  });

  it("shows a cost calculated from a recorded price, labelled as calculated", () => {
    expect(classifyKeeperCost(rec(), origin("recorded"))).toMatchObject({ status: "recorded", amount: 14, basis: "calculated" });
  });

  it("hides a cost calculated from a missing or guessed price", () => {
    expect(classifyKeeperCost(rec(), origin("missing", { cost: 0 })).status).toBe("unavailable");
    expect(classifyKeeperCost(rec(), origin("inferred")).status).toBe("unavailable");
  });

  it("shows a workbook-confirmed season as recorded even when the origin price was guessed", () => {
    const o = origin("inferred", { sourceRef: "league-history:k|price=inferred|keeper-recorded=2025" });
    expect(classifyKeeperCost(rec(), o)).toMatchObject({ status: "recorded", basis: "recorded", amount: 14 });
    expect(classifyKeeperCost(rec({ seasonYear: 2026, keeperYear: 3 }), o).status).toBe("unavailable");
  });

  it("always keeps a commissioner/workbook override as recorded", () => {
    expect(classifyKeeperCost(rec({ commissionerOverride: true, keeperCost: 13 }), origin("missing"))).toMatchObject({ status: "recorded", amount: 13, basis: "recorded" });
    expect(classifyKeeperCost(rec({ commissionerOverride: true }), null).status).toBe("recorded");
  });

  it("never shows the engine's stored $0 for a forced redraft", () => {
    const v = classifyKeeperCost(rec({ status: "FORCED_BACK", keeperCost: 0, keeperYear: 6 }), origin("recorded"));
    expect(v.status).toBe("not-applicable");
    // "None", never $0 - and never "Carried", which means a trade.
    expect(costLabel(v)).toBe("None");
  });

  it("is Unavailable when the cost can't be traced to an acquisition", () => {
    expect(classifyKeeperCost(rec(), null).status).toBe("unavailable");
  });

  it("calculates from the FYPD rule base for a call-up", () => {
    expect(classifyKeeperCost(rec({ keeperCost: 5, keeperYear: 1 }), origin("rule", { method: "FYPD", cost: 0, seasonYear: 2024 }))).toMatchObject({
      status: "recorded",
      amount: 5,
      basis: "calculated",
    });
  });
});

describe("findStintOrigin", () => {
  const a = (seasonYear: number, method: "DRAFT" | "WAIVER" | "TRADE", day = 1) => ({ seasonYear, method, date: new Date(Date.UTC(seasonYear, 3, day)) });

  it("picks the stintIndex-th non-trade acquisition and checks it against the keeper year", () => {
    const acqs = [a(2024, "WAIVER", 9), a(2022, "DRAFT"), a(2023, "TRADE"), a(2024, "DRAFT", 2)];
    expect(findStintOrigin(acqs, { seasonYear: 2025, keeperYear: 3, stintIndex: 0 })).toBe(acqs[1]);
    expect(findStintOrigin(acqs, { seasonYear: 2025, keeperYear: 1, stintIndex: 2 })).toBe(acqs[0]);
    expect(findStintOrigin(acqs, { seasonYear: 2025, keeperYear: 2, stintIndex: 0 })).toBeNull(); // season doesn't line up
    expect(findStintOrigin(acqs, { seasonYear: 2025, keeperYear: 0, stintIndex: 9 })).toBeNull();
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
        originAcquisitions: [
          { id: "a1", playerId: "p1", seasonYear: 2026, method: "DRAFT", cost: 41, notes: null, sourceRef: "league-history:auction:x|price=recorded", date: new Date("2026-03-20"), team: A },
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
    expect(rows.find((x) => x.player.id === "p1")!.keeper).toMatchObject({ key: "k1", keeperYear: 0 });
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
        { id: "k1", playerId: "p2", seasonYear: 2026, keeperYear: 1, keeperCost: 6, yearsRemaining: 4, status: "KEPT", stintIndex: 0, commissionerOverride: true, team: B, startTeam: B },
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

describe("shared cost presentation (team page, market, search, draft board)", () => {
  const recorded = (amount: number) => ({ status: "recorded" as const, amount });
  const unavailable = { status: "unavailable" as const, reason: "No recorded price." };
  const none = { status: "not-applicable" as const, label: "None" as const, reason: "Forced back." };
  const carried = { status: "not-applicable" as const, label: "Carried" as const, reason: "Trade." };

  it("labels each case: real $0 as $0, trades Carried, forced back None, unknown Unavailable", () => {
    expect(costLabel(recorded(0))).toBe("$0");
    expect(costLabel(classifyAcquisitionCost(acq({ cost: 0, sourceRef: "x|price=recorded" })))).toBe("$0");
    expect(costLabel(classifyAcquisitionCost(acq({ method: "TRADE" })))).toBe("Carried");
    expect(costLabel(classifyAcquisitionCost(acq({ cost: 0, sourceRef: "x|price=missing" })))).toBe("Unavailable");
    expect(costLabel(classifyAcquisitionCost(acq({ cost: 9, sourceRef: "x|price=inferred" })))).toBe("Unavailable");
    expect(costLabel(none)).toBe("None");
    expect(costLabel(carried)).toBe("Carried");
  });

  it("marks only a recorded cost as confirmed, and carries the reason for the tooltip", () => {
    expect(costDisplay(recorded(12))).toEqual({ text: "$12", confirmed: true, title: undefined });
    expect(costDisplay(unavailable)).toEqual({ text: "Unavailable", confirmed: false, title: "No recorded price." });
    expect(costDisplay(none)).toMatchObject({ text: "None", confirmed: false });
  });

  it("adds up only confirmed keeper costs, and won't state a budget while any is unconfirmed", () => {
    expect(summarizeKeeperBudget([recorded(30), recorded(0), none], 260)).toEqual({ confirmedTotal: 30, unconfirmed: 0, budgetLeft: 230 });
    expect(summarizeKeeperBudget([recorded(30), unavailable, undefined], 260)).toEqual({ confirmedTotal: 30, unconfirmed: 2, budgetLeft: null });
    expect(summarizeKeeperBudget([], 260)).toEqual({ confirmedTotal: 0, unconfirmed: 0, budgetLeft: 260 });
  });

  it("sorts by cost with confirmed amounts first, then None/Carried, then Unavailable", () => {
    const values = [unavailable, recorded(5), none, recorded(40), undefined, recorded(0)];
    expect([...values].sort(compareCostDesc).map((v) => (v ? costLabel(v) : "missing"))).toEqual(["$40", "$5", "$0", "None", "Unavailable", "missing"]);
  });
});
