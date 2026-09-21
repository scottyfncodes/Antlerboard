/**
 * The C&A league's actual pre-2021 manager/franchise history, as
 * confirmed directly by the commissioner during this import's design
 * (not inferred from the spreadsheet - the workbook only ever labels a
 * franchise's tab with whoever runs it *today*, which is exactly what
 * made this need confirming rather than guessing).
 *
 * This is genuinely one-time historical fact, not something a future
 * re-import should have to re-derive or re-ask about, so it's committed
 * here rather than surfaced as a "flag" the commissioner has to resolve
 * on every run. A *new* handoff (something after this file was written)
 * would still need a code change here before it imports correctly - see
 * resolveSeasonManager's fallback behavior below.
 */

export interface ManagerHandoff {
  /** The current-era manager sheet name this franchise is filed under. */
  currentManagerSheetName: string;
  /** Predecessors in chronological order, each with the last season they ran it. */
  predecessors: { name: string; lastSeasonYear: number }[];
}

export const KNOWN_HANDOFFS: ManagerHandoff[] = [
  { currentManagerSheetName: "Andrew", predecessors: [{ name: "Stan", lastSeasonYear: 2023 }] },
  { currentManagerSheetName: "Hugo", predecessors: [{ name: "Mason", lastSeasonYear: 2021 }] },
  { currentManagerSheetName: "Michael", predecessors: [{ name: "Drew", lastSeasonYear: 2022 }] },
  {
    currentManagerSheetName: "Neel",
    predecessors: [
      { name: "Holman", lastSeasonYear: 2023 },
      { name: "Josh", lastSeasonYear: 2024 },
    ],
  },
];

/**
 * Managers confirmed to be continuous originals - no takeover, despite a
 * mid-run team rename that might otherwise look like one (e.g. Kurt's
 * "Wrigleyville Whales" -> "Northside Plush Sox" was his own rebrand).
 */
export const CONFIRMED_ORIGINALS = new Set(["Kurt", "Aaron", "Tyler"]);

/**
 * A real historical franchise with no connection to the current league -
 * Trey's tenure ended before 2021 and nobody succeeded him. Real history,
 * but never linked to any current manager/team.
 */
export const EXCLUDED_FRANCHISES = new Set(["Trey"]);

/**
 * Resolves which manager actually ran a given season for a current
 * manager's sheet. Falls back to the sheet's own name when there's no
 * recorded handoff for it - i.e. an *inferred* continuous original
 * (Scott, Jorge, Zach), not an explicitly confirmed one (see
 * CONFIRMED_ORIGINALS for the ones that were explicitly confirmed).
 */
export function resolveSeasonManager(currentManagerSheetName: string, seasonYear: number): string {
  const handoff = KNOWN_HANDOFFS.find((h) => h.currentManagerSheetName === currentManagerSheetName);
  if (!handoff) return currentManagerSheetName;

  for (const predecessor of handoff.predecessors) {
    if (seasonYear <= predecessor.lastSeasonYear) return predecessor.name;
  }
  return currentManagerSheetName;
}
