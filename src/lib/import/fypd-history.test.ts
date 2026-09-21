import { describe, it, expect } from "vitest";
import { parseFypdRawSection } from "./fypd-history";

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
