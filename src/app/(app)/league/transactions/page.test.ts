import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/db";
import { makeLeagueWithSeason, resetDatabase } from "@/lib/test-helpers";
import TransactionsPage from "./page";

beforeEach(resetDatabase);
afterAll(resetDatabase);

describe("League > Transactions page", () => {
  it("lists every row, marks Yahoo rows without detail as incomplete, and says how many there are", async () => {
    const { league, season } = await makeLeagueWithSeason(2026);
    const m = await prisma.manager.create({ data: { leagueId: league.id, name: "M" } });
    const team = await prisma.team.create({ data: { leagueId: league.id, name: "Ranger Thingz", managerId: m.id } });
    const judge = await prisma.player.create({ data: { leagueId: league.id, name: "Aaron Judge", positions: [] } });
    for (let i = 0; i < 3; i++) {
      await prisma.transaction.create({
        data: { seasonId: season.id, seasonYear: 2026, type: "FREE_AGENT_ADD", yahooTransactionId: `469.l.8891.tr.${i}`, notes: "Synced from Yahoo (add/drop)", date: new Date(`2026-05-0${i + 1}T00:00:00Z`) },
      });
    }
    await prisma.transaction.create({
      data: {
        seasonId: season.id,
        seasonYear: 2026,
        type: "WAIVER_ADD",
        yahooTransactionId: "469.l.8891.tr.9",
        yahooType: "add",
        yahooStatus: "successful",
        faabBid: 3,
        date: new Date("2026-06-01T00:00:00Z"),
        players: { create: { playerId: judge.id, action: "add", sourceType: "waivers", destinationTeamId: team.id } },
        teams: { create: { teamId: team.id, role: "TO" } },
      },
    });

    const html = renderToStaticMarkup(await TransactionsPage({}));

    expect(html.match(/data-complete="false"/g)).toHaveLength(3);
    expect(html.match(/data-complete="true"/g)).toHaveLength(1);
    expect(html).toContain("3 of the 4 transactions below");
    expect(html).toContain("(3 in all)");
    expect(html).toContain("Aaron Judge");
    expect(html).toContain("$3 FAAB");
    expect(html).toContain("Details missing - Yahoo reported &quot;add/drop&quot;");
    // The legacy rows aren't labelled as plain adds.
    expect(html.match(/>Free-agent add</g)).toBeNull();
    // Nothing was hidden or changed in the database.
    expect(await prisma.transaction.count()).toBe(4);
  });

  it("says how many rows it's showing and offers more past the first 75", async () => {
    const { season } = await makeLeagueWithSeason(2026);
    await prisma.transaction.createMany({
      data: Array.from({ length: 80 }, (_, i) => ({
        seasonId: season.id,
        seasonYear: 2026,
        type: "DROP" as const,
        date: new Date(Date.UTC(2026, 4, 1, 0, i)),
      })),
    });

    const first = renderToStaticMarkup(await TransactionsPage({}));
    expect(first.match(/data-complete=/g)).toHaveLength(75);
    expect(first).toContain("Showing 75 of 80");
    expect(first).toContain('href="/league/transactions?limit=150"');

    const more = renderToStaticMarkup(await TransactionsPage({ searchParams: Promise.resolve({ limit: "150" }) }));
    expect(more.match(/data-complete=/g)).toHaveLength(80);
    expect(more).toContain("Showing 80 of 80");
    expect(more).not.toContain("Show more");
  });
});
