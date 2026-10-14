import { describe, it, expect } from "vitest";
import { signPreview, verifyPreview } from "./preview-signature";

const p = {
  players: [{ key: "1", yahooPlayerId: "1", name: "A", mlbTeam: null, positions: [], isFypdProspect: false, flags: [] }],
  events: [],
  draftPicks: [],
  keeperChecks: [],
};

describe("preview signature", () => {
  it("verifies a preview that survives the JSON round trip through the browser", () => {
    const token = signPreview(p);
    expect(verifyPreview(JSON.parse(JSON.stringify(p)), token)).toBe(true);
  });

  it("rejects an edited preview, a missing token and a garbage token", () => {
    const token = signPreview(p);
    expect(verifyPreview({ ...p, players: [{ ...p.players[0], yahooPlayerId: "2" }] }, token)).toBe(false);
    expect(verifyPreview(p, undefined)).toBe(false);
    expect(verifyPreview(p, "v1.zz")).toBe(false);
    expect(verifyPreview(p, "nope")).toBe(false);
  });
});
