import { normalizeTeamName } from "./team-aliases";

export interface MatchableTeam {
  id: string;
  name: string;
  yahooTeamId: string | null;
  managerName: string;
}

export type TeamMatch = { teamId: string } | { teamId?: undefined; error: string };

/**
 * Resolves the team a CSV acquisition row names to one of the league's
 * teams, without ever guessing.
 *
 * Team.name follows Yahoo (the sync renames teams to Yahoo's spelling,
 * curly apostrophes and emoji included), so a CSV written against an older
 * spelling has to match on more than the literal name. In order, each step
 * accepting only a single unambiguous team:
 *   1. a stable identifier - the Antlerboard team id or the Yahoo team key;
 *   2. the exact name (case-insensitive, trimmed) - the original behavior;
 *   3. the normalized name (normalizeTeamName: accents, curly vs straight
 *      apostrophes, emoji and punctuation, case, whitespace, a leading
 *      "The", the word "Team");
 *   4. the manager's name, normalized the same way.
 * A step that matches two or more teams stops there with an error naming
 * them - a later step never breaks the tie. Nothing fuzzy is attempted.
 */
export function buildTeamMatcher(teams: MatchableTeam[]): (raw: string) => TeamMatch {
  const byKey = (key: (t: MatchableTeam) => string | null) => {
    const map = new Map<string, MatchableTeam[]>();
    for (const t of teams) {
      const k = key(t);
      if (!k) continue;
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return map;
  };

  const steps: { label: string; lookup: Map<string, MatchableTeam[]>; keyOf: (raw: string) => string }[] = [
    { label: "id", lookup: byKey((t) => t.id), keyOf: (raw) => raw },
    { label: "Yahoo team key", lookup: byKey((t) => t.yahooTeamId), keyOf: (raw) => raw },
    { label: "name", lookup: byKey((t) => t.name.trim().toLowerCase()), keyOf: (raw) => raw.toLowerCase() },
    { label: "name", lookup: byKey((t) => normalizeTeamName(t.name) || null), keyOf: normalizeTeamName },
    { label: "manager", lookup: byKey((t) => normalizeTeamName(t.managerName) || null), keyOf: normalizeTeamName },
  ];

  return (input: string) => {
    const raw = input.trim();
    if (!raw) return { error: "Missing team name" };
    for (const step of steps) {
      const key = step.keyOf(raw);
      if (!key) continue;
      const found = step.lookup.get(key) ?? [];
      if (found.length === 1) return { teamId: found[0].id };
      if (found.length > 1) {
        return {
          error: `C&A team "${raw}" is ambiguous - it matches ${found
            .map((t) => `"${t.name}" (${t.managerName})`)
            .join(" and ")} by ${step.label}; give the team id or Yahoo team key instead`,
        };
      }
    }
    return { error: `Unknown C&A team "${raw}"` };
  };
}
