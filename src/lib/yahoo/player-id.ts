/**
 * Yahoo player identity.
 *
 * Yahoo identifies a player two ways: a `player_key` scoped to one game
 * (season) - "469.p.12345" - and the bare `player_id` inside it - "12345" -
 * which never changes from season to season. The roster sync stores the
 * full key (whatever season it last saw); the league-history import only
 * has the bare id from the transaction export. Both are the same person, so
 * every match on Player.yahooPlayerId goes through the canonical (bare) id,
 * and nothing ever rewrites a stored key into the other form.
 */

const FULL_KEY = /^\d+\.p\.(\d+)$/;
const BARE_ID = /^\d+$/;

/** "469.p.12345" -> "12345", "12345" -> "12345", anything else -> null. */
export function canonicalYahooPlayerId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const full = s.match(FULL_KEY);
  if (full) return full[1];
  return BARE_ID.test(s) ? s : null;
}

/**
 * Prisma filter for every stored form of one canonical id: the bare id,
 * or a full key from any season. The ".p." anchor keeps "12345" from
 * matching "469.p.112345".
 */
export function yahooPlayerIdForms(canonicalId: string) {
  return [{ yahooPlayerId: canonicalId }, { yahooPlayerId: { endsWith: `.p.${canonicalId}` } }];
}
