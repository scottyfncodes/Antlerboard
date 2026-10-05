import { describe, it, expect } from "vitest";
import {
  getKeeperYear,
  getKeeperCost,
  getProjectedKeeperCost,
  getYearsRemaining,
  getForcedRedraftSeason,
  isKeeperEligible,
  didPlayerResetKeeperClock,
  getContinuousKeeperHistory,
  buildStints,
  computeKeeperCost,
  type PlayerHistoryEvent,
} from "./keeper-engine";

const drafted2021: PlayerHistoryEvent[] = [
  { type: "ACQUIRED", season: 2021, method: "DRAFT", cost: 20, teamId: "teamA" },
];

describe("keeper-engine: basic year progression", () => {
  it("treats the acquisition season as keeper year 0, not a keeper year", () => {
    expect(getKeeperYear(drafted2021, 2021)).toBe(0);
    expect(getKeeperCost(drafted2021, 2021)).toBe(20);
  });

  it("year 1: the season immediately after acquisition costs base + 1", () => {
    expect(getKeeperYear(drafted2021, 2022)).toBe(1);
    expect(getKeeperCost(drafted2021, 2022)).toBe(21);
    expect(getYearsRemaining(drafted2021, 2022)).toBe(4);
  });

  it("year 2 adds +3 (base + 4)", () => {
    expect(getKeeperYear(drafted2021, 2023)).toBe(2);
    expect(getKeeperCost(drafted2021, 2023)).toBe(24);
    expect(getYearsRemaining(drafted2021, 2023)).toBe(3);
  });

  it("year 3 adds +5 (base + 9)", () => {
    expect(getKeeperYear(drafted2021, 2024)).toBe(3);
    expect(getKeeperCost(drafted2021, 2024)).toBe(29);
    expect(getYearsRemaining(drafted2021, 2024)).toBe(2);
  });

  it("year 4 adds +7 (base + 16), visually flagged in the UI as the second-to-last year", () => {
    expect(getKeeperYear(drafted2021, 2025)).toBe(4);
    expect(getKeeperCost(drafted2021, 2025)).toBe(36);
    expect(getYearsRemaining(drafted2021, 2025)).toBe(1);
    expect(isKeeperEligible(drafted2021, 2025)).toBe(true);
  });

  it("year 5 (max) adds +9 (base + 25) - still eligible to be kept for this final year", () => {
    expect(getKeeperYear(drafted2021, 2026)).toBe(5);
    expect(getKeeperCost(drafted2021, 2026)).toBe(45);
    expect(getYearsRemaining(drafted2021, 2026)).toBe(0);
    expect(isKeeperEligible(drafted2021, 2026)).toBe(true);
  });

  it("forced redraft: the season after 5 consecutive keeper years", () => {
    expect(getForcedRedraftSeason(drafted2021)).toBe(2027);
    expect(isKeeperEligible(drafted2021, 2027)).toBe(false);
    expect(getKeeperYear(drafted2021, 2027)).toBe(6);
  });

  it("matches the league's own ladder on a real example ($66 -> 67, 70, 75, 82, 91)", () => {
    expect([1, 2, 3, 4, 5].map((y) => computeKeeperCost(66, y))).toEqual([67, 70, 75, 82, 91]);
  });

  it("projects next season's keeper cost from the current season's stint", () => {
    expect(getProjectedKeeperCost(drafted2021, 2022)).toBe(21);
    expect(getProjectedKeeperCost(drafted2021, 2026)).toBe(45);
    expect(getProjectedKeeperCost(drafted2021, 2027)).toBeNull(); // would be year 6
    expect(getProjectedKeeperCost(drafted2021, 2021)).toBeNull(); // not rostered in 2020
  });
});

describe("keeper-engine: FAAB / waiver acquisitions", () => {
  const waiverPickup: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2024, method: "WAIVER", cost: 4, teamId: "teamB" },
  ];

  it("base price is the winning bid itself - first keeper year is bid + 1", () => {
    expect(getKeeperCost(waiverPickup, 2024)).toBe(4);
    expect(getKeeperCost(waiverPickup, 2025)).toBe(5);
  });

  it("cost climbs the same ladder afterwards", () => {
    expect(getKeeperCost(waiverPickup, 2026)).toBe(8);
    expect(getKeeperYear(waiverPickup, 2026)).toBe(2);
  });
});

describe("keeper-engine: FYPD call-ups", () => {
  const callUp: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2025, method: "FYPD", cost: 0, teamId: "teamC" },
  ];

  it("is free in the call-up season but keeps at the assumed $4 base + 1 = $5", () => {
    expect(getKeeperCost(callUp, 2025)).toBe(0);
    expect(getKeeperCost(callUp, 2026)).toBe(5);
    expect(getKeeperCost(callUp, 2027)).toBe(8);
  });

  it("ignores whatever FAAB amount happened to be entered on Yahoo for the call-up", () => {
    const paidFive: PlayerHistoryEvent[] = [
      { type: "ACQUIRED", season: 2025, method: "FYPD", cost: 5, teamId: "teamC" },
    ];
    expect(getKeeperCost(paidFive, 2026)).toBe(5);
  });
});

describe("keeper-engine: drop = complete reset", () => {
  const droppedAndReacquired: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2022, method: "DRAFT", cost: 15, teamId: "teamA" },
    { type: "DROPPED", season: 2025 },
    { type: "ACQUIRED", season: 2025, method: "WAIVER", cost: 3, teamId: "teamC" },
  ];

  it("current keeper year reflects only the new stint", () => {
    expect(getKeeperYear(droppedAndReacquired, 2025)).toBe(0);
    expect(getKeeperYear(droppedAndReacquired, 2026)).toBe(1);
  });

  it("new keeper cost is based on the new waiver acquisition, not old draft cost", () => {
    expect(getKeeperCost(droppedAndReacquired, 2026)).toBe(4); // 3 + 1
  });

  it("old tenure does not affect the new forced-redraft season", () => {
    // Old stint (2022 draft) would have forced back in 2028; new stint
    // (2025 waiver) should force back in 2031.
    expect(getForcedRedraftSeason(droppedAndReacquired)).toBe(2031);
  });

  it("flags that the player's clock was reset at some point", () => {
    expect(didPlayerResetKeeperClock(droppedAndReacquired)).toBe(true);
  });

  it("does not flag a reset for a player with a single continuous stint", () => {
    expect(didPlayerResetKeeperClock(drafted2021)).toBe(false);
  });

  it("has no keeper data for seasons between the drop and reacquisition gap", () => {
    const gapEvents: PlayerHistoryEvent[] = [
      { type: "ACQUIRED", season: 2021, method: "DRAFT", cost: 10, teamId: "teamA" },
      { type: "DROPPED", season: 2023 },
      { type: "ACQUIRED", season: 2025, method: "FREE_AGENT", cost: 1, teamId: "teamD" },
    ];
    expect(getKeeperYear(gapEvents, 2023)).toBe(2); // kept into 2023, dropped during it
    expect(getKeeperYear(gapEvents, 2024)).toBeNull();
    expect(getKeeperCost(gapEvents, 2024)).toBeNull();
  });

  it("preserves old keeper history in the full timeline, through the season of the drop", () => {
    const history = getContinuousKeeperHistory(droppedAndReacquired, 2026);
    const stintIndexes = new Set(history.map((h) => h.stintIndex));
    expect(stintIndexes.size).toBe(2);

    const oldStint = history.filter((h) => h.stintIndex === 0);
    expect(oldStint.map((h) => h.season)).toEqual([2022, 2023, 2024, 2025]);
    expect(oldStint.at(-1)?.droppedThisSeason).toBe(true);
    expect(oldStint.at(-2)?.droppedThisSeason).toBe(false);

    const newStintSeasons = history
      .filter((h) => h.stintIndex === 1)
      .map((h) => h.season);
    expect(newStintSeasons).toEqual([2025, 2026]);
  });

  it("treats 'not kept into next season' as a drop recorded against the season just finished", () => {
    const notKept: PlayerHistoryEvent[] = [
      { type: "ACQUIRED", season: 2023, method: "DRAFT", cost: 12, teamId: "teamA" },
      { type: "DROPPED", season: 2024, date: new Date("2024-12-31") },
    ];
    expect(getKeeperYear(notKept, 2024)).toBe(1);
    expect(getKeeperYear(notKept, 2025)).toBeNull();
    expect(getForcedRedraftSeason(notKept)).toBeNull();
  });
});

describe("keeper-engine: dated events resolve in-season churn", () => {
  const churn: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2023, method: "DRAFT", cost: 9, teamId: "teamA", date: new Date("2023-03-25") },
    { type: "DROPPED", season: 2023, date: new Date("2023-06-10") },
    { type: "ACQUIRED", season: 2023, method: "WAIVER", cost: 2, teamId: "teamB", date: new Date("2023-07-02") },
  ];

  it("the re-adding team owns the player for that season, at the new base cost", () => {
    const stints = buildStints(churn);
    expect(stints).toHaveLength(2);
    expect(stints[0].endSeason).toBe(2023);
    expect(stints[1].endSeason).toBeNull();
    expect(getKeeperCost(churn, 2024)).toBe(3);
    expect(getContinuousKeeperHistory(churn, 2024).filter((h) => h.season === 2023).map((h) => h.teamId)).toEqual([
      "teamA",
      "teamB",
    ]);
  });

  it("a dated drop before a dated trade in the same season leaves the trade with nothing to apply to", () => {
    const events: PlayerHistoryEvent[] = [
      { type: "ACQUIRED", season: 2023, method: "DRAFT", cost: 9, teamId: "teamA", date: new Date("2023-03-25") },
      { type: "DROPPED", season: 2023, date: new Date("2023-06-10") },
      { type: "TRADED", season: 2023, teamId: "teamZ", date: new Date("2023-08-01") },
    ];
    const stints = buildStints(events);
    expect(stints).toHaveLength(1);
    expect(getContinuousKeeperHistory(events, 2023)[0].teamId).toBe("teamA");
  });

  it("undated events keep the legacy DROPPED -> ACQUIRED -> TRADED order", () => {
    const events: PlayerHistoryEvent[] = [
      { type: "TRADED", season: 2024, teamId: "teamB" },
      { type: "ACQUIRED", season: 2024, method: "WAIVER", cost: 1, teamId: "teamA" },
    ];
    const stints = buildStints(events);
    expect(stints).toHaveLength(1);
    expect(getContinuousKeeperHistory(events, 2024)[0].teamId).toBe("teamB");
  });
});

describe("keeper-engine: team at the start of a season vs. at the end", () => {
  const events: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2024, method: "DRAFT", cost: 10, teamId: "teamA", date: new Date("2024-03-23") },
    // offseason deal before the 2025 keeper deadline: teamB declares the keeper
    { type: "TRADED", season: 2025, teamId: "teamB", date: new Date("2025-01-10"), preseason: true },
    // in-season trade: teamC holds the player at the end of 2025
    { type: "TRADED", season: 2025, teamId: "teamC", date: new Date("2025-07-01") },
  ];

  it("credits the preseason trade to the keeping team and the in-season trade to the holder", () => {
    const row2025 = getContinuousKeeperHistory(events, 2025).find((r) => r.season === 2025)!;
    expect(row2025.teamIdAtStart).toBe("teamB");
    expect(row2025.teamId).toBe("teamC");
    expect(row2025.keeperYear).toBe(1);
  });

  it("uses the acquiring team for the acquisition season", () => {
    const row2024 = getContinuousKeeperHistory(events, 2025).find((r) => r.season === 2024)!;
    expect(row2024.teamIdAtStart).toBe("teamA");
    expect(row2024.teamId).toBe("teamA");
  });

  it("carries the end-of-season holder into the next season's start", () => {
    const row2026 = getContinuousKeeperHistory(events, 2026).find((r) => r.season === 2026)!;
    expect(row2026.teamIdAtStart).toBe("teamC");
  });
});

describe("keeper-engine: trades continue the clock instead of resetting it", () => {
  const tradedMidStint: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2022, method: "DRAFT", cost: 30, teamId: "teamA" },
    { type: "TRADED", season: 2024, teamId: "teamB" },
  ];

  it("keeper year keeps counting across the trade", () => {
    expect(getKeeperYear(tradedMidStint, 2023)).toBe(1);
    expect(getKeeperYear(tradedMidStint, 2024)).toBe(2);
    expect(getKeeperYear(tradedMidStint, 2025)).toBe(3);
  });

  it("cost keeps progressing across the trade, unaffected by the team change", () => {
    expect(getKeeperCost(tradedMidStint, 2025)).toBe(39);
  });

  it("does not count as a clock reset", () => {
    expect(didPlayerResetKeeperClock(tradedMidStint)).toBe(false);
  });

  it("reports the correct team for seasons before and after the trade", () => {
    const stints = buildStints(tradedMidStint);
    expect(stints).toHaveLength(1);
    const history = getContinuousKeeperHistory(tradedMidStint, 2025);
    expect(history.find((h) => h.season === 2023)?.teamId).toBe("teamA");
    expect(history.find((h) => h.season === 2024)?.teamId).toBe("teamB");
  });
});

describe("keeper-engine: eligibility", () => {
  it("is not eligible for a player with no acquisition history", () => {
    expect(isKeeperEligible([], 2026)).toBe(false);
  });

  it("is eligible through year 5 but not year 6", () => {
    expect(isKeeperEligible(drafted2021, 2026)).toBe(true);
    expect(isKeeperEligible(drafted2021, 2027)).toBe(false);
  });
});
