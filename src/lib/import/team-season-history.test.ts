import { describe, it, expect } from "vitest";
import { parseTeamSeasonLabel, parseManagerSheetSeasonBlocks } from "./team-season-history";

describe("parseTeamSeasonLabel", () => {
  it("parses a plain 'Team - Year' label with no finish", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Thunder Squad - 2021");
    expect(result).toMatchObject({ teamName: "Thunder Squad", seasonYear: 2021, finish: null });
    expect(result.flags).toEqual([]);
  });

  it("parses a 'Team - Year - Finish' label with a plain-text finish", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Thunder Squad - 2025 - 10th");
    expect(result).toMatchObject({ teamName: "Thunder Squad", seasonYear: 2025, finish: "10th" });
  });

  it("parses an emoji medal as the finish, preserved literally", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Thunder Squad - 2025 - \u{1F948} ");
    expect(result.finish).toBe("\u{1F948}");
  });

  it("handles a dangling trailing hyphen with no finish text after it", () => {
    // Confirmed real-world shape: a label ending "- 2026 - " with nothing
    // after the final hyphen.
    const result = parseTeamSeasonLabel("Sample Manager", "Thunder Squad - 2026 - ");
    expect(result).toMatchObject({ teamName: "Thunder Squad", seasonYear: 2026, finish: null });
    expect(result.flags).toEqual([]);
  });

  it("preserves apostrophes and punctuation in team names", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Killer B's FC - 2025 - 7th");
    expect(result.teamName).toBe("Killer B's FC");
  });

  it("flags a label with no 4-digit year rather than guessing one", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Thunder Squad (no year given)");
    expect(result.seasonYear).toBeNull();
    expect(result.flags.length).toBeGreaterThan(0);
  });

  it("does not misinterpret a hyphenated team name as the year segment", () => {
    const result = parseTeamSeasonLabel("Sample Manager", "Old-Timers Club - 2022");
    expect(result.teamName).toBe("Old-Timers Club");
    expect(result.seasonYear).toBe(2022);
  });
});

describe("parseManagerSheetSeasonBlocks", () => {
  it("parses every non-empty label and skips blanks", () => {
    const results = parseManagerSheetSeasonBlocks("Sample Manager", [
      "Thunder Squad - 2021",
      null,
      "Thunder Squad - 2022",
      undefined,
      "",
      "Renamed Squad - 2023 - 4th",
    ]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.seasonYear)).toEqual([2021, 2022, 2023]);
  });
});
