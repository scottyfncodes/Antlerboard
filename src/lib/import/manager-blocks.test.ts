import { describe, it, expect } from "vitest";
import { parseManagerSheetBlocks, findBlockStarts } from "./manager-blocks";

type Cell = string | number | null;

/** Builds a sheet with one 2026-style block at column 0 and a second block at column 8. */
function sheet(): Cell[][] {
  const rows: Cell[][] = [];
  const put = (r: number, c: number, v: Cell) => {
    while (rows.length <= r) rows.push([]);
    rows[r][c] = v;
  };
  put(1, 2, "Alpha Team - 2026");
  put(1, 10, "Alpha Team - 2025 - 4th");
  const header = ["Keepers", "Keeper Cost", "Draft", "Draft Cost", "EOY", "2025 Cost", "Keeper Cost"];
  header.forEach((h, i) => {
    put(3, i, h);
    put(3, 8 + i, h);
  });
  // block 1 keepers + total + legend
  put(4, 0, "George Kirby"); put(4, 1, 17);
  put(5, 0, "Roman Anthony"); put(5, 1, 5);
  put(6, 0, "Total"); put(6, 1, 22);
  put(7, 0, "25 > 26"); put(7, 1, "26 > 27");
  put(8, 0, "Plus $9"); put(8, 1, "Plus $9");
  // block 1 draft
  put(4, 2, "José Ramírez (CLE - 3B)"); put(4, 3, 76);
  put(5, 2, "Wyatt Langford (TEX - OF)"); put(5, 3, 50);
  // block 1 EOY runs past the FYPD section
  for (let i = 0; i < 20; i++) {
    put(4 + i, 4, `Player ${i}`); put(4 + i, 5, 2); put(4 + i, 6, 3);
  }
  // FYPD marker + prospect table (reuses draft columns)
  put(11, 1, "FYPD");
  put(12, 0, "Player Name"); put(12, 1, "Team"); put(12, 2, "Position"); put(12, 3, "Draft Age");
  put(13, 0, "Braylon Payne"); put(13, 1, "Milwaukee Brewers"); put(13, 2, "OF"); put(13, 3, 18);
  put(14, 0, "Dax Kilby"); put(14, 1, "New York Yankees"); put(14, 2, "SS"); put(14, 3, 18);
  put(16, 1, "26 > 27 Off Season Trades");
  put(17, 0, "Send"); put(17, 1, "To"); put(17, 2, "For"); put(17, 3, "Keeper Cost");
  put(18, 0, "Someone"); put(18, 1, "Ed"); put(18, 2, "Other Guy"); put(18, 3, 5);
  // block 2 (2025): keepers without a Total row
  put(4, 8, "L.Lynn"); put(4, 9, 14);
  put(5, 8, "C. Mullins"); put(5, 9, 5);
  put(4, 10, "E.Suarez"); put(4, 11, 40);
  put(4, 12, "J.Ramirez"); put(4, 13, 55); put(4, 14, 56);
  return rows;
}

describe("findBlockStarts", () => {
  it("locates every season label on row 2 and anchors the block two columns left of it", () => {
    expect(findBlockStarts(sheet())).toEqual([0, 8]);
  });
});

describe("parseManagerSheetBlocks", () => {
  const blocks = parseManagerSheetBlocks("Scott", sheet());

  it("parses one block per season label with team name, year and finish", () => {
    expect(blocks.map((b) => [b.seasonYear, b.teamName, b.finish])).toEqual([
      [2026, "Alpha Team", null],
      [2025, "Alpha Team", "4th"],
    ]);
  });

  it("stops the keeper list at Total and ignores the escalation legend", () => {
    expect(blocks[0].keepers).toEqual([
      { name: "George Kirby", cost: 17 },
      { name: "Roman Anthony", cost: 5 },
    ]);
    expect(blocks[0].keeperTotal).toBe(22);
  });

  it("stops the draft list at the FYPD marker so prospect positions/ages never pollute it", () => {
    expect(blocks[0].draft).toEqual([
      { name: "José Ramírez (CLE - 3B)", cost: 76 },
      { name: "Wyatt Langford (TEX - OF)", cost: 50 },
    ]);
  });

  it("keeps reading the EOY roster below the FYPD and trade sections", () => {
    expect(blocks[0].eoyRoster).toHaveLength(20);
    expect(blocks[0].eoyRoster[19]).toEqual({ name: "Player 19", cost: 2, nextSeasonCost: 3 });
  });

  it("reads the prospect table and skips the trade mini-log", () => {
    expect(blocks[0].prospects).toEqual([
      { name: "Braylon Payne", mlbTeam: "Milwaukee Brewers", position: "OF", draftAge: 18 },
      { name: "Dax Kilby", mlbTeam: "New York Yankees", position: "SS", draftAge: 18 },
    ]);
    expect(blocks[0].keepers.find((k) => k.name === "Someone")).toBeUndefined();
    expect(blocks[0].draft.find((d) => d.name === "Other Guy")).toBeUndefined();
  });

  it("flags the stale '2025 Cost' header on a non-2025 block and still reads positionally", () => {
    expect(blocks[0].flags).toContain('End-of-year cost column still carries a stale "2025 Cost" header (copy-paste); read positionally.');
    expect(blocks[1].flags).toEqual([]);
  });

  it("handles a block with no Total row", () => {
    expect(blocks[1].keepers).toEqual([
      { name: "L.Lynn", cost: 14 },
      { name: "C. Mullins", cost: 5 },
    ]);
    expect(blocks[1].keeperTotal).toBeNull();
    expect(blocks[1].eoyRoster).toEqual([{ name: "J.Ramirez", cost: 55, nextSeasonCost: 56 }]);
  });

  it("flags a keeper total that doesn't match the listed costs", () => {
    const rows = sheet();
    rows[6][1] = 99;
    const [b] = parseManagerSheetBlocks("Scott", rows);
    expect(b.flags).toContain("Keeper costs sum to 22 but the sheet's Total row says 99.");
  });
});
