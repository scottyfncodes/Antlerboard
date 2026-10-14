import { describe, it, expect } from "vitest";
import { baseRef, readProvenance, tagRef } from "./provenance";

describe("import provenance tags", () => {
  it("round-trips price, order and workbook-recorded keeper seasons", () => {
    const ref = tagRef("league-history:auction:A1", { price: "missing", order: "sheet", keeperRecorded: [2024, 2022, 2024] });
    expect(ref).toBe("league-history:auction:A1|price=missing|order=sheet|keeper-recorded=2022,2024");
    expect(readProvenance(ref)).toEqual({ price: "missing", order: "sheet", keeperRecorded: [2022, 2024] });
    expect(baseRef(ref)).toBe("league-history:auction:A1");
  });

  it("keeps the league-history prefix intact so a re-run still finds its own rows", () => {
    expect(tagRef("league-history:yahoo:458.l.1.tr.3", { price: "recorded" }).startsWith("league-history:")).toBe(true);
  });

  it("treats untagged refs (hand-entered, app-created, older imports) as having no provenance", () => {
    expect(readProvenance(null)).toEqual({ keeperRecorded: [] });
    expect(readProvenance("league-history:auction:A1")).toEqual({ keeperRecorded: [] });
  });

  it("ignores unknown or malformed tags and neutralizes a | in the raw ref", () => {
    expect(readProvenance("x|price=free|order=|foo=bar")).toEqual({ keeperRecorded: [] });
    expect(tagRef("sheet|name", { price: "recorded" })).toBe("sheet/name|price=recorded");
  });
});
