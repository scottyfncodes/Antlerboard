import { describe, it, expect } from "vitest";
import { parsePropBetRows } from "./prop-bets";

describe("parsePropBetRows", () => {
  it("attaches the season year from a preceding bare-number marker row", () => {
    const rows = [
      [2023, null, null, null],
      ["Alpha", "Bravo", 50, "Highest end of season rank"],
      ["Alpha", "Charlie", 20, "Head to head"],
      [2024, null, null, null],
      ["Bravo", "Charlie", 100, "Best rookie"],
    ];
    const results = parsePropBetRows(rows);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ seasonYear: 2023, teamAName: "Alpha", teamBName: "Bravo", amount: 50 });
    expect(results[2]).toMatchObject({ seasonYear: 2024, teamAName: "Bravo", teamBName: "Charlie" });
    expect(results.every((r) => r.flags.length === 0)).toBe(true);
  });

  it("flags rows before any year marker instead of guessing a year", () => {
    const rows: (string | number | null)[][] = [["Alpha", "Bravo", 20, "Preseason bet"], [2023, null, null, null], ["Alpha", "Bravo", 20, "In-season bet"]];
    const results = parsePropBetRows(rows);
    expect(results[0].seasonYear).toBeNull();
    expect(results[0].flags).toContain("No season-year marker precedes this row.");
    expect(results[1].seasonYear).toBe(2023);
    expect(results[1].flags).toEqual([]);
  });

  it("flags missing team names or description rather than dropping the row", () => {
    const rows: (string | number | null)[][] = [
      [2023, null, null, null],
      [null, "Bravo", 20, "Missing team 1"],
      ["Alpha", null, 20, "Missing team 2"],
      ["Alpha", "Bravo", 20, null],
    ];
    const results = parsePropBetRows(rows);
    expect(results[0].flags).toContain("Missing Team 1 name.");
    expect(results[1].flags).toContain("Missing Team 2 name.");
    expect(results[2].flags).toContain("Missing bet description.");
  });

  it("skips fully blank rows", () => {
    const rows: (string | number | null)[][] = [[2023, null, null, null], [null, null, null, null], ["Alpha", "Bravo", 20, "A real bet"]];
    const results = parsePropBetRows(rows);
    expect(results).toHaveLength(1);
  });

  it("treats a header row (all strings) as an ordinary flagged row, not a year marker", () => {
    const rows: (string | number | null)[][] = [["Team 1", "Team 2", "Amount", "Bet"]];
    const results = parsePropBetRows(rows);
    expect(results).toHaveLength(1);
    expect(results[0].seasonYear).toBeNull();
  });
});
