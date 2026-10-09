import { describe, it, expect } from "vitest";
import { tradeProposalProblem } from "./trade-proposal";

const player = (from: string, to: string, playerId = `${from}-${to}`) => ({ fromTeamId: from, toTeamId: to, assetType: "PLAYER" as const, playerId });
const pick = (from: string, to: string, d = "2027 1st") => ({ fromTeamId: from, toTeamId: to, assetType: "DRAFT_PICK" as const, draftPickDescription: d });

describe("tradeProposalProblem", () => {
  it("accepts a normal two-team swap and a three-team rotation", () => {
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [player("a", "b"), player("b", "a")] })).toBeNull();
    expect(
      tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b", "c"], assets: [player("a", "b"), player("b", "c"), pick("c", "a")] })
    ).toBeNull();
  });

  it("enforces 2-4 distinct teams including your own", () => {
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a"], assets: [] })).toMatch(/at least two/);
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b", "c", "d", "e"], assets: [player("a", "b")] })).toMatch(/at most 4/);
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b", "b"], assets: [player("a", "b")] })).toMatch(/only be in the trade once/);
    expect(tradeProposalProblem({ proposingTeamId: "x", teamIds: ["a", "b"], assets: [player("a", "b")] })).toMatch(/Your team/);
  });

  it("requires every asset to move between teams in the deal", () => {
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [player("a", "z")] })).toMatch(/between teams/);
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [player("a", "a")] })).toMatch(/to itself/);
  });

  it("rejects duplicate players, blank picks and bystander teams", () => {
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [player("a", "b", "p1"), player("a", "b", "p1")] })).toMatch(/twice/);
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [pick("a", "b", "  ")] })).toMatch(/Describe/);
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b", "c"], assets: [player("a", "b")] })).toMatch(/send or receive/);
  });

  it("needs at least one asset", () => {
    expect(tradeProposalProblem({ proposingTeamId: "a", teamIds: ["a", "b"], assets: [] })).toMatch(/at least one/);
  });
});
