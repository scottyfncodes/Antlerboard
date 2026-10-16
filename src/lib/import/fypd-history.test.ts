import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseFypdRawSection, parseFypdSheet } from "./fypd-history";
import { worksheetToRows } from "./workbook-reader";

describe("parseFypdRawSection", () => {
  it("extracts picks using the supplied column map and always leaves seasonYear null", () => {
    const rows = [
      [1, "Team A", "Prospect One", "SS"],
      [2, "Team B", "Prospect Two", "RHP"],
      [null, null, null, null],
    ];
    const section = parseFypdRawSection("FYPD", "Table 1 (cols A-D)", rows, {
      pick: 0,
      team: 1,
      player: 2,
      position: 3,
    });

    expect(section.seasonYear).toBeNull();
    expect(section.picks).toHaveLength(2);
    expect(section.picks[0]).toEqual({
      overallPickInSource: 1,
      teamNameRaw: "Team A",
      playerName: "Prospect One",
      positionRaw: "SS",
      extra: {},
    });
    expect(section.flags.length).toBeGreaterThan(0);
    expect(section.flags[0]).toMatch(/not labeled/i);
  });

  it("only ever fills in seasonYear from an explicit confirmed value, never guessed", () => {
    const rows = [[1, "Team A", "Prospect One"]];
    const unconfirmed = parseFypdRawSection("FYPD", "Table 1", rows, { pick: 0, team: 1, player: 2 });
    expect(unconfirmed.seasonYear).toBeNull();
    expect(unconfirmed.flags.length).toBeGreaterThan(0);

    const confirmed = parseFypdRawSection("FYPD", "Table 1", rows, { pick: 0, team: 1, player: 2 }, 2025);
    expect(confirmed.seasonYear).toBe(2025);
    expect(confirmed.flags).toEqual([]);
  });

  it("skips fully blank rows and works without a position column", () => {
    const rows = [
      [1, "Team A", "Prospect One"],
      [null, null, null],
      [2, "Team B", "Prospect Two"],
    ];
    const section = parseFypdRawSection("FYPD", "Table 2 (cols R-Y)", rows, { pick: 0, team: 1, player: 2 });
    expect(section.picks).toHaveLength(2);
    expect(section.picks.every((p) => p.positionRaw === null)).toBe(true);
  });

  it("skips a dangling tail row that only has a bare pick number and no player", () => {
    const rows = [
      [1, "Team A", "Prospect One"],
      [2, "Team B", "Prospect Two"],
      [3, null, null],
      [4, null, null],
    ];
    const section = parseFypdRawSection("FYPD", "Table 1 (cols A-D)", rows, { pick: 0, team: 1, player: 2 });
    expect(section.picks).toHaveLength(2);
  });

  it("skips a row that has a team name but no player name", () => {
    const rows = [
      [1, "Team A", "Prospect One"],
      [2, "Team B", null],
    ];
    const section = parseFypdRawSection("FYPD", "Table 1 (cols A-D)", rows, { pick: 0, team: 1, player: 2 });
    expect(section.picks).toHaveLength(1);
  });
});

/**
 * The real FYPD sheet, cut down: row 1 blank, row 2 headers, then picks.
 * Table 1 (2026 FYPD) in A-C; Table 2 (2025 FYPD) in R-T; and right beside
 * Table 2, in U-Y, the 2024 MLB draft reference list - its POS belongs to
 * the MLB pick in U, not to the FYPD pick on the same row. Table 2 and
 * reference-list values are copied from the commissioner's workbook
 * (Official_Keeper_Costs.xlsx); Table 1 uses placeholders.
 */
async function realFypdSheetRows() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("FYPD");
  const set = (row: number, col: string, value: string | number) => (ws.getCell(`${col}${row}`).value = value);
  // Row 2: headers as the workbook has them.
  Object.entries({ B: "Team", C: "Pick", D: "Pick #", E: "Player Name", F: "Team", G: "Position", S: "Team", T: "Pick", U: "#", V: "Player Name", W: "POS", X: "Drafted By", Y: "Drafted From" }).forEach(([c, v]) => set(2, c, v));
  const table1: [number, string, string][] = [[1, "Ed", "Table One Prospect"], [2, "Aaron", "Table One Second"]];
  table1.forEach(([n, team, player], i) => { set(3 + i, "A", n); set(3 + i, "B", team); set(3 + i, "C", player); });
  // [FYPD pick, team, player, MLB #, reference name (blanked once drafted), POS, Drafted By, Drafted From]
  const table2: [number | null, string | null, string | null, number, string | null, string, string, string][] = [
    [1, "Matty J", "Konnor Griffin", 1, null, "2B", "Cleveland Guardians", "Oregon State University"],
    [2, "Andrew", "Travis Bazzana", 2, null, "RHP", "Cincinnati Reds", "Wake Forest University"],
    [3, "Hugo", "Chase Burns", 3, null, "OF", "Colorado Rockies", "University of Georgia"],
    [57, "Aaron", "Nick McLain", 57, "Carter Johnson", "SS", "Miami Marlins", "Oxford High School (Oxford, AL)"],
    // Past the last FYPD pick the reference list carries on alone.
    [null, null, null, 62, "Ethan Anderson", "C", "Baltimore Orioles", "University of Virginia"],
  ];
  table2.forEach(([n, team, player, mlb, refName, pos, by, from], i) => {
    const r = 3 + i;
    if (n !== null) set(r, "R", n);
    if (team) set(r, "S", team);
    if (player) set(r, "T", player);
    set(r, "U", mlb);
    if (refName) set(r, "V", refName);
    set(r, "W", pos);
    set(r, "X", by);
    set(r, "Y", from);
  });
  return worksheetToRows(ws).slice(2);
}

describe("parseFypdSheet (real workbook layout)", () => {
  it("reads Table 2's pick, team and player from R-T", async () => {
    const [, table2] = parseFypdSheet(await realFypdSheetRows(), 2026, 2025);
    expect(table2.label).toBe("Table 2 (cols R-Y)");
    expect(table2.seasonYear).toBe(2025);
    expect(table2.picks.map((p) => [p.overallPickInSource, p.teamNameRaw, p.playerName])).toEqual([
      [1, "Matty J", "Konnor Griffin"],
      [2, "Andrew", "Travis Bazzana"],
      [3, "Hugo", "Chase Burns"],
      [57, "Aaron", "Nick McLain"],
    ]);
  });

  it("never takes a position from the adjacent 2024 MLB draft reference list (U-Y)", async () => {
    const [, table2] = parseFypdSheet(await realFypdSheetRows(), 2026, 2025);
    // Column W on Bazzana's row is MLB #2's "RHP", not Bazzana's position.
    expect(table2.picks.map((p) => p.positionRaw)).toEqual([null, null, null, null]);
    expect(JSON.stringify(table2.picks)).not.toMatch(/RHP|Cincinnati|Wake Forest|Carter Johnson/);
  });

  it("never turns a reference-list name into an FYPD pick", async () => {
    const [, table2] = parseFypdSheet(await realFypdSheetRows(), 2026, 2025);
    expect(table2.picks.map((p) => p.playerName)).not.toContain("Ethan Anderson");
    expect(table2.picks.map((p) => p.playerName)).not.toContain("Carter Johnson");
  });

  it("reads Table 1 from A-C, independent of Table 2", async () => {
    const [table1] = parseFypdSheet(await realFypdSheetRows(), 2026, 2025);
    expect(table1.seasonYear).toBe(2026);
    expect(table1.picks.map((p) => [p.overallPickInSource, p.teamNameRaw, p.playerName, p.positionRaw])).toEqual([
      [1, "Ed", "Table One Prospect", null],
      [2, "Aaron", "Table One Second", null],
    ]);
  });
});
