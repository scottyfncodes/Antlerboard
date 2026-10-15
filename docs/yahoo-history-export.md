# Yahoo history export (read-only)

Recovers what Yahoo still holds for the league's past seasons, so the League
History import only needs the original files for the gaps Yahoo can't fill.
It is **API first, files as fallback**: run the report, download what Yahoo
has, and use the commissioner's files only where the report says so.

## Safety

- **Read-only against Yahoo:** it only issues `GET` requests to the Fantasy API.
- **Writes nothing to the database.** It uses the stored access token as-is
  and never refreshes it (a refresh writes new tokens). The only database
  reads are the Yahoo connection and, for the report, the Yahoo transaction
  keys Antlerboard already stores.
- **Never invents data.** A pick Yahoo has no price for stays blank, and a
  season Yahoo refuses is reported, not guessed. Manager emails and guids
  are dropped from the export.
- **Doesn't touch the import.** It changes no import code or data. Its
  transactions CSV is the existing upload format, so the League History
  import's safeguards (signed preview, conflict checks, rollback) all apply
  unchanged.
- **Safe to re-run:** every run re-reads Yahoo, and it is commissioner-only.

## When to run it

The stored Yahoo access token lasts about an hour. Run the export **within
about an hour of the daily Yahoo sync** (it fires between 12:00 and 13:00
UTC), or right after a commissioner's **Sync Now**. Outside that window it
answers `409` and says why. That's the price of never refreshing, and so
never writing, the token.

## How to run it

Sign in as the commissioner on https://antlerboard.vercel.app (never a
preview URL), then open these in the browser:

| URL | What you get |
|---|---|
| `/api/commissioner/yahoo-history?file=report` | The recovery report (JSON): every season reachable from the connected league, what was recovered, what's inaccessible, what needs the original files, and how Yahoo's transaction keys compare with the ones Antlerboard stores |
| `/api/commissioner/yahoo-history?file=season.json&season=2024` | One season, complete: settings, teams, draft results with prices and player keys, and every transaction as Yahoo returned it |
| `/api/commissioner/yahoo-history?file=transactions.csv&season=2024` | That season's transactions in the League History import's `season, league_key, transaction_raw` format |
| `/api/commissioner/yahoo-history?file=draft.csv&season=2024` | That season's draft results: pick, round, player, ids, MLB team, positions, price, fantasy team |

Downloads are one season at a time because Vercel caps a response at about
4.5 MB. To build the import's single 2025-and-earlier transaction file, join
the per-season CSVs while keeping one header:

```bash
{ head -1 antlerboard-yahoo-2021-transactions.csv; for y in 2021 2022 2023 2024 2025; do tail -n +2 antlerboard-yahoo-$y-transactions.csv; done; } > yahoo-transactions-2021-2025.csv
```

Check the result against the import's ~4.5 MB upload limit (runbook §1).

## How it works

- **Finding seasons:** it starts from the connected league (`469.l.8891`)
  and follows each season's Yahoo `renew` link to the previous one. It stops
  at Antlerboard's first season (2021), at the end of the chain, or at a
  season Yahoo refuses. The report says which.
- **Requests per season:**
  - `/settings`
  - `/teams`
  - `/draftresults`
  - `/players;player_keys=…`, 25 players per request
  - `/transactions;start=…;count=25`, paged until a page adds nothing new
- **Pacing and retries:** requests are 250 ms apart. The client retries
  Yahoo rate limits (999/429) and server errors twice with backoff.
- **Failures:** a section that still fails is recorded in the report. An
  expired or rejected token ends the run with `409`.

## Reading the report

- `recovered`: what Yahoo returned in full, with counts.
- `inaccessible`: seasons or sections Yahoo refused or that failed, with
  Yahoo's own error.
- `requiresOriginalFiles`: what the original files must still supply.
  - Per season: a missing draft, unpriced picks, or an unreadable season.
  - Always: recorded keeper costs and overrides, which picks were keepers,
    offseason trades, pre-2021 history and FYPD (already stored).
- `seasons[].antlerboard`: for seasons Antlerboard already synced, how many
  Yahoo transaction keys match the stored ones.
