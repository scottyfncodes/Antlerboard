import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";
import { countDeclaredKeepers } from "./keeper-slots";
import { loadTeamRosterCosts } from "./keeper-cost-views";

// "Keepers x/N" on the Teams list and on the team page must be the same
// number: the keepers declared at the deadline, including ones since
// dropped or traded away.

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("declared keeper count", () => {
  it("Teams list and team page agree for a team with a dropped and a traded keeper", async () => {
    const { league, season } = await makeLeagueWithSeason(2026);
    const a = (await makeManagerAndTeam(league.id, "Alpha")).team;
    const b = (await makeManagerAndTeam(league.id, "Bravo")).team;

    const keep = async (name: string, k: { teamId: string; startTeamId: string | null; keeperYear: number; status?: "KEPT" | "DROPPED" | "FORCED_BACK" }) => {
      const p = await makePlayer(league.id, name);
      await prisma.keeperRecord.create({
        data: {
          seasonId: season.id,
          seasonYear: 2026,
          playerId: p.id,
          teamId: k.teamId,
          startTeamId: k.startTeamId,
          keeperYear: k.keeperYear,
          keeperCost: 10,
          yearsRemaining: 5 - k.keeperYear,
          status: k.status ?? "KEPT",
        },
      });
    };

    await keep("Held", { teamId: a.id, startTeamId: a.id, keeperYear: 2 });
    await keep("Dropped", { teamId: a.id, startTeamId: a.id, keeperYear: 1, status: "DROPPED" });
    await keep("TradedAway", { teamId: b.id, startTeamId: a.id, keeperYear: 3 });
    await keep("Pickup", { teamId: a.id, startTeamId: a.id, keeperYear: 0 }); // in-season add, no slot
    await keep("Legacy", { teamId: b.id, startTeamId: null, keeperYear: 1 });
    await keep("SixthYear", { teamId: a.id, startTeamId: a.id, keeperYear: 6, status: "FORCED_BACK" }); // back in the draft, no slot

    const counts = await countDeclaredKeepers(2026);
    const [teamA, teamB] = await Promise.all([loadTeamRosterCosts(a.id, 2026), loadTeamRosterCosts(b.id, 2026)]);

    expect(counts.get(a.id)).toBe(3);
    expect(teamA.declaredCount).toBe(counts.get(a.id));
    expect(counts.get(b.id)).toBe(1);
    expect(teamB.declaredCount).toBe(counts.get(b.id));
  });
});
