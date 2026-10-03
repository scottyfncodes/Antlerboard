/**
 * Who may see and act on trades and offers. Every page, API route and search
 * result that reads Trade/Offer rows goes through these helpers, so the rule
 * lives in exactly one place:
 *
 *   - A negotiation (proposed, countered, rejected, withdrawn, or a pending
 *     offer) is private to the teams involved in it.
 *   - Once a deal is ACCEPTED it becomes league business - the rosters have
 *     moved and it shows up in Transactions anyway - so everyone sees that it
 *     happened and what moved. Its notes/message stay private to the parties.
 *   - The commissioner gets NO exception. Being commissioner grants league
 *     admin tools, not a window into other managers' negotiations.
 *
 * Acting on one (accept / reject / counter / withdraw) is checked here too:
 * only the receiving side can respond, only the proposer can withdraw, and
 * only while the deal is still open.
 */

import type { Prisma } from "@prisma/client";

export interface TradeViewer {
  id: string;
  teams: { id: string }[];
}

function teamIdsOf(viewer: TradeViewer | null | undefined): string[] {
  return viewer?.teams.map((t) => t.id) ?? [];
}

/** Prisma filter for the Trade rows `viewer` may see. A null viewer sees only accepted trades. */
export function visibleTradesWhere(viewer: TradeViewer | null | undefined): Prisma.TradeWhereInput {
  const teamIds = teamIdsOf(viewer);
  const or: Prisma.TradeWhereInput[] = [{ status: "ACCEPTED" }];
  if (teamIds.length > 0) or.push({ teamAId: { in: teamIds } }, { teamBId: { in: teamIds } });
  if (viewer) or.push({ proposerId: viewer.id });
  return { OR: or };
}

/** Prisma filter for the Offer rows `viewer` may see. A null viewer sees only accepted offers. */
export function visibleOffersWhere(viewer: TradeViewer | null | undefined): Prisma.OfferWhereInput {
  const teamIds = teamIdsOf(viewer);
  const or: Prisma.OfferWhereInput[] = [{ status: "ACCEPTED" }];
  if (teamIds.length > 0) or.push({ sendingTeamId: { in: teamIds } }, { receivingTeamId: { in: teamIds } });
  if (viewer) or.push({ sendingManagerId: viewer.id });
  return { OR: or };
}

/** True when `viewer` is a party to the trade (and so may see its notes, respond, etc.). */
export function isTradeParty(
  trade: { teamAId: string; teamBId: string; proposerId: string },
  viewer: TradeViewer | null | undefined
): boolean {
  if (!viewer) return false;
  const teamIds = teamIdsOf(viewer);
  return trade.proposerId === viewer.id || teamIds.includes(trade.teamAId) || teamIds.includes(trade.teamBId);
}

export function isOfferParty(
  offer: { sendingTeamId: string; receivingTeamId: string; sendingManagerId: string },
  viewer: TradeViewer | null | undefined
): boolean {
  if (!viewer) return false;
  const teamIds = teamIdsOf(viewer);
  return (
    offer.sendingManagerId === viewer.id || teamIds.includes(offer.sendingTeamId) || teamIds.includes(offer.receivingTeamId)
  );
}

export type TradeAction = "accept" | "reject" | "counter" | "withdraw";

/**
 * Returns null when `viewer` may perform `action` on the trade, or the reason
 * they may not. Non-parties get the same "not found" a missing trade would,
 * so the API doesn't confirm that someone else's negotiation exists.
 */
export function tradeActionDenial(
  trade: { teamAId: string; teamBId: string; proposerId: string; status: string },
  viewer: TradeViewer,
  action: TradeAction
): { status: 403 | 404 | 409; error: string } | null {
  if (!isTradeParty(trade, viewer)) return { status: 404, error: "Trade not found" };
  if (trade.status !== "PROPOSED") return { status: 409, error: "This trade is no longer open" };

  const isProposer = trade.proposerId === viewer.id;
  if (action === "withdraw") {
    return isProposer ? null : { status: 403, error: "Only the manager who proposed this trade can withdraw it" };
  }
  const teamIds = teamIdsOf(viewer);
  const onEitherSide = teamIds.includes(trade.teamAId) || teamIds.includes(trade.teamBId);
  if (isProposer || !onEitherSide) return { status: 403, error: "Only the other team can respond to this trade" };
  return null;
}

export type OfferAction = "accept" | "reject" | "withdraw";

export function offerActionDenial(
  offer: { sendingTeamId: string; receivingTeamId: string; sendingManagerId: string; status: string },
  viewer: TradeViewer,
  action: OfferAction
): { status: 403 | 404 | 409; error: string } | null {
  if (!isOfferParty(offer, viewer)) return { status: 404, error: "Offer not found" };
  if (offer.status !== "PENDING") return { status: 409, error: "This offer is no longer open" };

  const teamIds = teamIdsOf(viewer);
  if (action === "withdraw") {
    return offer.sendingManagerId === viewer.id || teamIds.includes(offer.sendingTeamId)
      ? null
      : { status: 403, error: "Only the team that sent this offer can withdraw it" };
  }
  return teamIds.includes(offer.receivingTeamId)
    ? null
    : { status: 403, error: "Only the team that received this offer can respond to it" };
}
