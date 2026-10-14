import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({ getCurrentManager: vi.fn().mockResolvedValue(null) }));

import { GET } from "./route";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function search(q: string) {
  const res = await GET(new NextRequest(`http://localhost/api/search?q=${encodeURIComponent(q)}`));
  return (await res.json()) as { players: { name: string; team: string | null; keeperSeason: number | null; cost: { text: string; confirmed: boolean } | null }[] };
}

describe("GET /api/search player keeper costs", () => {
  it("returns the checked cost label, never the raw stored keeper cost", async () => {
    const { league, season } = await makeLeagueWithSeason(2026);
    const s2024 = await prisma.season.create({ data: { leagueId: league.id, year: 2024, status: "COMPLETE" } });
    const team = (await makeManagerAndTeam(league.id, "Alpha")).team;
    const rec = (playerId: string, o: { keeperYear: number; keeperCost: number; status?: "KEPT" | "FORCED_BACK"; seasonId?: string; seasonYear?: number }) =>
      prisma.keeperRecord.create({
        data: {
          seasonId: o.seasonId ?? season.id,
          seasonYear: o.seasonYear ?? 2026,
          playerId,
          teamId: team.id,
          startTeamId: team.id,
          keeperYear: o.keeperYear,
          keeperCost: o.keeperCost,
          yearsRemaining: 3,
          status: o.status ?? "KEPT",
        },
      });

    const confirmed = await makePlayer(league.id, "Zed Confirmed");
    await prisma.acquisition.create({
      data: { seasonId: s2024.id, seasonYear: 2024, playerId: confirmed.id, teamId: team.id, method: "DRAFT", cost: 10, sourceRef: "league-history:x|price=recorded" },
    });
    await rec(confirmed.id, { keeperYear: 2, keeperCost: 14 });

    const guessed = await makePlayer(league.id, "Zed Guessed");
    await prisma.acquisition.create({
      data: { seasonId: s2024.id, seasonYear: 2024, playerId: guessed.id, teamId: team.id, method: "DRAFT", cost: 15, sourceRef: "league-history:x|price=inferred" },
    });
    await rec(guessed.id, { keeperYear: 2, keeperCost: 19 });

    const forced = await makePlayer(league.id, "Zed Forced");
    await rec(forced.id, { keeperYear: 6, keeperCost: 0, status: "FORCED_BACK" });

    const old = await makePlayer(league.id, "Zed Old");
    await rec(old.id, { keeperYear: 1, keeperCost: 8, seasonId: s2024.id, seasonYear: 2024 });

    await makePlayer(league.id, "Zed Unrostered");

    const { players } = await search("Zed");
    const byName = Object.fromEntries(players.map((p) => [p.name, p]));
    expect(byName["Zed Confirmed"]).toMatchObject({ team: "Alpha's Team", keeperSeason: null, cost: { text: "$14", confirmed: true } });
    expect(byName["Zed Guessed"].cost).toMatchObject({ text: "Unavailable", confirmed: false });
    expect(byName["Zed Forced"].cost).toMatchObject({ text: "None", confirmed: false });
    // An earlier season's record says which season it is.
    expect(byName["Zed Old"]).toMatchObject({ keeperSeason: 2024, cost: { text: "Unavailable" } });
    expect(byName["Zed Unrostered"]).toMatchObject({ team: null, cost: null });
    expect(players.every((p) => !("keeperCost" in p))).toBe(true);
  });
});
