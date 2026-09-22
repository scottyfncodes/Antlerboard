/**
 * Fuzzy-matches a Yahoo league name against "Claw & Antler" so the
 * commissioner can spot their league in a list of every MLB league the
 * connected Yahoo account belongs to, regardless of how it's formatted
 * (ampersand vs "and", punctuation, spacing, casing).
 */
export function isLikelyClawAndAntler(name: string): boolean {
  const normalized = name.toLowerCase();
  if (/claw\s*(&|and)\s*antler/.test(normalized)) return true;
  return /\bclaw\b/.test(normalized) && /\bantler\b/.test(normalized);
}
