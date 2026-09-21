import { describe, it, expect } from "vitest";
import { parseTeamSeasonLabel, parseManagerSheetSeasonBlocks, resolveTeamSeasonRecords } from "./team-season-history";

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

describe("resolveTeamSeasonRecords", () => {
  it("attributes a franchise with a known handoff to the predecessor before the handoff year", () => {
    const records = parseManagerSheetSeasonBlocks("Andrew", ["Team A - 2021", "Team A - 2023", "Team B - 2024"]);
    const resolved = resolveTeamSeasonRecords(records);
    expect(resolved.map((r) => r.resolvedManagerName)).toEqual(["Stan", "Stan", "Andrew"]);
    expect(resolved.every((r) => r.attribution === "confirmed_handoff")).toBe(true);
  });

  it("marks a confirmed original as such regardless of mid-run renames", () => {
    const records = parseManagerSheetSeasonBlocks("Kurt", ["Whales - 2021", "Plush Sox - 2024"]);
    const resolved = resolveTeamSeasonRecords(records);
    expect(resolved.every((r) => r.resolvedManagerName === "Kurt")).toBe(true);
    expect(resolved.every((r) => r.attribution === "confirmed_original")).toBe(true);
  });

  it("marks a manager with no recorded handoff or confirmation as inferred continuous", () => {
    const records = parseManagerSheetSeasonBlocks("Scott", ["Ranger Thingz - 2021"]);
    const resolved = resolveTeamSeasonRecords(records);
    expect(resolved[0]).toMatchObject({ resolvedManagerName: "Scott", attribution: "inferred_continuous" });
  });

  it("marks a record with no parseable year as unattributed rather than guessing a manager", () => {
    const records = parseManagerSheetSeasonBlocks("Andrew", ["Team A (no year)"]);
    const resolved = resolveTeamSeasonRecords(records);
    expect(resolved[0].attribution).toBe("unattributed");
  });
});
