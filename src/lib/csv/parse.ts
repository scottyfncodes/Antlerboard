/**
 * Minimal RFC 4180-ish CSV parser: handles quoted fields, escaped quotes
 * ("" inside a quoted field), and commas/newlines inside quotes. No
 * external dependency needed for the shapes a commissioner will realistically
 * export from Excel/Google Sheets/Yahoo exports.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export const IMPORT_FIELDS = [
  { key: "playerName", label: "Player Name", required: true },
  { key: "mlbTeam", label: "MLB Team", required: false },
  { key: "positions", label: "Positions (slash or comma separated)", required: false },
  { key: "teamName", label: "C&A Team Name", required: true },
  { key: "season", label: "Season Year", required: true },
  { key: "method", label: "Acquisition Method (DRAFT/WAIVER/FREE_AGENT/TRADE)", required: true },
  { key: "cost", label: "Cost", required: false },
  { key: "draftRound", label: "Draft Round", required: false },
  { key: "draftPick", label: "Draft Pick", required: false },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]["key"];

/** Best-effort guess at which CSV column maps to which field, by header name. */
export function guessMapping(headers: string[]): Partial<Record<ImportFieldKey, number>> {
  const mapping: Partial<Record<ImportFieldKey, number>> = {};
  const normalized = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));

  const guesses: Record<ImportFieldKey, string[]> = {
    playerName: ["player", "playername", "name"],
    mlbTeam: ["mlbteam", "mlb", "proteam"],
    positions: ["position", "positions", "pos"],
    teamName: ["team", "teamname", "cateam", "fantasyteam"],
    season: ["season", "year"],
    method: ["method", "acquisitiontype", "acquisitionmethod", "type"],
    cost: ["cost", "price", "salary", "amount"],
    draftRound: ["round", "draftround"],
    draftPick: ["pick", "draftpick"],
  };

  for (const [key, candidates] of Object.entries(guesses) as [ImportFieldKey, string[]][]) {
    const idx = normalized.findIndex((h) => candidates.includes(h));
    if (idx !== -1) mapping[key] = idx;
  }

  return mapping;
}
