import { describe, it, expect } from "vitest";
import { gzipSync } from "zlib";
import { seasonsMissingAuctionResults, yahooCsvText } from "./league-history-sources";
import type { AuctionRow, ManagerSeasonBlock } from "./league-history-types";

describe("yahooCsvText", () => {
  const csv = 'season,league_key,transaction_raw\n2024,431.l.2411,"{""transaction_key"":""431.l.2411.tr.1""}"\n';

  it("reads a plain CSV and the history export's .csv.gz alike (by content, not name)", () => {
    expect(yahooCsvText(Buffer.from(csv))).toBe(csv);
    expect(yahooCsvText(gzipSync(Buffer.from(csv)))).toBe(csv);
  });

  it("refuses a gzip that unpacks past the cap (a gzip bomb), rather than filling memory", () => {
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => yahooCsvText(bomb)).toThrow();
  });
});


describe("seasonsMissingAuctionResults", () => {
  const block = (seasonYear: number, draft: number): ManagerSeasonBlock => ({
    managerSheetName: "Scott", seasonYear, teamName: "Ranger Thingz", finish: null, sourceLabel: "", keepers: [], keeperTotal: null,
    draft: Array.from({ length: draft }, (_, i) => ({ name: `P${i}`, cost: 1 })), eoyRoster: [], prospects: [], flags: [],
  });
  const row = (seasonYear: number, isKeeper: boolean): AuctionRow => ({ seasonLabel: String(seasonYear), seasonYear, pick: 1, playerName: "X", mlbTeam: null, positions: [], salary: 1, teamName: "Ranger Thingz", isKeeper, sourceRef: "r", flags: [] });

  it("names every season the workbook drafted in but the auction file has no buys for (keepers alone don't count)", () => {
    expect(seasonsMissingAuctionResults([block(2025, 18), block(2026, 17)], [row(2025, false), row(2026, true)])).toEqual([2026]);
    expect(seasonsMissingAuctionResults([block(2025, 18), block(2026, 17)], [row(2025, false), row(2026, false)])).toEqual([]);
    expect(seasonsMissingAuctionResults([block(2026, 0)], [])).toEqual([]);
  });
});
