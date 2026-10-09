import { describe, it, expect } from "vitest";
import { isLikelyClawAndAntler } from "./league-match";

describe("isLikelyClawAndAntler", () => {
  it("matches the exact expected name", () => {
    expect(isLikelyClawAndAntler("Claw & Antler League")).toBe(true);
  });

  it("matches 'and' spelled out instead of an ampersand", () => {
    expect(isLikelyClawAndAntler("Claw and Antler")).toBe(true);
  });

  it("matches with no spacing around the connector", () => {
    expect(isLikelyClawAndAntler("Claw&Antler")).toBe(true);
  });

  it("matches regardless of case", () => {
    expect(isLikelyClawAndAntler("CLAW & ANTLER FANTASY BASEBALL")).toBe(true);
  });

  it("matches when the words appear separately in the name", () => {
    expect(isLikelyClawAndAntler("The Claw & The Antler Classic")).toBe(true);
  });

  it("does not match an unrelated league name", () => {
    expect(isLikelyClawAndAntler("Dynasty Diamond League")).toBe(false);
  });

  it("does not false-positive on words that merely contain the substrings", () => {
    expect(isLikelyClawAndAntler("Clawson Antlerville Baseball")).toBe(false);
  });

  it("does not match a name with only one of the two words", () => {
    expect(isLikelyClawAndAntler("The Antlers")).toBe(false);
    expect(isLikelyClawAndAntler("Claw Crushers")).toBe(false);
  });
});
