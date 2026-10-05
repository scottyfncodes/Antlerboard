import { describe, it, expect } from "vitest";
import { parseYahooTransactionsCsv } from "./yahoo-transactions";

function csvRow(season: number, json: object): string {
  return `${season},404.l.1,"${JSON.stringify(json).replace(/"/g, '""')}"`;
}

const player = (id: string, name: string, td: object) => ({
  player: [
    [{ player_key: `404.p.${id}` }, { player_id: id }, { name: { full: name } }, { editorial_team_abbr: "NYM" }, { display_position: "SP,RP" }],
    { transaction_data: td },
  ],
});

describe("parseYahooTransactionsCsv", () => {
  it("pairs a metadata row with the players row that follows it", () => {
    const text = [
      "season,league_key,transaction_raw",
      csvRow(2023, { transaction_key: "404.l.1.tr.5", transaction_id: "5", type: "add", status: "successful", timestamp: "1688169600", faab_bid: "14" }),
      csvRow(2023, {
        players: {
          "0": player("10152", "Reynaldo López", [{ type: "add", source_type: "waivers", destination_type: "team", destination_team_name: "Alpha" }]),
          count: 1,
        },
      }),
    ].join("\n");

    const result = parseYahooTransactionsCsv(text);
    expect(result.flags).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0];
    expect(tx).toMatchObject({ seasonYear: 2023, type: "add", faabBid: 14, transactionKey: "404.l.1.tr.5" });
    expect(tx.timestamp.toISOString()).toBe("2023-07-01T00:00:00.000Z");
    expect(tx.players).toEqual([
      {
        yahooPlayerId: "10152",
        name: "Reynaldo López",
        mlbTeam: "NYM",
        positions: ["SP", "RP"],
        action: "add",
        sourceType: "waivers",
        sourceTeamName: null,
        destinationType: "team",
        destinationTeamName: "Alpha",
      },
    ]);
    expect(result.teamNamesBySeason).toEqual({ 2023: ["Alpha"] });
  });

  it("reads add/drop combos and trades with per-player direction", () => {
    const text = [
      "season,league_key,transaction_raw",
      csvRow(2024, { transaction_key: "t1", transaction_id: "1", type: "add/drop", status: "successful", timestamp: "1700000000" }),
      csvRow(2024, {
        players: {
          "0": player("1", "Adder", [{ type: "add", source_type: "freeagents", destination_type: "team", destination_team_name: "Alpha" }]),
          "1": player("2", "Dropper", { type: "drop", source_type: "team", source_team_name: "Alpha", destination_type: "waivers" }),
          count: 2,
        },
      }),
      csvRow(2024, {
        transaction_key: "t2",
        transaction_id: "2",
        type: "trade",
        status: "successful",
        timestamp: "1700000100",
        trader_team_name: "Alpha",
        tradee_team_name: "Bravo",
      }),
      csvRow(2024, {
        players: {
          "0": player("3", "Traded", [{ type: "trade", source_type: "team", source_team_name: "Alpha", destination_type: "team", destination_team_name: "Bravo" }]),
          count: 1,
        },
      }),
    ].join("\n");

    const { transactions, flags } = parseYahooTransactionsCsv(text);
    expect(flags).toEqual([]);
    expect(transactions.map((t) => t.type)).toEqual(["add/drop", "trade"]);
    expect(transactions[0].faabBid).toBeNull();
    expect(transactions[0].players.map((p) => [p.name, p.action, p.sourceType])).toEqual([
      ["Adder", "add", "freeagents"],
      ["Dropper", "drop", "team"],
    ]);
    expect(transactions[1]).toMatchObject({ traderTeamName: "Alpha", tradeeTeamName: "Bravo" });
    expect(transactions[1].players[0]).toMatchObject({ action: "trade", sourceTeamName: "Alpha", destinationTeamName: "Bravo" });
  });

  it("keeps commissioner transactions (which have no players row) without flagging them", () => {
    const text = [
      "season,league_key,transaction_raw",
      csvRow(2022, { transaction_key: "c1", transaction_id: "9", type: "commish", status: "successful", timestamp: "1650000000" }),
      csvRow(2022, { transaction_key: "d1", transaction_id: "10", type: "drop", status: "successful", timestamp: "1650000500" }),
      csvRow(2022, {
        players: { "0": player("7", "Gone", { type: "drop", source_type: "team", source_team_name: "Alpha", destination_type: "freeagents" }), count: 1 },
      }),
    ].join("\n");
    const { transactions, flags } = parseYahooTransactionsCsv(text);
    expect(flags).toEqual([]);
    expect(transactions.map((t) => [t.type, t.players.length])).toEqual([
      ["commish", 0],
      ["drop", 1],
    ]);
  });

  it("flags unreadable JSON and missing header columns instead of throwing", () => {
    expect(parseYahooTransactionsCsv("foo,bar\n1,2").flags[0]).toMatch(/Expected columns/);
    const bad = parseYahooTransactionsCsv('season,league_key,transaction_raw\n2021,k,"not json"');
    expect(bad.transactions).toEqual([]);
    expect(bad.flags[0]).toMatch(/not valid JSON/);
  });
});
