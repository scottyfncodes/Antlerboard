import { describe, expect, it } from "vitest";
import { groupHittersAndPitchers, isPitcher, ordinal } from "./positions";

describe("isPitcher", () => {
  it("is true only when every position is a pitching one", () => {
    expect(isPitcher(["SP"])).toBe(true);
    expect(isPitcher(["SP", "RP"])).toBe(true);
    expect(isPitcher(["SP", "OF"])).toBe(false);
    expect(isPitcher(["SS"])).toBe(false);
    expect(isPitcher([])).toBe(false);
  });
});

describe("groupHittersAndPitchers", () => {
  it("splits while preserving order", () => {
    const rows = [{ p: ["SS"] }, { p: ["SP"] }, { p: ["OF"] }, { p: ["RP"] }];
    const { hitters, pitchers } = groupHittersAndPitchers(rows, (r) => r.p);
    expect(hitters).toEqual([rows[0], rows[2]]);
    expect(pitchers).toEqual([rows[1], rows[3]]);
  });
});

describe("ordinal", () => {
  it("handles teens and regular suffixes", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th",
    ]);
  });
});
