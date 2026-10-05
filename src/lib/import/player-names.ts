/**
 * Player-name normalization for matching the commissioner's workbook
 * (hand-typed, inconsistent: "J.Soto", "Juan Soto", "Juan Soto (NYM - OF)",
 * "B. Witt Jr.", "S. Ohtani (B)") against Yahoo's canonical full names.
 *
 * Two keys come out of every name:
 *   - fullKey:    "juan soto"  (accents stripped, punctuation/suffixes dropped)
 *   - initialKey: "j soto"     (first initial + last name)
 * A hand-typed abbreviation only ever yields an initialKey match; the
 * caller decides how much ambiguity it will accept (see matchPlayerName).
 */

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

export interface NormalizedPlayerName {
  /** Cleaned display form without the MLB-team/position tail. */
  display: string;
  fullKey: string;
  initialKey: string;
  lastKey: string;
  /** True when the source only gave an initial for the first name ("J.Soto"). */
  abbreviated: boolean;
  /** Ohtani-style "(B)" / "(P)" two-way markers, kept so both halves can be told apart. */
  twoWayMarker: "B" | "P" | null;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function normalizePlayerName(raw: string): NormalizedPlayerName {
  let s = raw.trim();
  let twoWayMarker: "B" | "P" | null = null;
  const marker = s.match(/\(\s*([BP])\s*\)/i);
  if (marker) {
    twoWayMarker = marker[1].toUpperCase() as "B" | "P";
    s = s.replace(marker[0], " ");
  }
  // "Juan Soto (NYM - OF)" / "Juan Soto NYM - OF" / "José Ramírez(Cle - 2B,3B)"
  s = s.replace(/\s*\([^)]*\)\s*$/, "");
  s = s.replace(/\s+[A-Z]{2,3}\s*-\s*[A-Z0-9,/ ]+$/, "");
  s = s.replace(/\s+/g, " ").trim();
  const display = s;

  const clean = stripAccents(s)
    .toLowerCase()
    .replace(/[.,'’`]/g, " ")
    .replace(/[^a-z0-9\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "J.Soto" becomes "j soto" after punctuation removal; "JJ Wetherholt" stays.
  const tokens = clean.split(" ").filter((t) => t && !SUFFIXES.has(t));
  const abbreviated = tokens.length >= 2 && tokens[0].length === 1;
  const first = tokens[0] ?? "";
  const last = tokens.length >= 2 ? tokens.slice(1).join(" ") : first;

  return {
    display,
    fullKey: tokens.join(" "),
    initialKey: `${first.charAt(0)} ${last}`.trim(),
    lastKey: last,
    abbreviated,
    twoWayMarker,
  };
}

/** Small Levenshtein for typo-tolerant last-name matching ("Kiner-Filefa" vs "Kiner-Falefa"). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

export interface PlayerCandidate<T> {
  name: string;
  value: T;
}

export interface PlayerMatch<T> {
  value: T;
  /** exact: same full name; initial: first-initial + last name; fuzzy: typo-tolerant last name. */
  confidence: "exact" | "initial" | "fuzzy";
}

/**
 * Resolves a hand-typed name against a candidate list (typically the
 * players known to be on that team that season, which keeps "J.Soto"
 * from being ambiguous). Returns null rather than guessing when more than
 * one candidate ties at the best confidence level.
 */
export function matchPlayerName<T>(raw: string, candidates: PlayerCandidate<T>[]): PlayerMatch<T> | null {
  const target = normalizePlayerName(raw);
  const normalized = candidates.map((c) => ({ c, n: normalizePlayerName(c.name) }));

  const exact = normalized.filter(({ n }) => n.fullKey === target.fullKey);
  if (exact.length === 1) return { value: exact[0].c.value, confidence: "exact" };
  if (exact.length > 1) return null;

  const byInitial = normalized.filter(({ n }) => n.initialKey === target.initialKey);
  if (byInitial.length === 1) return { value: byInitial[0].c.value, confidence: "initial" };
  if (byInitial.length > 1) return null;

  // Typo tolerance: same first initial, last name within 2 edits (scaled
  // down for very short names so "Ray" can't match "Rea" and "May" alike).
  const maxEdits = target.lastKey.length >= 7 ? 2 : target.lastKey.length >= 5 ? 1 : 0;
  if (maxEdits === 0) return null;
  const fuzzy = normalized.filter(
    ({ n }) => n.initialKey.charAt(0) === target.initialKey.charAt(0) && editDistance(n.lastKey, target.lastKey) <= maxEdits
  );
  if (fuzzy.length === 1) return { value: fuzzy[0].c.value, confidence: "fuzzy" };
  return null;
}
