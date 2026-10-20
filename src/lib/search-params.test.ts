import { describe, it, expect } from "vitest";
import { hrefKeepingParams, hrefWithParam, parseIntParam } from "./search-params";

describe("parseIntParam", () => {
  it("reads whole numbers and rejects anything else", () => {
    expect(parseIntParam("2026")).toBe(2026);
    expect(parseIntParam("abc")).toBeNull();
    expect(parseIntParam("2026abc")).toBeNull();
    expect(parseIntParam("20.5")).toBeNull();
    expect(parseIntParam("-1")).toBeNull();
    expect(parseIntParam("")).toBeNull();
    expect(parseIntParam(undefined)).toBeNull();
  });
});

describe("hrefWithParam", () => {
  it("switches season without dropping the active filters", () => {
    expect(hrefWithParam("/keepers", { season: "2026", minYear: "4", team: "t1" }, "season", 2025)).toBe("/keepers?minYear=4&team=t1&season=2025");
  });

  it("skips undefined params and removes the key on an empty value", () => {
    expect(hrefWithParam("/keepers", { season: "2026", team: undefined }, "season", "")).toBe("/keepers");
    expect(hrefWithParam("/keepers", new URLSearchParams("team=t1&sort=cost"), "team", null)).toBe("/keepers?sort=cost");
  });
});

describe("hrefKeepingParams", () => {
  it("clears filters but keeps the selected season", () => {
    expect(hrefKeepingParams("/keepers", new URLSearchParams("season=2025&minYear=4&team=t1"), ["season"])).toBe("/keepers?season=2025");
    expect(hrefKeepingParams("/keepers", new URLSearchParams("minYear=4"), ["season"])).toBe("/keepers");
  });
});
