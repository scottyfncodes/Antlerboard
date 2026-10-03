/**
 * Shape checks for a trade proposal, shared by POST /api/trades and the
 * counter flow. Pure (no DB) so the rules are unit-tested directly.
 */

export const MIN_TRADE_TEAMS = 2;
export const MAX_TRADE_TEAMS = 4;

export interface TradeAssetInput {
  fromTeamId: string;
  toTeamId: string;
  assetType: "PLAYER" | "DRAFT_PICK";
  playerId?: string;
  draftPickDescription?: string;
}

export interface TradeProposalInput {
  proposingTeamId: string;
  teamIds: string[];
  assets: TradeAssetInput[];
}

/** Returns a user-facing reason the proposal is malformed, or null if it's fine. */
export function tradeProposalProblem({ proposingTeamId, teamIds, assets }: TradeProposalInput): string | null {
  const teams = [...new Set(teamIds)];
  if (teams.length !== teamIds.length) return "Each team can only be in the trade once";
  if (teams.length < MIN_TRADE_TEAMS) return "A trade needs at least two teams";
  if (teams.length > MAX_TRADE_TEAMS) return `A trade can include at most ${MAX_TRADE_TEAMS} teams`;
  if (!teams.includes(proposingTeamId)) return "Your team has to be part of the trade";
  if (!assets || assets.length === 0) return "Add at least one player or pick";

  const seenPlayers = new Set<string>();
  for (const a of assets) {
    if (!teams.includes(a.fromTeamId) || !teams.includes(a.toTeamId)) {
      return "Every player and pick must move between teams in the trade";
    }
    if (a.fromTeamId === a.toTeamId) return "A team can't trade something to itself";
    if (a.assetType === "PLAYER") {
      if (!a.playerId) return "A player asset is missing its player";
      if (seenPlayers.has(a.playerId)) return "The same player can't be traded twice in one deal";
      seenPlayers.add(a.playerId);
    } else if (a.assetType === "DRAFT_PICK") {
      if (!a.draftPickDescription?.trim()) return "Describe each draft pick (e.g. 2027 3rd round)";
    } else {
      return "Unknown asset type";
    }
  }

  // Everyone in the deal has to give or get something - otherwise they're
  // just a bystander who'd still be asked to approve it.
  const involved = new Set(assets.flatMap((a) => [a.fromTeamId, a.toTeamId]));
  const idle = teams.filter((t) => !involved.has(t));
  if (idle.length > 0) return "Every team in the trade has to send or receive something";

  return null;
}
