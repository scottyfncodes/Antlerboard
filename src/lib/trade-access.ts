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
 * A trade can have 2-4 teams; every team in it counts as a party.
 *
 * Acting on one (accept / reject / counter / withdraw) is checked here too:
 * only the non-proposing teams can respond, only the proposer can
 * withdraw, and only while the deal is still open.
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
  if (teamIds.length > 0) or.push({ participants: { some: { teamId: { in: teamIds } } } });
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

export interface TradeAccessShape {
  proposerId: string;
  status: string;
  participants: { teamId: string; isProposer: boolean; response: string }[];
}

/** True when `viewer` is a party to the trade (and so may see its notes, respond, etc.). */
export function isTradeParty(trade: Pick<TradeAccessShape, "proposerId" | "participants">, viewer: TradeViewer | null | undefined): boolean {
  if (!viewer) return false;
  const teamIds = teamIdsOf(viewer);
  return trade.proposerId === viewer.id || trade.participants.some((p) => teamIds.includes(p.teamId));
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

type Denial = { status: 403 | 404 | 409; error: string };

/**
 * Decides whether `viewer` may perform `action` on the trade, and if so as
 * which of their teams. Non-parties get the same "not found" a missing
 * trade would, so the API doesn't confirm someone else's negotiation exists.
 */
export function resolveTradeAction(
  trade: TradeAccessShape,
  viewer: TradeViewer,
  action: TradeAction
): { teamId: string; denial?: undefined } | { denial: Denial; teamId?: undefined } {
  if (!isTradeParty(trade, viewer)) return { denial: { status: 404, error: "Trade not found" } };
  if (trade.status !== "PROPOSED") return { denial: { status: 409, error: "This trade is no longer open" } };

  const teamIds = teamIdsOf(viewer);
  const proposing = trade.participants.find((p) => p.isProposer);
  if (action === "withdraw") {
    if (trade.proposerId === viewer.id || (proposing && teamIds.includes(proposing.teamId))) {
      return { teamId: proposing?.teamId ?? "" };
    }
    return { denial: { status: 403, error: "Only the manager who proposed this trade can withdraw it" } };
  }

  const mine = trade.participants.find((p) => !p.isProposer && teamIds.includes(p.teamId));
  if (!mine) return { denial: { status: 403, error: "Only the other teams in the trade can respond to it" } };
  if (action === "accept" && mine.response === "ACCEPTED") {
    return { denial: { status: 409, error: "You've already accepted this trade" } };
  }
  return { teamId: mine.teamId };
}

/** Convenience for UI: true when `viewer` could perform `action` right now. */
export function canPerformTradeAction(trade: TradeAccessShape, viewer: TradeViewer | null | undefined, action: TradeAction) {
  return !!viewer && !resolveTradeAction(trade, viewer, action).denial;
}

export type OfferAction = "accept" | "reject" | "withdraw";

export function offerActionDenial(
  offer: { sendingTeamId: string; receivingTeamId: string; sendingManagerId: string; status: string },
  viewer: TradeViewer,
  action: OfferAction
): Denial | null {
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
