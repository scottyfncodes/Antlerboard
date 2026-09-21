import { describe, it, expect } from "vitest";
import { parseTradeRows } from "./trades";

describe("parseTradeRows", () => {
  it("attaches the season year from a preceding marker row and keeps the exact trade date", () => {
    const rows = [
      [2023, null, null, null, null, null, null],
      [new Date("2023-01-04"), "Alpha", "Player One", "Bravo", "Player Two", "None", "None"],
    ];
    const results = parseTradeRows(rows);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      seasonYear: 2023,
      tradeDate: new Date("2023-01-04").toISOString(),
      teamAName: "Alpha",
      teamAPlayersRaw: "Player One",
      teamBName: "Bravo",
      teamBPlayersRaw: "Player Two",
    });
    expect(results[0].flags).toEqual([]);
  });

  it("flags a trade row before any year marker instead of inferring the season from the date", () => {
    const rows: (string | number | Date | null)[][] = [
      [new Date("2019-12-03"), "Alpha", "Player One", "Bravo", "Player Two", null, null],
      [2022, null, null, null, null, null, null],
    ];
    const results = parseTradeRows(rows);
    expect(results[0].seasonYear).toBeNull();
    expect(results[0].tradeDate).toBe(new Date("2019-12-03").toISOString());
    expect(results[0].flags).toContain("No season-year marker precedes this row - only the trade's own date (if present) is known.");
  });

  it("flags a missing trade date without dropping the row", () => {
    const rows: (string | number | Date | null)[][] = [
      [2023, null, null, null, null, null, null],
      [null, "Alpha", "Player One", "Bravo", "Player Two", null, null],
    ];
    const results = parseTradeRows(rows);
    expect(results[0].tradeDate).toBeNull();
    expect(results[0].flags).toContain("No trade date recorded.");
  });

  it("skips fully blank rows", () => {
    const rows: (string | number | Date | null)[][] = [
      [2023, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
    ];
    expect(parseTradeRows(rows)).toHaveLength(0);
  });
});
