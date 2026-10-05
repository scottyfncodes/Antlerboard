/**
 * Resolves the many ways the league's sources name a franchise to the
 * one identity Antlerboard keys everything on: the current manager's
 * sheet name ("Scott", "MattyJ", ...).
 *
 * Sources disagree constantly: the trade log says "Ranger Things",
 * "Ranger Thingz" and "Scott" for the same team; Yahoo kept a mid-season
 * rename ("Acuña Matata") the workbook never recorded; the prop-bet sheet
 * uses first names, including departed managers' ("Drew", "Holman").
 *
 * Resolution order: an exact normalized match on any team name the
 * franchise has used in any season, then a manager name (current or a
 * known predecessor), then the hand-maintained alias list below, then a
 * typo-tolerant match on team names. Anything else returns null and
 * surfaces in the import preview as unresolved - never a guess.
 */

import { KNOWN_HANDOFFS } from "./known-league-history";
import { editDistance } from "./player-names";

export interface FranchiseNameRecord {
  managerSheetName: string;
  seasonYear: number | null;
  teamName: string;
}

/**
 * Names that only ever appear in one source and can't be derived from the
 * workbook's own season labels. Yahoo mid-season renames and the 2019-20
 * era are the usual reason. Keyed by normalized name (see normalizeTeamName).
 */
export const TEAM_NAME_ALIASES: Record<string, string> = {
  // Yahoo renames the workbook never picked up
  "acuna matata": "Tyler",
  "dumping on them julios": "Ed",
  "hamlin hamlin & mcgill": "MattyJ",
  "hamlin hamlin and mcgill": "MattyJ",
  // 2019-20 offseason trade log
  "wrigleyville whalers": "Kurt",
  // first-name spellings
  "matty": "MattyJ",
  "matty j": "MattyJ",
  "holman": "Neel",
  "homerun holman": "Neel",
  "home run holman": "Neel",
};

export function normalizeTeamName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/\([^)]*\)/g, " ") // "(Ed)" annotations
    .replace(/[^a-z0-9&' ]/g, " ") // emoji, punctuation
    .replace(/'/g, "")
    .replace(/\bteam\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");
}

/** Yahoo's draft-results export truncates long team names ("Cron & Cronenwort..."). */
function truncatedPrefix(raw: string): string | null {
  const m = raw.trim().match(/^(.*?)\s*(?:\.\.\.|…)$/);
  return m && m[1].length >= 4 ? normalizeTeamName(m[1]) : null;
}

export interface TeamResolution {
  managerSheetName: string;
  confidence: "exact" | "manager" | "alias" | "fuzzy";
}

export class FranchiseResolver {
  private byTeamName = new Map<string, Set<string>>();
  private byManagerName = new Map<string, string>();

  constructor(records: FranchiseNameRecord[], managerSheetNames: string[]) {
    for (const r of records) {
      const key = normalizeTeamName(r.teamName);
      if (!this.byTeamName.has(key)) this.byTeamName.set(key, new Set());
      this.byTeamName.get(key)!.add(r.managerSheetName);
    }
    for (const m of managerSheetNames) {
      this.byManagerName.set(normalizeTeamName(m).replace(/\s+/g, ""), m);
    }
    for (const h of KNOWN_HANDOFFS) {
      for (const p of h.predecessors) {
        this.byManagerName.set(normalizeTeamName(p.name).replace(/\s+/g, ""), h.currentManagerSheetName);
      }
    }
  }

  resolve(rawName: string | null | undefined): TeamResolution | null {
    if (!rawName) return null;
    const key = normalizeTeamName(rawName);
    if (!key) return null;

    const exact = this.byTeamName.get(key);
    if (exact && exact.size === 1) return { managerSheetName: [...exact][0], confidence: "exact" };

    // "(Ed)" style annotations in the hub's trade log name the manager outright.
    const annotated = rawName.match(/\(([^)]+)\)\s*$/);
    if (annotated) {
      const m = this.byManagerName.get(normalizeTeamName(annotated[1]).replace(/\s+/g, ""));
      if (m) return { managerSheetName: m, confidence: "manager" };
    }

    const manager = this.byManagerName.get(key.replace(/\s+/g, ""));
    if (manager) return { managerSheetName: manager, confidence: "manager" };

    const alias = TEAM_NAME_ALIASES[key];
    if (alias) return { managerSheetName: alias, confidence: "alias" };

    const prefix = truncatedPrefix(rawName);
    if (prefix) {
      const owners = new Set<string>();
      for (const [name, set] of this.byTeamName) if (name.startsWith(prefix)) for (const o of set) owners.add(o);
      for (const [aliasName, owner] of Object.entries(TEAM_NAME_ALIASES)) if (aliasName.startsWith(prefix)) owners.add(owner);
      if (owners.size === 1) return { managerSheetName: [...owners][0], confidence: "alias" };
      return null;
    }

    let best: { name: string; owners: Set<string>; d: number } | null = null;
    for (const [name, owners] of this.byTeamName) {
      const d = editDistance(name, key);
      const budget = Math.min(2, Math.floor(name.length / 6));
      if (d <= budget && (!best || d < best.d)) best = { name, owners, d };
    }
    if (best && best.owners.size === 1) return { managerSheetName: [...best.owners][0], confidence: "fuzzy" };
    return null;
  }
}
