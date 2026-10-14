import { describe, it, expect } from "vitest";
import { planPlayerIdentities, type IdentityExistingPlayer, type IdentityImportPlayer } from "./player-identity";

const imp = (key: string, name: string, positions: string[] = [], yahooPlayerId: string | null = null): IdentityImportPlayer => ({ key, name, positions, yahooPlayerId });
const ex = (id: string, name: string, positions: string[] = [], yahooPlayerId: string | null = null): IdentityExistingPlayer => ({ id, name, positions, yahooPlayerId });

describe("planPlayerIdentities", () => {
  it("matches by canonical Yahoo id across the bare and full-key forms", () => {
    const plan = planPlayerIdentities([imp("9999", "Aaron Judge", ["OF"], "9999")], [ex("p1", "Aaron Judge", ["OF"], "469.p.9999")]);
    expect(plan.decisions.get("9999")).toEqual({ kind: "existing", playerId: "p1", via: "yahoo-id" });
    expect(plan.conflicts).toEqual([]);
  });

  it("trusts the Yahoo id over a different stored name (a renamed player)", () => {
    const plan = planPlayerIdentities([imp("1", "Mike Siani", [], "1")], [ex("p1", "Michael Siani", [], "469.p.1")]);
    expect(plan.decisions.get("1")).toMatchObject({ kind: "existing", playerId: "p1" });
  });

  it("separates same-name players at different positions", () => {
    const existing = [ex("c", "Will Smith", ["C"], "469.p.100"), ex("p", "Will Smith", ["RP"], "469.p.200")];
    const plan = planPlayerIdentities([imp("n:will smith:P", "Will Smith", ["SP"]), imp("n:will smith:H", "Will Smith", ["C", "1B"])], existing);
    expect(plan.decisions.get("n:will smith:P")).toEqual({ kind: "existing", playerId: "p", via: "name" });
    expect(plan.decisions.get("n:will smith:H")).toEqual({ kind: "existing", playerId: "c", via: "name" });
  });

  it("uses Yahoo's (Batter)/(Pitcher) markers as the role", () => {
    const existing = [ex("b", "Shohei Ohtani (Batter)", ["Util"], "469.p.1"), ex("p", "Shohei Ohtani (Pitcher)", ["SP"], "469.p.2")];
    const plan = planPlayerIdentities([imp("n:shohei ohtani:P", "Shohei Ohtani (P)")], existing);
    expect(plan.decisions.get("n:shohei ohtani:P")).toMatchObject({ kind: "existing", playerId: "p" });
  });

  it("flags an ambiguous name for review and creates a separate player instead of guessing", () => {
    const existing = [ex("c", "Will Smith", ["C"], "469.p.100"), ex("p", "Will Smith", ["RP"], "469.p.200")];
    const plan = planPlayerIdentities([imp("n:will smith", "Will Smith")], existing);
    expect(plan.decisions.get("n:will smith")).toEqual({ kind: "new" });
    expect(plan.review).toEqual([expect.objectContaining({ importKey: "n:will smith", candidateIds: ["c", "p"] })]);
  });

  it("never lets two import players claim the same existing player by name", () => {
    const plan = planPlayerIdentities([imp("a", "Luis Garcia"), imp("b", "Luis Garcia")], [ex("x", "Luis Garcia")]);
    expect(plan.decisions.get("a")).toEqual({ kind: "new" });
    expect(plan.decisions.get("b")).toEqual({ kind: "new" });
    expect(plan.review).toHaveLength(2);
  });

  it("never matches an import player that has a Yahoo id to an existing player linked to a different one", () => {
    const plan = planPlayerIdentities([imp("300", "Will Smith", ["C"], "300")], [ex("c", "Will Smith", ["C"], "469.p.100")]);
    expect(plan.decisions.get("300")).toEqual({ kind: "new" });
    expect(plan.review).toEqual([]);
  });

  it("links an unlinked existing player (an FYPD prospect) when the name is unique on both sides", () => {
    const plan = planPlayerIdentities([imp("555", "Konnor Griffin", ["SS"], "555")], [ex("k", "Konnor Griffin", ["SS"])]);
    expect(plan.decisions.get("555")).toEqual({ kind: "existing", playerId: "k", via: "name" });
  });

  it("creates unmatched players quietly", () => {
    const plan = planPlayerIdentities([imp("n:nobody", "Nobody Known")], [ex("x", "Someone Else")]);
    expect(plan.decisions.get("n:nobody")).toEqual({ kind: "new" });
    expect(plan.review).toEqual([]);
    expect(plan.counts).toEqual({ byYahooId: 0, byName: 0, created: 1 });
  });

  it("reports a Yahoo id already stored on two players as a conflict", () => {
    const plan = planPlayerIdentities([imp("9", "Dup", [], "9")], [ex("a", "Dup", [], "469.p.9"), ex("b", "Dup", [], "458.p.9")]);
    expect(plan.conflicts).toHaveLength(1);
  });
});

describe("planPlayerIdentities - abbreviations", () => {
  it("does not match an abbreviated workbook name to an existing player (initials alone aren't identity)", () => {
    const plan = planPlayerIdentities([imp("n:s ohtani", "S. Ohtani (P)")], [ex("p", "Shohei Ohtani (Pitcher)", ["SP"], "469.p.2")]);
    expect(plan.decisions.get("n:s ohtani")).toEqual({ kind: "new" });
  });
});
