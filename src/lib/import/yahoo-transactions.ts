/**
 * Parses a Yahoo Fantasy transaction export - the CSV produced by pulling
 * `league/{key}/transactions` for each season and writing one row per API
 * object: columns `season, league_key, transaction_raw` where
 * `transaction_raw` is the JSON Yahoo returned.
 *
 * Yahoo's transaction resource is a two-element array, and the export
 * writes each element as its own CSV row: a metadata row
 * ({transaction_key, type, status, timestamp, faab_bid?, trader/tradee
 * team names for trades}) followed, for every type but "commish", by a
 * players row ({players: {"0": {player: [[info...], {transaction_data}]},
 * ..., count}}). This parser pairs them back up.
 *
 * Confirmed against the real export: add/drop combos carry both players
 * with per-player transaction_data; `faab_bid` is present on every
 * waiver add that cost anything and absent on $0 claims and free-agent
 * adds; player ids are stable across seasons (the game-key prefix on
 * player_key changes each year, player_id does not).
 */

import { parseCsv } from "../csv/parse";
import type { ParsedYahooTransactions, YahooTransaction, YahooTransactionPlayer, YahooTransactionType } from "./league-history-types";

type Json = Record<string, unknown>;

const KNOWN_TYPES: YahooTransactionType[] = ["add", "drop", "add/drop", "trade", "commish"];

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
}

/** Yahoo's player "info" is an array of single-key objects; flatten it. */
function flattenInfo(info: unknown): Json {
  const out: Json = {};
  if (!Array.isArray(info)) return out;
  for (const part of info) {
    if (part && typeof part === "object") Object.assign(out, part as Json);
  }
  return out;
}

function parsePlayers(playersJson: Json | null): YahooTransactionPlayer[] {
  if (!playersJson || typeof playersJson.players !== "object" || playersJson.players === null) return [];
  const players = playersJson.players as Json;
  const out: YahooTransactionPlayer[] = [];

  for (const [key, value] of Object.entries(players)) {
    if (key === "count" || !value || typeof value !== "object") continue;
    const entry = (value as Json).player;
    if (!Array.isArray(entry) || entry.length < 1) continue;

    const info = flattenInfo(entry[0]);
    const tdWrapper = (entry[1] as Json | undefined)?.transaction_data;
    const td = (Array.isArray(tdWrapper) ? tdWrapper[0] : tdWrapper) as Json | undefined;

    const name = (info.name as Json | undefined)?.full;
    const playerId = asString(info.player_id);
    if (!playerId || typeof name !== "string") continue;

    const rawAction = asString(td?.type);
    const action: YahooTransactionPlayer["action"] =
      rawAction === "add" || rawAction === "drop" || rawAction === "trade" ? rawAction : "other";

    out.push({
      yahooPlayerId: playerId,
      name,
      mlbTeam: asString(info.editorial_team_abbr),
      positions: asString(info.display_position)?.split(",").map((p) => p.trim()).filter(Boolean) ?? [],
      action,
      sourceType: asString(td?.source_type),
      sourceTeamName: asString(td?.source_team_name),
      destinationType: asString(td?.destination_type),
      destinationTeamName: asString(td?.destination_team_name),
    });
  }
  return out;
}

export function parseYahooTransactionsCsv(text: string): ParsedYahooTransactions {
  const rows = parseCsv(text);
  const flags: string[] = [];
  if (rows.length === 0) return { transactions: [], teamNamesBySeason: {}, flags: ["Empty file."] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const seasonIdx = header.indexOf("season");
  const leagueIdx = header.indexOf("league_key");
  const rawIdx = header.indexOf("transaction_raw");
  if (seasonIdx === -1 || rawIdx === -1) {
    return { transactions: [], teamNamesBySeason: {}, flags: ["Expected columns season, league_key, transaction_raw."] };
  }

  const parsedRows: { seasonYear: number; leagueKey: string; json: Json | null; line: number }[] = [];
  rows.slice(1).forEach((row, i) => {
    const seasonYear = Number(row[seasonIdx]);
    let json: Json | null = null;
    try {
      json = JSON.parse(row[rawIdx]) as Json;
    } catch {
      flags.push(`Line ${i + 2}: transaction_raw is not valid JSON - skipped.`);
    }
    parsedRows.push({ seasonYear, leagueKey: leagueIdx === -1 ? "" : row[leagueIdx], json, line: i + 2 });
  });

  const transactions: YahooTransaction[] = [];
  const teamNames = new Map<number, Set<string>>();
  let unpairedPlayerRows = 0;

  for (let i = 0; i < parsedRows.length; i++) {
    const { seasonYear, leagueKey, json, line } = parsedRows[i];
    if (!json) continue;
    if (!("transaction_key" in json)) {
      // A players row with no preceding metadata row - count and move on.
      unpairedPlayerRows++;
      continue;
    }
    if (!Number.isFinite(seasonYear)) {
      flags.push(`Line ${line}: season is not a number - skipped.`);
      continue;
    }

    let playersJson: Json | null = null;
    const next = parsedRows[i + 1];
    if (next?.json && !("transaction_key" in next.json) && "players" in next.json) {
      playersJson = next.json;
      i++;
    }

    const rawType = asString(json.type) ?? "other";
    const type: YahooTransactionType = (KNOWN_TYPES as string[]).includes(rawType) ? (rawType as YahooTransactionType) : "other";
    const ts = Number(json.timestamp);
    const faab = json.faab_bid;

    const tx: YahooTransaction = {
      seasonYear,
      leagueKey,
      transactionKey: String(json.transaction_key),
      type,
      status: asString(json.status) ?? "",
      timestamp: new Date(Number.isFinite(ts) ? ts * 1000 : NaN),
      faabBid: faab === undefined || faab === null || faab === "" ? null : Number(faab),
      traderTeamName: asString(json.trader_team_name),
      tradeeTeamName: asString(json.tradee_team_name),
      players: parsePlayers(playersJson),
    };
    if (Number.isNaN(tx.timestamp.getTime())) flags.push(`Line ${line}: transaction ${tx.transactionKey} has no usable timestamp.`);
    if (type !== "commish" && tx.players.length === 0) flags.push(`Line ${line}: ${type} transaction ${tx.transactionKey} has no players row.`);

    for (const p of tx.players) {
      for (const n of [p.sourceTeamName, p.destinationTeamName]) {
        if (n) {
          if (!teamNames.has(seasonYear)) teamNames.set(seasonYear, new Set());
          teamNames.get(seasonYear)!.add(n);
        }
      }
    }
    transactions.push(tx);
  }

  if (unpairedPlayerRows > 0) flags.push(`${unpairedPlayerRows} player rows had no preceding transaction row and were skipped.`);

  const teamNamesBySeason: Record<number, string[]> = {};
  for (const [season, names] of teamNames) teamNamesBySeason[season] = [...names].sort();

  return { transactions, teamNamesBySeason, flags };
}
