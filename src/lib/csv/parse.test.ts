import { describe, it, expect } from "vitest";
import { parseCsv, guessMapping } from "./parse";

describe("parseCsv", () => {
  it("parses a simple CSV with a header row", () => {
    const rows = parseCsv("player,team,cost\nWitt,Antler Avengers,18\n");
    expect(rows).toEqual([
      ["player", "team", "cost"],
      ["Witt", "Antler Avengers", "18"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('name,note\n"Smith, Jr.",ok\n');
    expect(rows[1]).toEqual(["Smith, Jr.", "ok"]);
  });

  it("handles escaped double quotes inside a quoted field", () => {
    const rows = parseCsv('name,note\nBob,"He said ""hi"""\n');
    expect(rows[1]).toEqual(["Bob", 'He said "hi"']);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("skips blank lines", () => {
    const rows = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("guessMapping", () => {
  it("matches common header variants to the right field", () => {
    const mapping = guessMapping(["Player Name", "Team", "Season", "Cost", "Method"]);
    expect(mapping.playerName).toBe(0);
    expect(mapping.teamName).toBe(1);
    expect(mapping.season).toBe(2);
    expect(mapping.cost).toBe(3);
    expect(mapping.method).toBe(4);
  });

  it("leaves unmatched fields undefined", () => {
    const mapping = guessMapping(["random column"]);
    expect(mapping.playerName).toBeUndefined();
  });
});
