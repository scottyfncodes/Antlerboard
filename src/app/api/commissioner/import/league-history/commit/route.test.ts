import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, makeManagerAndTeam, resetDatabase } from "@/lib/test-helpers";
import { signPreview } from "@/lib/import/preview-signature";
import type { LeagueHistoryPreview } from "@/lib/import/league-history-builder";

vi.mock("@/lib/current-manager", () => ({ requireCommissioner: vi.fn(), getCurrentManager: vi.fn() }));
import { requireCommissioner, getCurrentManager } from "@/lib/current-manager";
import { POST } from "./route";

beforeEach(async () => {
  await resetDatabase();
  vi.mocked(requireCommissioner).mockReset();
});
afterAll(resetDatabase);

async function setup() {
  const { league, season } = await makeLeagueWithSeason(2026);
  const { manager } = await makeManagerAndTeam(league.id, "Scott", true);
  vi.mocked(requireCommissioner).mockResolvedValue(manager as never);
  vi.mocked(getCurrentManager).mockResolvedValue(manager as never);
  return { league, season };
}

function preview(sourceRef = "yahoo:458.l.1.tr.1"): LeagueHistoryPreview {
  return {
    players: [{ key: "1", yahooPlayerId: "1", name: "Some Guy", mlbTeam: null, positions: ["OF"], isFypdProspect: false, flags: [] }],
    events: [{ playerKey: "1", kind: "ACQUIRED", season: 2025, date: "2025-04-01T00:00:00.000Z", franchise: "Scott", method: "WAIVER", cost: 5, priceStatus: "recorded", sourceRef, flags: [] }],
    draftPicks: [],
    keeperChecks: [],
    eoyChecks: [],
    unresolvedTeams: [],
    unmatchedPlayers: [],
    draftDates: {},
    summary: {
      players: 1,
      events: 1,
      flaggedEvents: 0,
      draftPicks: 0,
      seasons: [2025],
      keeperChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      eoyCostChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      eoyProjectionChecks: { match: 0, mismatch: 0, unmatched: 0, "not-computed": 0 },
      unresolvedTeamNames: 0,
      unmatchedPlayerNames: 0,
    },
    flags: [],
  };
}

const post = async (body: unknown) => {
  const res = await POST(new Request("https://antlerboard.test/api/commissioner/import/league-history/commit", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};

describe("POST /api/commissioner/import/league-history/commit", () => {
  it("refuses a preview without the signature from Build preview, writing nothing", async () => {
    await setup();
    const r = await post(preview());
    expect(r.status).toBe(400);
    expect(await prisma.acquisition.count()).toBe(0);
  });

  it("refuses a preview edited after it was signed", async () => {
    await setup();
    const p = preview();
    const token = signPreview(p);
    p.events[0].cost = 50;
    const r = await post({ ...p, previewToken: token });
    expect(r.status).toBe(400);
    expect(await prisma.acquisition.count()).toBe(0);
  });

  it("writes a signed preview", async () => {
    await setup();
    const p = preview();
    const r = await post({ ...JSON.parse(JSON.stringify(p)), previewToken: signPreview(p) });
    expect(r.status).toBe(200);
    expect(await prisma.acquisition.count()).toBe(1);
  });

  it("returns 409 with the conflicts, and writes nothing, when the preview overlaps Yahoo-synced transactions", async () => {
    const { season } = await setup();
    await prisma.transaction.create({ data: { seasonId: season.id, seasonYear: 2026, type: "DROP", yahooTransactionId: "469.l.8891.tr.4" } });
    const p = preview("yahoo:469.l.8891.tr.4");
    const r = await post({ ...p, previewToken: signPreview(p) });
    expect(r.status).toBe(409);
    expect(r.body.conflicts.length).toBeGreaterThan(0);
    expect(await prisma.acquisition.count()).toBe(0);
    expect(await prisma.player.count()).toBe(0);
  });

  it("rejects non-commissioners", async () => {
    await setup();
    vi.mocked(requireCommissioner).mockResolvedValue(null as never);
    expect((await post(preview())).status).toBe(403);
  });
});
