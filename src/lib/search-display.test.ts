import { describe, it, expect } from "vitest";
import { searchKeeperLine } from "./search-display";

describe("search result keeper line", () => {
  const base = { team: "Alpha", keeperSeason: null, keeperYear: 2, yearsRemaining: 3 };

  it("shows a confirmed cost as a dollar amount", () => {
    expect(searchKeeperLine({ ...base, cost: { text: "$14", confirmed: true } })).toBe("Alpha · $14 · Yr 2 · 3y left");
  });

  it("shows Unavailable and None instead of a raw stored number", () => {
    expect(searchKeeperLine({ ...base, cost: { text: "Unavailable", confirmed: false } })).toBe("Alpha · Unavailable · Yr 2 · 3y left");
    expect(searchKeeperLine({ ...base, cost: { text: "None", confirmed: false } })).toBe("Alpha · None · Yr 2 · 3y left");
    expect(searchKeeperLine({ ...base, cost: null })).toBe("Alpha · Unavailable · Yr 2 · 3y left");
  });

  it("says which season an older keeper record is from", () => {
    expect(searchKeeperLine({ ...base, keeperSeason: 2024, cost: { text: "$9", confirmed: true } })).toBe("2024: Alpha · $9 · Yr 2 · 3y left");
  });
});
