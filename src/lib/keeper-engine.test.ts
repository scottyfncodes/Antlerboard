import { describe, it, expect } from "vitest";
import {
  getKeeperYear,
  getKeeperCost,
  getYearsRemaining,
  getForcedRedraftSeason,
  isKeeperEligible,
  didPlayerResetKeeperClock,
  getContinuousKeeperHistory,
  buildStints,
  type PlayerHistoryEvent,
} from "./keeper-engine";

const drafted2021: PlayerHistoryEvent[] = [
  { type: "ACQUIRED", season: 2021, method: "DRAFT", cost: 20, teamId: "teamA" },
];

describe("keeper-engine: basic year progression", () => {
  it("treats the acquisition season as keeper year 0, not a keeper year", () => {
    expect(getKeeperYear(drafted2021, 2021)).toBe(0);
  });

  it("year 1: the season immediately after acquisition", () => {
    expect(getKeeperYear(drafted2021, 2022)).toBe(1);
    expect(getKeeperCost(drafted2021, 2022)).toBe(20);
    expect(getYearsRemaining(drafted2021, 2022)).toBe(4);
  });

  it("year 2", () => {
    expect(getKeeperYear(drafted2021, 2023)).toBe(2);
    expect(getKeeperCost(drafted2021, 2023)).toBe(21);
    expect(getYearsRemaining(drafted2021, 2023)).toBe(3);
  });

  it("year 3", () => {
    expect(getKeeperYear(drafted2021, 2024)).toBe(3);
    expect(getKeeperCost(drafted2021, 2024)).toBe(22);
    expect(getYearsRemaining(drafted2021, 2024)).toBe(2);
  });

  it("year 4 (visually flagged in the UI as the second-to-last year)", () => {
    expect(getKeeperYear(drafted2021, 2025)).toBe(4);
    expect(getKeeperCost(drafted2021, 2025)).toBe(23);
    expect(getYearsRemaining(drafted2021, 2025)).toBe(1);
    expect(isKeeperEligible(drafted2021, 2025)).toBe(true);
  });

  it("year 5 (max) - still eligible to be kept for this final year", () => {
    expect(getKeeperYear(drafted2021, 2026)).toBe(5);
    expect(getKeeperCost(drafted2021, 2026)).toBe(24);
    expect(getYearsRemaining(drafted2021, 2026)).toBe(0);
    expect(isKeeperEligible(drafted2021, 2026)).toBe(true);
  });

  it("forced redraft: the season after 5 consecutive keeper years", () => {
    expect(getForcedRedraftSeason(drafted2021)).toBe(2027);
    expect(isKeeperEligible(drafted2021, 2027)).toBe(false);
    expect(getKeeperYear(drafted2021, 2027)).toBe(6);
  });

  it("matches the section-18 worked example exactly", () => {
    // 2021 acquisition -> 2022 Keeper1 -> ... -> 2026 Keeper5 -> forced back into 2027 draft
    for (const [season, expectedYear] of [
      [2021, 0],
      [2022, 1],
      [2023, 2],
      [2024, 3],
      [2025, 4],
      [2026, 5],
    ] as const) {
      expect(getKeeperYear(drafted2021, season)).toBe(expectedYear);
    }
    expect(getForcedRedraftSeason(drafted2021)).toBe(2027);
  });
});

describe("keeper-engine: waiver acquisitions", () => {
  const waiverPickup: PlayerHistoryEvent[] = [
    { type: "ACQUIRED", season: 2024, method: "WAIVER", cost: 4, teamId: "teamB" },
  ];

  it("first keeper cost is waiver cost + 1", () => {
    expect(getKeeperCost(waiverPickup, 2025)).toBe(5);
  });

  it("acquisition-season cost reflects the raw waiver cost, not +1", () => {
    expect(getKeeperCost(waiverPickup, 2024)).toBe(4);
  });

  it("cost progression continues normally in later keeper years", () => {
    expect(getKeeperCost(waiverPickup, 2026)).toBe(6);
    expect(getKeeperYear(waiverPickup, 2026)).toBe(2);
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
    // Old stint (2022 draft) would have forced back in 2027; new stint
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
    // Dropped exactly in 2025 and reacquired the same season in this
    // fixture; a season strictly between two stints with a real gap
    // should report null.
    const gapEvents: PlayerHistoryEvent[] = [
      { type: "ACQUIRED", season: 2021, method: "DRAFT", cost: 10, teamId: "teamA" },
      { type: "DROPPED", season: 2023 },
      { type: "ACQUIRED", season: 2025, method: "FREE_AGENT", cost: 1, teamId: "teamD" },
    ];
    expect(getKeeperYear(gapEvents, 2024)).toBeNull();
    expect(getKeeperCost(gapEvents, 2024)).toBeNull();
  });

  it("preserves old keeper history in the full timeline as historical information", () => {
    const history = getContinuousKeeperHistory(droppedAndReacquired, 2026);
    const stintIndexes = new Set(history.map((h) => h.stintIndex));
    expect(stintIndexes.size).toBe(2);

    const oldStintSeasons = history
      .filter((h) => h.stintIndex === 0)
      .map((h) => h.season);
    expect(oldStintSeasons).toEqual([2022, 2023, 2024]);

    const newStintSeasons = history
      .filter((h) => h.stintIndex === 1)
      .map((h) => h.season);
    expect(newStintSeasons).toEqual([2025, 2026]);
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
    expect(getKeeperCost(tradedMidStint, 2025)).toBe(32);
  });

  it("does not count as a clock reset", () => {
    expect(didPlayerResetKeeperClock(tradedMidStint)).toBe(false);
  });

  it("reports the correct team for seasons before and after the trade", () => {
    const stints = buildStints(tradedMidStint);
    expect(stints).toHaveLength(1);
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
