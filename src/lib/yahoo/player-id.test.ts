import { describe, it, expect } from "vitest";
import { canonicalYahooPlayerId, yahooPlayerIdForms } from "./player-id";

describe("canonicalYahooPlayerId", () => {
  it("reduces the sync's full key and the import's bare id to the same identity", () => {
    expect(canonicalYahooPlayerId("469.p.12345")).toBe("12345");
    expect(canonicalYahooPlayerId("458.p.12345")).toBe("12345");
    expect(canonicalYahooPlayerId("12345")).toBe("12345");
    expect(canonicalYahooPlayerId(" 469.p.7 ")).toBe("7");
  });

  it("rejects anything that isn't a Yahoo player id", () => {
    for (const bad of [null, undefined, "", "469.l.8891.t.1", "p.12", "abc", "469.p.", "n:will smith"]) {
      expect(canonicalYahooPlayerId(bad)).toBeNull();
    }
  });

  it("filters every stored form, anchored so 12345 never matches 112345", () => {
    const [bare, full] = yahooPlayerIdForms("12345");
    expect(bare).toEqual({ yahooPlayerId: "12345" });
    expect(full).toEqual({ yahooPlayerId: { endsWith: ".p.12345" } });
    expect("469.p.112345".endsWith(".p.12345")).toBe(false);
  });
});
