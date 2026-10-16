/**
 * Test fixtures in Yahoo's real /league/{key}/transactions JSON shape (see
 * src/lib/yahoo/transactions.ts): each transaction is [meta, {players}],
 * meta one flat object; each player is [[info...], {transaction_data: [...]}].
 * Test-only - imported by *.test.ts files.
 */

export const LK = "469.l.8891";
export const teamKey = (n: number) => `${LK}.t.${n}`;
export const txKey = (n: number) => `${LK}.tr.${n}`;

type Td = Record<string, string>;

export function yPlayer(id: number, name: string, td: Td, opts: { tdAsObject?: boolean; noId?: boolean } = {}) {
  const info: object[] = [{ player_key: `469.p.${id}` }, { name: { full: name, first: name.split(" ")[0], last: name.split(" ")[1] ?? "" } }, { editorial_team_abbr: "nyy" }, { display_position: "OF,Util" }];
  if (!opts.noId) info.splice(1, 0, { player_id: String(id) });
  else info.shift();
  return { player: [info, { transaction_data: opts.tdAsObject ? td : [td] }] };
}

export const freeAgentAdd = (team: number): Td => ({ type: "add", source_type: "freeagents", destination_type: "team", destination_team_key: teamKey(team), destination_team_name: `Team ${team}` });
export const waiverAdd = (team: number): Td => ({ type: "add", source_type: "waivers", destination_type: "team", destination_team_key: teamKey(team), destination_team_name: `Team ${team}` });
export const dropTo = (team: number, dest = "waivers"): Td => ({ type: "drop", source_type: "team", source_team_key: teamKey(team), source_team_name: `Team ${team}`, destination_type: dest });
export const tradeMove = (from: number, to: number): Td => ({ type: "trade", source_type: "team", source_team_key: teamKey(from), destination_type: "team", destination_team_key: teamKey(to) });

export function yTx(meta: Record<string, unknown>, players?: ReturnType<typeof yPlayer>[]) {
  const playersPart = players ? [{ players: { ...Object.fromEntries(players.map((p, i) => [String(i), p])), count: players.length } }] : [];
  return { transaction: [meta, ...playersPart] };
}

export const meta = (n: number, type: string, extra: Record<string, unknown> = {}) => ({
  transaction_key: txKey(n),
  transaction_id: String(n),
  type,
  status: "successful",
  timestamp: String(1_774_000_000 + n * 60),
  ...extra,
});

export function yPage(entries: unknown[], season = "2026") {
  return {
    fantasy_content: {
      league: [{ league_key: LK, season }, { transactions: { ...Object.fromEntries(entries.map((e, i) => [String(i), e])), count: entries.length } }],
    },
  };
}

/** A Yahoo that pages its log by `start`/`count`, newest first like the real one. */
export function pagedYahoo(all: unknown[], opts: { season?: string; ignorePaging?: boolean; failOnStart?: number } = {}) {
  const calls: string[] = [];
  const get = async (path: string) => {
    calls.push(path);
    const start = Number(path.match(/start=(\d+)/)?.[1] ?? 0);
    const count = Number(path.match(/count=(\d+)/)?.[1] ?? 25);
    if (opts.failOnStart !== undefined && start === opts.failOnStart) throw new Error("Yahoo API request failed (999): rate limited");
    return yPage(opts.ignorePaging ? all : all.slice(start, start + count), opts.season ?? "2026");
  };
  return { get, calls };
}
