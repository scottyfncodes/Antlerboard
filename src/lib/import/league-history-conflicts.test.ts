import { describe, it, expect } from "vitest";
import { findTransactionConflicts, yahooLeagueKeyOf } from "./league-history-conflicts";

const synced = { yahooTransactionIds: ["469.l.8891.tr.1", "469.l.8891.tr.2"], seasons: [2026] };
const ev = (sourceRef: string) => ({ sourceRef });

describe("findTransactionConflicts", () => {
  it("parses the Yahoo league out of a transaction key", () => {
    expect(yahooLeagueKeyOf("469.l.8891.tr.123")).toBe("469.l.8891");
    expect(yahooLeagueKeyOf("t1")).toBeNull();
  });

  it("reports a transaction the sync already recorded", () => {
    expect(findTransactionConflicts([ev("yahoo:469.l.8891.tr.2")], synced).join(" ")).toMatch(/already recorded by the Yahoo sync/);
  });

  it("reports any transaction from a season the sync owns, synced yet or not", () => {
    expect(findTransactionConflicts([ev("yahoo:469.l.8891.tr.999")], synced).join(" ")).toMatch(/a season the Yahoo sync already records/);
  });

  it("reports end-of-year reconstructed moves for a synced season", () => {
    expect(findTransactionConflicts([ev("workbook:Scott/2026/eoy")], synced)).toHaveLength(1);
  });

  it("allows earlier seasons, workbook events and an empty sync", () => {
    const fine = [ev("yahoo:458.l.1.tr.7"), ev("workbook:Scott/2025/eoy"), ev("auction:x"), ev("not kept into 2026"), ev("offseason trades row 2")];
    expect(findTransactionConflicts(fine, synced)).toEqual([]);
    expect(findTransactionConflicts([ev("yahoo:469.l.8891.tr.2")], { yahooTransactionIds: [], seasons: [] })).toEqual([]);
  });
});
