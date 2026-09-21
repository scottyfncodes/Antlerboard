import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "./db";
import { setOwnPlayerTag, PlayerTagActionError } from "./player-tags";
import { makeLeagueWithSeason, makeManagerAndTeam, makePlayer, resetDatabase } from "./test-helpers";

beforeEach(resetDatabase);
afterAll(resetDatabase);

async function makeRosteredPlayer() {
  const { league, season } = await makeLeagueWithSeason();
  const { manager, team } = await makeManagerAndTeam(league.id, "Alex");
  const player = await makePlayer(league.id, "My Player");
  await prisma.keeperRecord.create({
    data: {
      seasonId: season.id,
      seasonYear: season.year,
      playerId: player.id,
      teamId: team.id,
      keeperYear: 1,
      keeperCost: 10,
      yearsRemaining: 4,
      status: "KEPT",
    },
  });
  return { manager, team, player };
}

describe("setOwnPlayerTag", () => {
  it("lets a manager tag a player on their own roster", async () => {
    const { manager, player } = await makeRosteredPlayer();

    await setOwnPlayerTag(manager.id, player.id, "OPEN_TO_DISCUSS", "Would consider the right offer");

    const tag = await prisma.playerTag.findFirstOrThrow({ where: { playerId: player.id } });
    expect(tag.tag).toBe("OPEN_TO_DISCUSS");
    expect(tag.note).toBe("Would consider the right offer");
  });

  it("upserts rather than duplicating on a second call", async () => {
    const { manager, player } = await makeRosteredPlayer();

    await setOwnPlayerTag(manager.id, player.id, "AVAILABLE");
    await setOwnPlayerTag(manager.id, player.id, "KEEPING");

    const tags = await prisma.playerTag.findMany({ where: { playerId: player.id } });
    expect(tags).toHaveLength(1);
    expect(tags[0].tag).toBe("KEEPING");
  });

  it("clears the tag when passed null", async () => {
    const { manager, player } = await makeRosteredPlayer();
    await setOwnPlayerTag(manager.id, player.id, "AVAILABLE");

    await setOwnPlayerTag(manager.id, player.id, null);

    const count = await prisma.playerTag.count({ where: { playerId: player.id } });
    expect(count).toBe(0);
  });

  it("rejects a player not on the manager's own roster", async () => {
    const { league } = await makeLeagueWithSeason();
    const { manager: otherManager } = await makeManagerAndTeam(league.id, "Someone Else");
    const player = await makePlayer(league.id, "Not Mine");

    await expect(setOwnPlayerTag(otherManager.id, player.id, "AVAILABLE")).rejects.toThrow(PlayerTagActionError);
    const count = await prisma.playerTag.count({ where: { playerId: player.id } });
    expect(count).toBe(0);
  });

  it("rejects a system-derived tag a manager should not be able to set directly", async () => {
    const { manager, player } = await makeRosteredPlayer();

    await expect(setOwnPlayerTag(manager.id, player.id, "FORCED_BACK")).rejects.toThrow(PlayerTagActionError);
    await expect(setOwnPlayerTag(manager.id, player.id, "RECENTLY_ACQUIRED")).rejects.toThrow(PlayerTagActionError);
  });
});
