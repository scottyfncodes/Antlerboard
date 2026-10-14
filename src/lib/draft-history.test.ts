import { describe, it, expect } from "vitest";
import {
  auctionCompleteness,
  buildAuctionHistory,
  buildFypdHistory,
  filterDraftPicks,
  isInferredOrder,
  validateFypdOrder,
  type AuctionPickInput,
  type FypdDraftInput,
  type FypdSelectionInput,
} from "./draft-history";
import { getSnakeSlot } from "./fypd-snake-engine";

const TEAMS = Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, name: `Team ${i + 1}` }));
const order = TEAMS.map((team, i) => ({ slot: i + 1, team }));

function snakeOwner(overallPick: number) {
  return TEAMS[getSnakeSlot(overallPick, 12).orderIndex];
}

function sel(overallPick: number, team = snakeOwner(overallPick)): FypdSelectionInput {
  const slot = getSnakeSlot(overallPick, 12);
  return {
    id: `s${overallPick}`,
    round: slot.round,
    pickInRound: slot.pickInRound,
    overallPick,
    team,
    player: { id: `p${overallPick}`, name: `Prospect ${overallPick}`, mlbTeam: "SEA", positions: ["SS"] },
    notes: null,
  };
}

function draft(selections: FypdSelectionInput[], overrides: Partial<FypdDraftInput> = {}): FypdDraftInput {
  return { year: 2025, rounds: 5, order, selections, ...overrides };
}

describe("FYPD completeness", () => {
  it("reports an empty draft as having no data, not complete", () => {
    const h = buildFypdHistory(draft([]));
    expect(h.completeness.status).toBe("none");
    expect(h.completeness.expected).toBe(60);
    expect(h.picks).toEqual([]);
  });

  it("reports a full 60-pick draft as complete", () => {
    const h = buildFypdHistory(draft(Array.from({ length: 60 }, (_, i) => sel(i + 1))));
    expect(h.completeness).toMatchObject({ status: "complete", recorded: 60, expected: 60 });
  });

  it("flags a partial draft (53 of 60) as incomplete with the shortfall", () => {
    const h = buildFypdHistory(draft(Array.from({ length: 53 }, (_, i) => sel(i + 1))));
    expect(h.completeness).toMatchObject({ status: "incomplete", recorded: 53, expected: 60, missing: 7 });
    expect(h.completeness.note).toContain("53 of 60 picks recorded");
  });

  it("can't calculate an expected total without a draft order", () => {
    const h = buildFypdHistory(draft([sel(1)], { order: [] }));
    expect(h.completeness.status).toBe("incomplete");
    expect(h.completeness.expected).toBeNull();
    expect(h.picks[0].originalSlot.status).toBe("unknown");
  });

  it("rejects a draft order with gaps or repeated teams", () => {
    expect(validateFypdOrder([{ slot: 1, team: TEAMS[0] }, { slot: 3, team: TEAMS[1] }]).teams).toBeNull();
    expect(validateFypdOrder([{ slot: 1, team: TEAMS[0] }, { slot: 2, team: TEAMS[0] }]).teams).toBeNull();
  });

  it("counts picks numbered beyond the draft's slots as not completing it", () => {
    const sels = Array.from({ length: 59 }, (_, i) => sel(i + 1));
    sels.push({ ...sel(60), id: "stray", overallPick: 61 });
    const h = buildFypdHistory(draft(sels));
    expect(h.completeness.status).toBe("incomplete");
    expect(h.completeness.note).toContain("numbered beyond");
  });

  it("never double-counts duplicate selections at one pick number", () => {
    const sels = Array.from({ length: 60 }, (_, i) => sel(i + 1));
    sels.push({ ...sel(5), id: "dupe" });
    const h = buildFypdHistory(draft(sels));
    expect(h.completeness).toMatchObject({ status: "complete", recorded: 60 });
    expect(h.notes.join(" ")).toContain("recorded more than once");
    const dupes = h.picks.filter((p) => p.overallPick === 5);
    expect(dupes).toHaveLength(2);
    for (const p of dupes) expect(p.originalSlot.status).toBe("unknown");
  });
});

describe("FYPD original slot", () => {
  it("shows the snake-order slot owner for every pick of a complete draft", () => {
    const h = buildFypdHistory(draft(Array.from({ length: 60 }, (_, i) => sel(i + 1))));
    for (const p of h.picks) {
      expect(p.originalSlot).toEqual({ status: "known", team: snakeOwner(p.overallPick), differsFromSelector: false });
    }
  });

  it("marks a traded pick in a complete draft: original slot differs from the selecting team", () => {
    // Pick 14 (round 2, reversed) belongs to slot 11; team 3 made it.
    const sels = Array.from({ length: 60 }, (_, i) => sel(i + 1));
    sels[13] = sel(14, TEAMS[2]);
    const h = buildFypdHistory(draft(sels));
    const p = h.picks.find((x) => x.overallPick === 14)!;
    expect(p.team.id).toBe("t3");
    expect(p.originalSlot).toEqual({ status: "known", team: TEAMS[10], differsFromSelector: true });
  });

  it("stops trusting pick numbers after the first renumbering mismatch in an incomplete draft (the 2025 pattern)", () => {
    // Picks 1-38 match the snake. Then the slot-39 team passed and every
    // later pick was renumbered down by one: pick 39 is really slot 40's.
    const sels = Array.from({ length: 38 }, (_, i) => sel(i + 1));
    for (let n = 39; n <= 53; n++) sels.push(sel(n, snakeOwner(n + 1)));
    const h = buildFypdHistory(draft(sels));
    expect(h.completeness.status).toBe("incomplete");
    for (const p of h.picks) {
      if (p.overallPick <= 38) expect(p.originalSlot.status).toBe("known");
      else expect(p.originalSlot.status).toBe("unknown");
    }
    expect(h.notes.join(" ")).toContain("through pick #38");
  });

  it("stops trusting pick numbers at the first gap in an incomplete draft", () => {
    const sels = Array.from({ length: 60 }, (_, i) => sel(i + 1)).filter((s) => s.overallPick !== 20);
    const h = buildFypdHistory(draft(sels));
    expect(h.picks.find((p) => p.overallPick === 19)!.originalSlot.status).toBe("known");
    expect(h.picks.find((p) => p.overallPick === 21)!.originalSlot.status).toBe("unknown");
  });

  it("never treats the selecting team as the slot owner when the stored round/pick disagree with the overall number", () => {
    const sels = Array.from({ length: 60 }, (_, i) => sel(i + 1));
    sels[0] = { ...sels[0], round: 2 };
    const h = buildFypdHistory(draft(sels));
    expect(h.picks[0].originalSlot.status).toBe("unknown");
  });

  it("ignores FypdDraft status: data decides completeness", () => {
    // buildFypdHistory takes no status at all - a draft marked COMPLETE
    // with 53 picks is still incomplete.
    const h = buildFypdHistory(draft(Array.from({ length: 53 }, (_, i) => sel(i + 1))));
    expect(h.completeness.status).toBe("incomplete");
  });
});

describe("auction history", () => {
  const team = TEAMS[0];
  const pick = (overallPick: number, overrides: Partial<AuctionPickInput> = {}): AuctionPickInput => ({
    id: `d${overallPick}`,
    round: 1,
    pick: overallPick,
    overallPick,
    cost: 10,
    isKeeperSlot: false,
    team,
    player: { id: `p${overallPick}`, name: `Player ${overallPick}`, mlbTeam: "NYY", positions: ["OF"] },
    ...overrides,
  });

  it("reports no data for an empty auction", () => {
    expect(auctionCompleteness([]).status).toBe("none");
    expect(buildAuctionHistory(2026, []).picks).toEqual([]);
  });

  it("can't verify an auction's total, even with contiguous nominations", () => {
    const c = auctionCompleteness([pick(1), pick(2), pick(3)]);
    expect(c.status).toBe("unverified");
    expect(c.expected).toBeNull();
  });

  it("flags gaps in nomination numbers as incomplete", () => {
    const c = auctionCompleteness([pick(1), pick(2), pick(5)]);
    expect(c).toMatchObject({ status: "incomplete", missing: 2 });
  });

  it("keeps a missing price as null, never $0, and flags it", () => {
    const h = buildAuctionHistory(2026, [pick(1, { cost: null })]);
    expect(h.picks[0].cost).toBeNull();
    expect(h.picks[0].flags).toContain("Price not recorded.");
    expect(h.notes.join(" ")).toContain("no recorded price");
  });

  it("flags a player recorded twice in one auction", () => {
    const dupePlayer = { id: "same", name: "Same Guy", mlbTeam: null, positions: [] };
    const h = buildAuctionHistory(2026, [pick(1, { player: dupePlayer }), pick(2, { player: dupePlayer })]);
    expect(h.picks.every((p) => p.flags.some((f) => f.includes("more than once")))).toBe(true);
  });

  it("never offers an original slot for an auction", () => {
    const h = buildAuctionHistory(2026, [pick(1)]);
    expect(h.picks[0].originalSlot.status).toBe("not-applicable");
  });
});

describe("filterDraftPicks", () => {
  const sels = Array.from({ length: 60 }, (_, i) => sel(i + 1));
  sels[13] = sel(14, TEAMS[2]);
  const h = buildFypdHistory(draft(sels));

  it("matches the team filter on the selecting team or a known original slot owner", () => {
    const t11 = filterDraftPicks(h.picks, { teamId: "t11" });
    expect(t11.map((p) => p.overallPick)).toContain(14);
    expect(t11.every((p) => p.team.id === "t11" || (p.originalSlot.status === "known" && p.originalSlot.team.id === "t11"))).toBe(true);
  });

  it("searches player, MLB team and fantasy team names case-insensitively", () => {
    expect(filterDraftPicks(h.picks, { q: "prospect 42" }).map((p) => p.overallPick)).toEqual([42]);
    expect(filterDraftPicks(h.picks, { q: "team 3" }).length).toBeGreaterThan(0);
    expect(filterDraftPicks(h.picks, { q: "nobody" })).toEqual([]);
  });
});

describe("auction nomination-order provenance", () => {
  const team = { id: "t1", name: "Team 1" };
  const pick = (n: number, sourceRef: string | null): AuctionPickInput => ({
    id: `d${n}`,
    round: 1,
    pick: n,
    overallPick: n,
    cost: 5,
    isKeeperSlot: false,
    team,
    player: { id: `p${n}`, name: `Player ${n}`, mlbTeam: null, positions: [] },
    sourceRef,
  });

  it("never presents workbook row order as nomination order", () => {
    const h = buildAuctionHistory(2024, [pick(1, "league-history:Scott 2024 draft|order=sheet"), pick(2, "league-history:Scott 2024 draft|order=sheet")]);
    expect(h.picks.map((p) => p.order)).toEqual(["sheet", "sheet"]);
    expect(h.completeness.status).toBe("unverified");
    expect(h.completeness.note).toMatch(/nomination order isn't recorded/);
    expect(h.notes.join(" ")).toMatch(/row numbers, not nominations/);
  });

  it("treats an older untagged import row as unknown order, not as verified", () => {
    const h = buildAuctionHistory(2024, [pick(1, "league-history:A1")]);
    expect(h.picks[0].order).toBe("unknown");
    expect(isInferredOrder(h.picks[0].order)).toBe(true);
  });

  it("keeps the source file's own pick numbers as nomination order, with gap detection", () => {
    const h = buildAuctionHistory(2023, [pick(1, "league-history:A1|order=source"), pick(3, "league-history:A3|order=source")]);
    expect(h.picks.every((p) => p.order === "source")).toBe(true);
    expect(h.completeness).toMatchObject({ status: "incomplete", missing: 1 });
    expect(h.notes.join(" ")).not.toMatch(/row order/);
  });

  it("treats hand-entered picks (no provenance) as entered order", () => {
    expect(buildAuctionHistory(2026, [pick(1, null)]).picks[0].order).toBe("entered");
  });

  it("flags a mix of verified and row-order numbering", () => {
    const h = buildAuctionHistory(2024, [pick(1, "league-history:A1|order=source"), pick(2, "league-history:B|order=sheet")]);
    expect(h.completeness.status).toBe("unverified");
    expect(h.notes.join(" ")).toMatch(/^1 pick is numbered by workbook row order|1 pick is numbered/);
  });

  it("marks every FYPD pick as source order", () => {
    const fypd = buildFypdHistory(draft([sel(1)]));
    expect(fypd.picks[0].order).toBe("source");
  });
});
