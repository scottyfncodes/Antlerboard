import { describe, it, expect } from "vitest";
import { computeFypdDraftOrder, type StandingInput } from "./fypd-order-engine";

function standings(): StandingInput[] {
  return Array.from({ length: 12 }, (_, i) => ({ teamId: `team-rank-${i + 1}`, rank: i + 1 }));
}

describe("computeFypdDraftOrder", () => {
  it("gives the 9th Brigade team pick 1", () => {
    const order = computeFypdDraftOrder(standings(), "team-rank-12");
    expect(order[0]).toEqual({ slot: 1, teamId: "team-rank-12", reason: "9th Brigade" });
  });

  it("matches the documented C&A order exactly when 9th Brigade is the 12th-place team", () => {
    const order = computeFypdDraftOrder(standings(), "team-rank-12");
    expect(order.map((o) => o.teamId)).toEqual([
      "team-rank-12", // 9th Brigade
      "team-rank-9",
      "team-rank-10",
      "team-rank-11",
      "team-rank-8",
      "team-rank-7",
      "team-rank-6",
      "team-rank-5",
      "team-rank-4",
      "team-rank-3",
      "team-rank-2",
      "team-rank-1",
    ]);
  });

  it("puts the remaining bottom-four teams in straight standings order regardless of which one is 9th Brigade", () => {
    const order = computeFypdDraftOrder(standings(), "team-rank-10");
    // 9th Brigade is the 10th-place team here; the other three non-playoff
    // teams (9th, 11th, 12th place) should still follow in straight rank order.
    expect(order.slice(0, 4).map((o) => o.teamId)).toEqual([
      "team-rank-10",
      "team-rank-9",
      "team-rank-11",
      "team-rank-12",
    ]);
  });

  it("puts the eight playoff teams in reverse standings order after the bottom four", () => {
    const order = computeFypdDraftOrder(standings(), "team-rank-12");
    expect(order.slice(4).map((o) => o.teamId)).toEqual([
      "team-rank-8",
      "team-rank-7",
      "team-rank-6",
      "team-rank-5",
      "team-rank-4",
      "team-rank-3",
      "team-rank-2",
      "team-rank-1",
    ]);
  });

  it("assigns exactly 12 unique slots", () => {
    const order = computeFypdDraftOrder(standings(), "team-rank-9");
    expect(order).toHaveLength(12);
    expect(new Set(order.map((o) => o.teamId)).size).toBe(12);
    expect(order.map((o) => o.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("rejects a 9th Brigade team that is not among the bottom four", () => {
    expect(() => computeFypdDraftOrder(standings(), "team-rank-5")).toThrow(/non-playoff/i);
  });

  it("rejects standings that are not exactly 12 teams", () => {
    const partial = standings().slice(0, 10);
    expect(() => computeFypdDraftOrder(partial, "team-rank-9")).toThrow(/12 teams/i);
  });

  it("rejects standings missing a rank", () => {
    // 12 entries, all unique ranks, but rank 7 is absent (replaced with an
    // out-of-range rank) - isolates the "missing rank" check from the
    // separate duplicate-rank check.
    const withGap = standings().map((s) => (s.rank === 7 ? { ...s, rank: 13 } : s));
    expect(() => computeFypdDraftOrder(withGap, "team-rank-12")).toThrow(/missing/i);
  });

  it("rejects standings with a duplicate rank", () => {
    const withDuplicate = standings().map((s) => (s.rank === 7 ? { ...s, rank: 1 } : s));
    expect(() => computeFypdDraftOrder(withDuplicate, "team-rank-12")).toThrow(/duplicate/i);
  });
});
