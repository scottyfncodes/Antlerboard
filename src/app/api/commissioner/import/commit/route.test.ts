import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn(), getCurrentManager: vi.fn() }));

import { requireCommissioner } from "@/lib/current-manager";
import { POST } from "./route";

const mockedRequireCommissioner = vi.mocked(requireCommissioner);

beforeEach(async () => {
  await resetDatabase();
  mockedRequireCommissioner.mockReset();
});
afterAll(resetDatabase);

/**
 * Two leagues. The "other" league is created FIRST, so the old
 * league.findFirst() would have picked it; the commissioner belongs to the
 * second ("mine").
 */
async function setup() {
  const other = await makeLeagueWithSeason(2025);
  const outsider = await makeManagerAndTeam(other.league.id, "Outsider");
  const foreignPlayer = await prisma.player.create({ data: { leagueId: other.league.id, name: "Foreign Guy" } });

  const mine = await makeLeagueWithSeason(2025);
  const commish = await makeManagerAndTeam(mine.league.id, "Scott", true);
  const hugo = await makeManagerAndTeam(mine.league.id, "Hugo");
  const myPlayer = await prisma.player.create({ data: { leagueId: mine.league.id, name: "Nick Kurtz" } });
  mockedRequireCommissioner.mockResolvedValue(commish.manager as Awaited<ReturnType<typeof requireCommissioner>>);

  return {
    mine: mine.league,
    other: other.league,
    myTeam: hugo.team,
    foreignTeam: outsider.team,
    myPlayer,
    foreignPlayer,
  };
}

const row = (o: Record<string, unknown>) => ({ season: 2025, method: "DRAFT", cost: 5, playerName: "Someone New", ...o });
const commit = async (rows: unknown[]) => {
  const res = await POST(new Request("https://antlerboard.test/api/commissioner/import/commit", { method: "POST", body: JSON.stringify({ rows }) }));
  return { status: res.status, body: await res.json() };
};

/** Every table the commit route can write. */
const writeCounts = async () => ({
  acquisitions: await prisma.acquisition.count(),
  players: await prisma.player.count(),
  seasons: await prisma.season.count(),
  audit: await prisma.auditLogEntry.count(),
  keepers: await prisma.keeperRecord.count(),
});

describe("POST /api/commissioner/import/commit - valid imports", () => {
  it("imports into the commissioner's own league, not the first league in the database", async () => {
    const { mine, other, myTeam, myPlayer } = await setup();

    const { status, body } = await commit([
      row({ teamId: myTeam.id, playerName: "Brand New", mlbTeam: "NYY", positions: "OF/1B" }),
      row({ teamId: myTeam.id, playerName: "Nick Kurtz", existingPlayerId: myPlayer.id, season: 2026 }),
    ]);

    expect(status).toBe(200);
    expect(body).toEqual({ imported: 2, skipped: 0 });
    const created = await prisma.player.findFirstOrThrow({ where: { name: "Brand New" } });
    expect(created.leagueId).toBe(mine.id);
    expect(created.positions).toEqual(["OF", "1B"]);
    const acqs = await prisma.acquisition.findMany({ include: { season: true }, orderBy: { seasonYear: "asc" } });
    expect(acqs.map((a) => [a.playerId, a.teamId, a.season.leagueId, a.seasonYear])).toEqual([
      [created.id, myTeam.id, mine.id, 2025],
      [myPlayer.id, myTeam.id, mine.id, 2026],
    ]);
    // The 2026 season was created in the commissioner's league only.
    expect(await prisma.season.count({ where: { leagueId: mine.id, year: 2026 } })).toBe(1);
    expect(await prisma.season.count({ where: { leagueId: other.id, year: 2026 } })).toBe(0);
    expect((await prisma.auditLogEntry.findFirstOrThrow()).actorName).toBe("Scott");
  });

  it("keeps skipping unforced conflicts and incomplete rows", async () => {
    const { myTeam } = await setup();

    const { status, body } = await commit([
      row({ teamId: myTeam.id, conflict: "already has one", force: false }),
      row({ teamId: myTeam.id, playerName: "" }),
      row({ teamId: myTeam.id, playerName: "Forced", conflict: "already has one", force: true }),
    ]);

    expect(status).toBe(200);
    expect(body).toEqual({ imported: 1, skipped: 2 });
  });

  it("refuses a non-commissioner", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    expect((await commit([])).status).toBe(403);
  });
});

describe("POST /api/commissioner/import/commit - rejects ids outside the league before any write", () => {
  it("rejects a foreign-league teamId and writes nothing", async () => {
    const { foreignTeam } = await setup();
    const before = await writeCounts();

    const { status, body } = await commit([row({ teamId: foreignTeam.id })]);

    expect(status).toBe(400);
    expect(body.imported).toBe(0);
    expect(body.invalidRows).toEqual([{ index: 0, playerName: "Someone New", reasons: ["team is not in this league"] }]);
    expect(await writeCounts()).toEqual(before);
  });

  it("rejects a foreign-league existingPlayerId and writes nothing", async () => {
    const { myTeam, foreignPlayer } = await setup();
    const before = await writeCounts();

    const { status, body } = await commit([row({ teamId: myTeam.id, playerName: "Foreign Guy", existingPlayerId: foreignPlayer.id })]);

    expect(status).toBe(400);
    expect(body.invalidRows[0].reasons).toEqual(["player is not in this league"]);
    expect(await writeCounts()).toEqual(before);
  });

  it("rejects tampered ids - unknown strings and non-string values", async () => {
    const { myTeam } = await setup();
    const before = await writeCounts();

    const { status, body } = await commit([
      row({ teamId: "not-a-real-team" }),
      row({ teamId: myTeam.id, existingPlayerId: "not-a-real-player" }),
      row({ teamId: { id: myTeam.id } }),
      row({ teamId: myTeam.id, existingPlayerId: 12345 }),
    ]);

    expect(status).toBe(400);
    expect(body.invalidRows.map((r: { index: number }) => r.index)).toEqual([0, 1, 2, 3]);
    expect(await writeCounts()).toEqual(before);
  });

  it("rejects the whole batch when one row is bad - valid rows are not imported around it", async () => {
    const { myTeam, foreignTeam } = await setup();
    const before = await writeCounts();

    const { status, body } = await commit([
      row({ teamId: myTeam.id, playerName: "Good One" }),
      row({ teamId: foreignTeam.id, playerName: "Bad One" }),
      row({ teamId: myTeam.id, playerName: "Good Two" }),
    ]);

    expect(status).toBe(400);
    expect(body).toMatchObject({ imported: 0, skipped: 3 });
    expect(body.error).toContain("Nothing was imported");
    expect(body.invalidRows.map((r: { index: number }) => r.index)).toEqual([1]);
    expect(await writeCounts()).toEqual(before);
  });
});
