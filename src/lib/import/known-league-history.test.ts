import { describe, it, expect } from "vitest";
import { resolveSeasonManager, CONFIRMED_ORIGINALS, EXCLUDED_FRANCHISES } from "./known-league-history";

describe("resolveSeasonManager", () => {
  it("attributes pre-handoff seasons to the single predecessor", () => {
    expect(resolveSeasonManager("Andrew", 2021)).toBe("Stan");
    expect(resolveSeasonManager("Andrew", 2023)).toBe("Stan");
  });

  it("attributes the handoff year and after to the current manager", () => {
    expect(resolveSeasonManager("Andrew", 2024)).toBe("Andrew");
    expect(resolveSeasonManager("Andrew", 2026)).toBe("Andrew");
  });

  it("handles a franchise with two predecessors in sequence", () => {
    expect(resolveSeasonManager("Neel", 2021)).toBe("Holman");
    expect(resolveSeasonManager("Neel", 2023)).toBe("Holman");
    expect(resolveSeasonManager("Neel", 2024)).toBe("Josh");
    expect(resolveSeasonManager("Neel", 2025)).toBe("Neel");
    expect(resolveSeasonManager("Neel", 2026)).toBe("Neel");
  });

  it("handles a single-season predecessor tenure", () => {
    expect(resolveSeasonManager("Hugo", 2021)).toBe("Mason");
    expect(resolveSeasonManager("Hugo", 2022)).toBe("Hugo");
  });

  it("falls back to the sheet's own name for a manager with no recorded handoff", () => {
    expect(resolveSeasonManager("Scott", 2021)).toBe("Scott");
    expect(resolveSeasonManager("Jorge", 2026)).toBe("Jorge");
  });

  it("returns the sheet's own name for every season of a confirmed original", () => {
    for (const year of [2019, 2021, 2023, 2024, 2026]) {
      expect(resolveSeasonManager("Kurt", year)).toBe("Kurt");
      expect(resolveSeasonManager("Aaron", year)).toBe("Aaron");
      expect(resolveSeasonManager("Tyler", year)).toBe("Tyler");
    }
  });
});

describe("CONFIRMED_ORIGINALS / EXCLUDED_FRANCHISES", () => {
  it("lists exactly the managers confirmed as continuous originals", () => {
    expect(CONFIRMED_ORIGINALS).toEqual(new Set(["Kurt", "Aaron", "Tyler"]));
  });

  it("excludes Trey - real history, but no link to the current league", () => {
    expect(EXCLUDED_FRANCHISES.has("Trey")).toBe(true);
  });
});
