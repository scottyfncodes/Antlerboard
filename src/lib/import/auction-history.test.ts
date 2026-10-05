import { describe, it, expect } from "vitest";
import { parseAuctionHistorySheet, seasonLabelToYear } from "./auction-history";

describe("seasonLabelToYear", () => {
  it("maps Season_N labels relative to the first season", () => {
    expect(seasonLabelToYear("Season_1", 2021)).toBe(2021);
    expect(seasonLabelToYear("Season_4", 2021)).toBe(2024);
  });

  it("accepts the bare-number label the real file has for season 5, and 4-digit years as-is", () => {
    expect(seasonLabelToYear("5", 2021)).toBe(2025);
    expect(seasonLabelToYear("2023", 2021)).toBe(2023);
  });

  it("returns null for anything else", () => {
    expect(seasonLabelToYear("Spring", 2021)).toBeNull();
  });
});

describe("parseAuctionHistorySheet", () => {
  const header = ["Season", "Season", "Pick", "Player", "MLB_Team", "Pos", "Salary", "Fantasy_Team"];

  it("reads rows by header name, splitting positions and mapping the season", () => {
    const rows = [header, ["Season_1", "Season_1", 1, "Mookie Betts", "LAD", "2B,OF", 66, "Duran Brujan"]];
    const [row] = parseAuctionHistorySheet(rows, { sheetName: "Auctions", firstSeasonYear: 2021, isKeeper: false });
    expect(row).toMatchObject({
      seasonYear: 2021,
      pick: 1,
      playerName: "Mookie Betts",
      mlbTeam: "LAD",
      positions: ["2B", "OF"],
      salary: 66,
      teamName: "Duran Brujan",
      isKeeper: false,
      sourceRef: "Auctions row 2",
    });
    expect(row.flags).toEqual([]);
  });

  it("uses an IsKeeper column when the caller doesn't force the flag", () => {
    const rows = [
      [...header, "IsKeeper"],
      ["Season_2", "Season_2", 300, "Tim Anderson", "LAA", "SS", 2, "Home Run Holman", 1],
      ["Season_2", "Season_2", 1, "Corey Seager", "TEX", "SS", 18, "Bring in the Righty", 0],
    ];
    const parsed = parseAuctionHistorySheet(rows, { sheetName: "Parsed", firstSeasonYear: 2021 });
    expect(parsed.map((r) => r.isKeeper)).toEqual([true, false]);
  });

  it("flags unmapped seasons and missing salaries but keeps the row", () => {
    const rows = [header, ["Mystery", "Mystery", 1, "Someone", "NYY", "C", null, "Alpha"]];
    const [row] = parseAuctionHistorySheet(rows, { sheetName: "Auctions", firstSeasonYear: 2021, isKeeper: false });
    expect(row.seasonYear).toBeNull();
    expect(row.flags).toEqual(["Season label could not be mapped to a year.", "Missing salary."]);
  });

  it("skips blank rows and returns nothing for a sheet without the expected columns", () => {
    expect(parseAuctionHistorySheet([header, [null, null, null, null, null, null, null, null]], { sheetName: "A", firstSeasonYear: 2021 })).toEqual([]);
    expect(parseAuctionHistorySheet([["Foo", "Bar"], ["x", "y"]], { sheetName: "A", firstSeasonYear: 2021 })).toEqual([]);
  });
});
