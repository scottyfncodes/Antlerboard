/**
 * How a Transaction row is described to managers.
 *
 * Every row is shown - nothing is filtered out, so counts stay true - but a
 * row is only presented as a fully described move when its data supports
 * it. A Yahoo-synced row without its team and player detail (the 907 rows
 * synced before detailed ingestion, or a newer row Yahoo couldn't fully
 * resolve) is marked incomplete and says what's missing instead of looking
 * like an ordinary "Added" with nothing after it.
 *
 * League-history "not kept" releases are synthetic: the import records a
 * player not kept into the next season as a drop dated the season's end.
 * Their dates are left as stored; the label says what they are.
 */

import type { Transaction, TransactionPlayer, TransactionTeam } from "@prisma/client";
import { YAHOO_SUCCESSFUL } from "@/lib/yahoo/transactions";

export type DisplayTransaction = Pick<
  Transaction,
  "type" | "notes" | "yahooTransactionId" | "yahooType" | "yahooStatus" | "faabBid" | "dateUnavailable" | "yahooDetailIssues" | "sourceRef"
> & {
  players: (Pick<TransactionPlayer, "playerId" | "action" | "sourceTeamId" | "destinationTeamId"> & { player: { name: string } })[];
  teams: Pick<TransactionTeam, "teamId" | "role">[];
};

export interface DisplayMove {
  verb: "Added" | "Dropped" | "Traded" | null;
  playerId: string;
  name: string;
  /** The team the player joined (adds, trades) or left (drops), when known. */
  teamName: string | null;
}

export interface TransactionDisplay {
  label: string;
  /** Icon/tone key: a TransactionType, or INCOMPLETE / RELEASE. */
  iconKey: string;
  complete: boolean;
  moves: DisplayMove[];
  teamNames: string[];
  /** Short qualifiers shown next to the move: FAAB, status, date caveats, what's missing. */
  notes: string[];
  /** One line for compact lists. */
  summary: string;
}

const TYPE_LABELS: Record<string, string> = {
  DRAFT: "Drafted",
  WAIVER_ADD: "Waiver add",
  FREE_AGENT_ADD: "Free-agent add",
  DROP: "Dropped",
  TRADE: "Trade",
  KEEPER_DECLARED: "Kept",
  COMMISSIONER_CORRECTION: "Correction",
  COMMISSIONER_MOVE: "Commissioner move",
};

const NOT_KEPT_PREFIX = "league-history:not kept into ";
/** "Synced from Yahoo (add/drop)" - what the first sync wrote as a row's only detail. */
const LEGACY_NOTE = /^Synced from Yahoo \((.+)\)$/;

export function isInferredRelease(t: Pick<Transaction, "sourceRef">): boolean {
  return !!t.sourceRef?.startsWith(NOT_KEPT_PREFIX);
}

/**
 * A Yahoo row is complete when it was written by the detailed sync, Yahoo's
 * record resolved without issues, and it names its players (Yahoo sends no
 * players for most commissioner moves, so those need none).
 */
export function isTransactionComplete(t: Pick<DisplayTransaction, "yahooTransactionId" | "yahooType" | "yahooDetailIssues"> & { players: unknown[] }): boolean {
  if (!t.yahooTransactionId) return true;
  if (t.yahooType === null) return false;
  if (t.yahooDetailIssues.length > 0) return false;
  return t.yahooType === "commish" || t.players.length > 0;
}

/** Prisma filter for the rows isTransactionComplete calls incomplete, for counting. */
export const INCOMPLETE_TRANSACTION_WHERE = {
  yahooTransactionId: { not: null },
  OR: [{ yahooType: null }, { NOT: { yahooDetailIssues: { isEmpty: true } } }, { yahooType: { not: "commish" }, players: { none: {} } }],
};

const verbFor = (action: string | null): DisplayMove["verb"] =>
  action === "add" ? "Added" : action === "drop" ? "Dropped" : action === "trade" ? "Traded" : null;

export function describeTransaction(t: DisplayTransaction, teamName: Map<string, string>): TransactionDisplay {
  const name = (id: string | null) => (id ? (teamName.get(id) ?? null) : null);
  const teamNames = [...new Set(t.teams.map((x) => teamName.get(x.teamId)).filter((n): n is string => !!n))];

  if (t.yahooTransactionId && t.yahooType === null) {
    // Synced before detailed ingestion: only Yahoo's type label survives.
    const reported = t.notes?.match(LEGACY_NOTE)?.[1] ?? null;
    const notes = [`Details missing - Yahoo reported ${reported ? `"${reported}"` : "this move"}, but its teams and players weren't recorded`];
    return {
      label: "Yahoo transaction",
      iconKey: "INCOMPLETE",
      complete: false,
      moves: [],
      teamNames,
      notes,
      summary: `Yahoo ${reported ?? "transaction"} - details missing`,
    };
  }

  const moves: DisplayMove[] = t.players.map((p) => ({
    verb: verbFor(p.action),
    playerId: p.playerId,
    name: p.player.name,
    teamName: p.action === "drop" ? name(p.sourceTeamId) : name(p.destinationTeamId),
  }));
  // Adds first, then drops, so an add/drop reads "Added X, Dropped Y".
  const order = { Added: 0, Traded: 1, Dropped: 2 } as const;
  moves.sort((a, b) => (a.verb ? order[a.verb] : 3) - (b.verb ? order[b.verb] : 3));

  const complete = isTransactionComplete(t);
  const notes: string[] = [];
  if (t.faabBid !== null) notes.push(`$${t.faabBid} FAAB`);
  if (t.yahooStatus && t.yahooStatus !== YAHOO_SUCCESSFUL) notes.push(`Yahoo status: ${t.yahooStatus}`);
  if (t.dateUnavailable) notes.push("Date unavailable from Yahoo");
  if (!complete) notes.push(t.yahooDetailIssues.length > 0 ? "Incomplete - some teams or players couldn't be matched" : "Incomplete - Yahoo sent no players");

  let label = TYPE_LABELS[t.type] ?? "Correction";
  let iconKey: string = t.type;
  if (isInferredRelease(t)) {
    label = "Not kept";
    iconKey = "RELEASE";
    notes.push("Released at season's end (not a dated transaction)");
  } else if (!complete) {
    iconKey = "INCOMPLETE";
  }
  if (!t.yahooTransactionId && t.notes) notes.push(t.notes);

  const moveText = moves
    .map((m, i) => {
      const verb = m.verb && !(i === 0 && m.verb === "Added" && /add/i.test(label)) ? `${m.verb.toLowerCase()} ` : "";
      return `${verb}${m.name}${m.teamName ? ` (${m.teamName})` : ""}`;
    })
    .join(", ");
  const summary = [label, moveText].filter(Boolean).join(" - ") + (notes.length ? ` · ${notes.join(" · ")}` : "");

  return { label, iconKey, complete, moves, teamNames, notes, summary };
}

/** One player's part in a transaction, for that player's history. */
export function describePlayerMove(
  link: Pick<TransactionPlayer, "action">,
  t: Pick<Transaction, "type" | "notes" | "yahooTransactionId" | "yahooType" | "yahooStatus" | "faabBid" | "sourceRef">
): string {
  if (isInferredRelease(t)) return "Not kept - released at season's end";
  const verb = verbFor(link.action);
  if (!verb) return t.notes ?? TYPE_LABELS[t.type] ?? t.type;
  const extras = [TYPE_LABELS[t.type], verb === "Added" && t.faabBid !== null ? `$${t.faabBid} FAAB` : null, t.yahooStatus && t.yahooStatus !== YAHOO_SUCCESSFUL ? `Yahoo status: ${t.yahooStatus}` : null].filter(
    (x): x is string => !!x && x.toLowerCase() !== verb.toLowerCase()
  );
  return extras.length ? `${verb} (${extras.join(", ")})` : verb;
}
