import { describe, it, expect } from "vitest";
import { getDraftColor, getDraftColorRange, nextCycleColor } from "./draft-color-engine";

describe("draft-color-engine", () => {
  it("matches the documented 2021-2028 cycle exactly", () => {
    expect(getDraftColor(2021).color).toBe("RED");
    expect(getDraftColor(2022).color).toBe("ORANGE");
    expect(getDraftColor(2023).color).toBe("YELLOW");
    expect(getDraftColor(2024).color).toBe("GREEN");
    expect(getDraftColor(2025).color).toBe("BLUE");
    expect(getDraftColor(2026).color).toBe("RED");
    expect(getDraftColor(2028).color).toBe("ORANGE");
  });

  it("marks 2027 as skipped and does not assign it a color", () => {
    const result = getDraftColor(2027);
    expect(result.skipped).toBe(true);
    expect(result.color).toBeNull();
  });

  it("does not let a skipped season advance the cycle", () => {
    // 2026 = RED (index 0). If 2027 advanced the cycle it would be ORANGE
    // (index 1) making 2028 YELLOW (index 2). Instead 2027 is skipped, so
    // 2028 should be ORANGE (index 1) - the step 2027 would have taken.
    const color2026 = getDraftColor(2026).color;
    const color2028 = getDraftColor(2028).color;
    expect(color2026).toBe("RED");
    expect(color2028).toBe("ORANGE");
  });

  it("computes a color for 2020 (before the documented anchor) via extrapolation", () => {
    const result = getDraftColor(2020);
    expect(result.skipped).toBe(false);
    expect(result.color).not.toBeNull();
  });

  it("continues the cycle correctly for future seasons after the skip", () => {
    expect(getDraftColor(2029).color).toBe("YELLOW");
    expect(getDraftColor(2030).color).toBe("GREEN");
    expect(getDraftColor(2031).color).toBe("BLUE");
    expect(getDraftColor(2032).color).toBe("RED");
  });

  it("honors an explicit override even when a cycle color would otherwise apply", () => {
    const result = getDraftColor(2022, { overrides: { 2022: "BLUE" } });
    expect(result.color).toBe("BLUE");
    expect(result.overridden).toBe(true);
  });

  it("supports multiple skipped seasons without breaking the cycle", () => {
    const options = { skippedSeasons: [2027, 2029] };
    expect(getDraftColor(2026, options).color).toBe("RED");
    expect(getDraftColor(2027, options).skipped).toBe(true);
    expect(getDraftColor(2028, options).color).toBe("ORANGE");
    expect(getDraftColor(2029, options).skipped).toBe(true);
    expect(getDraftColor(2030, options).color).toBe("YELLOW");
  });

  it("getDraftColorRange returns one entry per year in order", () => {
    const range = getDraftColorRange(2021, 2028);
    expect(range).toHaveLength(8);
    expect(range[0].year).toBe(2021);
    expect(range[range.length - 1].year).toBe(2028);
  });

  it("nextCycleColor wraps around after blue", () => {
    expect(nextCycleColor("RED")).toBe("ORANGE");
    expect(nextCycleColor("BLUE")).toBe("RED");
  });
});
