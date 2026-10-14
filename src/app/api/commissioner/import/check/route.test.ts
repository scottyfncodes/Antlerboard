import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn() }));

import { requireCommissioner } from "@/lib/current-manager";
import { POST } from "./route";

const mockedRequireCommissioner = vi.mocked(requireCommissioner);

beforeEach(async () => {
  await resetDatabase();
  mockedRequireCommissioner.mockReset();
});
afterAll(resetDatabase);

async function setup() {
  const { league } = await makeLeagueWithSeason();
  const andrew = await makeManagerAndTeam(league.id, "Andrew", true);
  await prisma.team.update({ where: { id: andrew.team.id }, data: { name: "Killer B’s FC", yahooTeamId: "469.l.8891.t.5" } });
  const hugo = await makeManagerAndTeam(league.id, "Hugo");
  await prisma.team.update({ where: { id: hugo.team.id }, data: { name: "JUICED BALLZ 🧃" } });
  mockedRequireCommissioner.mockResolvedValue(andrew.manager as Awaited<ReturnType<typeof requireCommissioner>>);
  return { league, andrewTeam: andrew.team, hugoTeam: hugo.team };
}

const row = (teamName: string) => ({ playerName: "Nick Kurtz", teamName, season: "2026", method: "DRAFT", cost: "5" });
const check = async (rows: unknown[]) =>
  (await (await POST(new Request("https://antlerboard.test/api/commissioner/import/check", { method: "POST", body: JSON.stringify({ rows }) }))).json()).rows;

describe("POST /api/commissioner/import/check - team matching", () => {
  it("resolves renamed, punctuated and emoji team names and keeps the response shape", async () => {
    const { andrewTeam, hugoTeam } = await setup();

    const rows = await check([row("Killer B's FC"), row("  juiced ballz "), row("469.l.8891.t.5"), row("Hugo")]);

    expect(rows.map((r: { teamId?: string }) => r.teamId)).toEqual([andrewTeam.id, hugoTeam.id, andrewTeam.id, hugoTeam.id]);
    expect(rows.every((r: { errors: string[] }) => r.errors.length === 0)).toBe(true);
    expect(rows[0].parsed).toEqual({ playerName: "Nick Kurtz", teamName: "Killer B's FC", season: 2026, method: "DRAFT", cost: 5 });
  });

  it("keeps the existing errors for unknown and missing team names", async () => {
    await setup();

    const rows = await check([row("Ranger Things"), { ...row(""), teamName: undefined }]);

    expect(rows[0].teamId).toBeUndefined();
    expect(rows[0].errors).toEqual(['Unknown C&A team "Ranger Things"']);
    expect(rows[1].errors).toContain("Missing team name");
  });

  it("only matches teams in the commissioner's own league", async () => {
    await setup();
    const other = await prisma.league.create({ data: { name: "Other League", abbreviation: "OL" } });
    await makeManagerAndTeam(other.id, "Stranger");
    await prisma.team.updateMany({ where: { leagueId: other.id }, data: { name: "Outsiders" } });

    const rows = await check([row("Outsiders"), row("Stranger")]);

    expect(rows.map((r: { teamId?: string }) => r.teamId)).toEqual([undefined, undefined]);
    expect(rows[0].errors).toEqual(['Unknown C&A team "Outsiders"']);
  });

  it("reports an ambiguous team instead of picking one", async () => {
    const { league } = await setup();
    const zach = await makeManagerAndTeam(league.id, "Zach");
    await prisma.team.update({ where: { id: zach.team.id }, data: { name: "Killer Bs FC" } });

    const rows = await check([row("Killer B's FC")]);

    expect(rows[0].teamId).toBeUndefined();
    expect(rows[0].errors[0]).toContain("is ambiguous");
  });

  it("refuses a non-commissioner", async () => {
    mockedRequireCommissioner.mockResolvedValueOnce(null);
    const res = await POST(new Request("https://antlerboard.test/api/commissioner/import/check", { method: "POST", body: JSON.stringify({ rows: [] }) }));
    expect(res.status).toBe(403);
  });
});
