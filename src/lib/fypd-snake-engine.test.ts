import { describe, it, expect } from "vitest";
import { getSnakeSlot, getTeamOnClock, buildSnakeSequence } from "./fypd-snake-engine";

const ORDER = Array.from({ length: 12 }, (_, i) => `team-${i + 1}`); // team-1 picks first

describe("getSnakeSlot", () => {
  it("round 1 goes in order: pick 1 is order index 0, pick 12 is order index 11", () => {
    expect(getSnakeSlot(1, 12)).toMatchObject({ round: 1, pickInRound: 1, orderIndex: 0 });
    expect(getSnakeSlot(12, 12)).toMatchObject({ round: 1, pickInRound: 12, orderIndex: 11 });
  });

  it("round 2 reverses: pick 13 is order index 11, pick 24 is order index 0", () => {
    expect(getSnakeSlot(13, 12)).toMatchObject({ round: 2, pickInRound: 1, orderIndex: 11 });
    expect(getSnakeSlot(24, 12)).toMatchObject({ round: 2, pickInRound: 12, orderIndex: 0 });
  });

  it("round 3 goes back in order, matching round 1", () => {
    expect(getSnakeSlot(25, 12)).toMatchObject({ round: 3, pickInRound: 1, orderIndex: 0 });
    expect(getSnakeSlot(36, 12)).toMatchObject({ round: 3, pickInRound: 12, orderIndex: 11 });
  });

  it("rejects an overall pick below 1", () => {
    expect(() => getSnakeSlot(0, 12)).toThrow();
  });
});

describe("getTeamOnClock", () => {
  it("matches the documented C&A snake progression: R1 1->12, R2 12->1, R3 1->12", () => {
    expect(getTeamOnClock(ORDER, 1)).toBe("team-1");
    expect(getTeamOnClock(ORDER, 12)).toBe("team-12");
    expect(getTeamOnClock(ORDER, 13)).toBe("team-12");
    expect(getTeamOnClock(ORDER, 24)).toBe("team-1");
    expect(getTeamOnClock(ORDER, 25)).toBe("team-1");
    expect(getTeamOnClock(ORDER, 36)).toBe("team-12");
  });
});

describe("buildSnakeSequence", () => {
  it("produces teamCount * rounds picks with the correct round/pickInRound pairing", () => {
    const sequence = buildSnakeSequence(ORDER, 3);
    expect(sequence).toHaveLength(36);
    expect(sequence[0]).toEqual({ overallPick: 1, round: 1, pickInRound: 1, teamId: "team-1" });
    expect(sequence[11]).toEqual({ overallPick: 12, round: 1, pickInRound: 12, teamId: "team-12" });
    expect(sequence[12]).toEqual({ overallPick: 13, round: 2, pickInRound: 1, teamId: "team-12" });
    expect(sequence[35]).toEqual({ overallPick: 36, round: 3, pickInRound: 12, teamId: "team-12" });
  });

  it("works for a smaller league too", () => {
    const smallOrder = ["a", "b", "c", "d"];
    const sequence = buildSnakeSequence(smallOrder, 2);
    expect(sequence.map((s) => s.teamId)).toEqual(["a", "b", "c", "d", "d", "c", "b", "a"]);
  });
});
