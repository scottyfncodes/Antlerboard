/**
 * Decides which existing Player row (if any) each league-history import
 * player is. Pure - the commit runs it inside its transaction against the
 * database as it is at that moment, and the preview runs it read-only so
 * the commissioner sees the same decisions first.
 *
 * Rules, strongest evidence first:
 *  0. A player an earlier run kept separate for review, by its marker.
 *  1. Same canonical Yahoo id (bare "12345" == stored "469.p.12345").
 *     Two existing rows with one canonical id is already-duplicated data:
 *     a conflict that stops the import rather than a guess between them.
 *  2. Otherwise a name match, and only when it is one-to-one: exactly one
 *     role-compatible existing candidate, which no other import player
 *     could also be. Role = hitter / pitcher from positions or a
 *     "(Batter)"/"(Pitcher)" marker; unknown role is compatible with either.
 *     An existing row linked to a *different* Yahoo id is a different
 *     person and never a candidate for an import player that has an id.
 *  3. Otherwise a new player. When candidates existed but none was certain,
 *     the player is listed for manual review instead of being merged, and
 *     the new row's notes say so (shown on the player page) with a marker
 *     carrying the import key - so a re-run finds that same row again
 *     (rule 0) instead of adding one more same-name player every time.
 *
 * Nothing here ever changes an existing row's Yahoo id.
 */

import { canonicalYahooPlayerId } from "../yahoo/player-id";
import { normalizePlayerName } from "./player-names";
import { isPitcherPositions } from "./league-history-builder";

export interface IdentityImportPlayer {
  key: string;
  yahooPlayerId: string | null;
  name: string;
  positions: string[];
}

export interface IdentityExistingPlayer {
  id: string;
  yahooPlayerId: string | null;
  name: string;
  positions: string[];
  notes?: string | null;
}

const REVIEW_MARKER = /\[import-key:([^\]]+)\]/;

/** Notes for a player the import kept separate - visible on the player page, and how a re-run finds it again. */
export function reviewNotes(item: IdentityReviewItem): string {
  return `Needs review: the league-history import couldn't confidently match ${item.name} to an existing player (${item.reason}) [import-key:${item.importKey}]`;
}

/**
 * Notes for a new player with no Yahoo id whose name another player shares.
 * The marker lets a re-run find this exact row (rule 0); without it, the
 * next run would see two same-name rows, trust neither, and add more.
 */
export function sharedNameNotes(name: string, importKey: string): string {
  return `Imported from league history with no Yahoo id; another player has the same name (${name}), so this one is kept apart. [import-key:${importKey}]`;
}

export type IdentityDecision =
  | { kind: "existing"; playerId: string; via: "review-marker" | "yahoo-id" | "name" }
  | { kind: "new" };

export interface IdentityReviewItem {
  importKey: string;
  name: string;
  reason: string;
  candidateIds: string[];
}

export interface IdentityPlan {
  decisions: Map<string, IdentityDecision>;
  /** Players kept separate because a match couldn't be established confidently. */
  review: IdentityReviewItem[];
  /** Problems that must stop the import before anything is written. */
  conflicts: string[];
  counts: { byYahooId: number; byName: number; created: number };
}

function roleOf(name: string, positions: string[]): boolean | null {
  const marker = normalizePlayerName(name).twoWayMarker;
  if (marker === "P") return true;
  if (marker === "B") return false;
  return isPitcherPositions(positions);
}

function rolesCompatible(a: boolean | null, b: boolean | null): boolean {
  return a === null || b === null || a === b;
}

export function planPlayerIdentities(importPlayers: IdentityImportPlayer[], existing: IdentityExistingPlayer[]): IdentityPlan {
  const decisions = new Map<string, IdentityDecision>();
  const review: IdentityReviewItem[] = [];
  const conflicts: string[] = [];
  const counts = { byYahooId: 0, byName: 0, created: 0 };

  // --- 0. rows an earlier run kept separate for review ---------------------
  const claimed = new Set<string>();
  const byMarker = new Map<string, string>();
  for (const e of existing) {
    const m = e.notes?.match(REVIEW_MARKER);
    if (m) byMarker.set(m[1], e.id);
  }
  const unresolved: IdentityImportPlayer[] = [];
  for (const p of importPlayers) {
    const id = byMarker.get(p.key);
    if (id && !canonicalYahooPlayerId(p.yahooPlayerId)) {
      decisions.set(p.key, { kind: "existing", playerId: id, via: "review-marker" });
      claimed.add(id);
      continue;
    }
    unresolved.push(p);
  }

  // --- 1. canonical Yahoo id ----------------------------------------------
  const existingByCanonical = new Map<string, IdentityExistingPlayer[]>();
  for (const e of existing) {
    const c = canonicalYahooPlayerId(e.yahooPlayerId);
    if (!c) continue;
    if (!existingByCanonical.has(c)) existingByCanonical.set(c, []);
    existingByCanonical.get(c)!.push(e);
  }
  const remaining: IdentityImportPlayer[] = [];
  for (const p of unresolved) {
    const c = canonicalYahooPlayerId(p.yahooPlayerId);
    const matches = c ? existingByCanonical.get(c) ?? [] : [];
    if (matches.length > 1) {
      conflicts.push(`Yahoo player ${c} (${p.name}) is already stored on ${matches.length} players - merge those first.`);
      continue;
    }
    if (matches.length === 1) {
      if (claimed.has(matches[0].id)) {
        conflicts.push(`Yahoo player ${c} (${p.name}) appears twice in the import.`);
        continue;
      }
      decisions.set(p.key, { kind: "existing", playerId: matches[0].id, via: "yahoo-id" });
      claimed.add(matches[0].id);
      counts.byYahooId++;
      continue;
    }
    remaining.push(p);
  }

  // --- 2. one-to-one name matches -------------------------------------------
  const existingByName = new Map<string, IdentityExistingPlayer[]>();
  for (const e of existing) {
    // Claimed rows, and rows an earlier run set aside for some other
    // import player, are never name candidates.
    if (claimed.has(e.id) || REVIEW_MARKER.test(e.notes ?? "")) continue;
    const k = normalizePlayerName(e.name).fullKey;
    if (!existingByName.has(k)) existingByName.set(k, []);
    existingByName.get(k)!.push(e);
  }
  const candidatesOf = new Map<string, IdentityExistingPlayer[]>();
  const wantedBy = new Map<string, string[]>(); // existing id -> import keys
  for (const p of remaining) {
    const pRole = roleOf(p.name, p.positions);
    const pHasId = !!canonicalYahooPlayerId(p.yahooPlayerId);
    const candidates = (existingByName.get(normalizePlayerName(p.name).fullKey) ?? []).filter(
      (e) => rolesCompatible(pRole, roleOf(e.name, e.positions)) && !(pHasId && e.yahooPlayerId)
    );
    candidatesOf.set(p.key, candidates);
    for (const e of candidates) {
      if (!wantedBy.has(e.id)) wantedBy.set(e.id, []);
      wantedBy.get(e.id)!.push(p.key);
    }
  }
  for (const p of remaining) {
    const candidates = candidatesOf.get(p.key) ?? [];
    if (candidates.length === 1 && (wantedBy.get(candidates[0].id) ?? []).length === 1) {
      decisions.set(p.key, { kind: "existing", playerId: candidates[0].id, via: "name" });
      counts.byName++;
      continue;
    }
    decisions.set(p.key, { kind: "new" });
    counts.created++;
    if (candidates.length > 0) {
      review.push({
        importKey: p.key,
        name: p.name,
        reason:
          candidates.length > 1
            ? `${candidates.length} existing players share this name and nothing tells them apart - kept as a separate player.`
            : "Another imported player could also be this existing player - kept as a separate player.",
        candidateIds: candidates.map((c) => c.id),
      });
    }
  }

  return { decisions, review, conflicts, counts };
}
