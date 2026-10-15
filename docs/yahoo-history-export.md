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
  Responses are marked `private, no-store`, so nothing is cached, and an
  unexpected server error returns a generic message, not internal detail.

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
| `/api/commissioner/yahoo-history?file=report` | The recovery report (JSON): every season reachable from the connected league, what was recovered, what's inaccessible, what needs the original files, and how Yahoo's transaction keys compare with the ones Antlerboard stores. The connected season's transactions aren't re-read: Antlerboard's daily sync already keeps them |
| `/api/commissioner/yahoo-history?file=report&season=2024` | The same report for one season only. Use it for any season the full report lists under `notChecked` |
| `/api/commissioner/yahoo-history?file=season.json&season=2024` | One season, complete: settings, teams, draft results with prices and player keys, and every transaction as Yahoo returned it |
| `/api/commissioner/yahoo-history?file=transactions.csv&season=2024` | That season's transactions in the League History import's `season, league_key, transaction_raw` format |
| `/api/commissioner/yahoo-history?file=draft.csv&season=2024` | That season's draft results: pick, round, player, ids, MLB team, positions, price, fantasy team |
| `/api/commissioner/yahoo-history?file=draft.csv&season=all` | **The import's draft input:** every season before the connected one (2021-2025) in one CSV |
| `/api/commissioner/yahoo-history?file=transactions.csv&season=all` | **The import's Yahoo file:** 2021-2025 transactions in one gzipped CSV (`.csv.gz`). Upload it to the import as downloaded |

The two `season=all` downloads are all or nothing. If Yahoo won't finish
any season, they answer `503` and no file, so try again later. The plain
2021-2025 transaction CSV is about 4 MB, which is too close to Vercel's
~4.5 MB limit for both this download and the import upload. That's why
it's served gzipped (about 0.2-0.5 MB). The import reads a `.csv.gz` as is,
and a browser that unpacks it on download doesn't matter either: the import
recognises gzip by its content, not its name.

Per-season downloads are one season at a time because Vercel caps a response at about
4.5 MB. If a season's transactions are still too large, the download answers
`413` with the exact `&part=1`, `&part=2`, … links to use, and each part keeps
the header. Join them the same way as below. The report has a 4-minute
budget: any season it couldn't finish is listed under `notChecked` (never as
missing). Check that season on its own with `?file=report&season=YYYY`. To build the import's single 2025-and-earlier transaction file, join
the per-season CSVs while keeping one header:

```bash
{ head -1 antlerboard-yahoo-2021-transactions.csv; for y in 2021 2022 2023 2024 2025; do tail -n +2 antlerboard-yahoo-$y-transactions.csv; done; } > yahoo-transactions-2021-2025.csv
```

Check the result against the import's ~4.5 MB upload limit (runbook §1). The
`season=all` gzipped download makes this step unnecessary.

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
  - `/transactions;start=…;count=25`, paged until a page adds nothing new.
    The report skips this for the connected season (2026), whose log the
    daily sync keeps. Re-reading it used up Yahoo's rate limit before the
    older seasons were reached (production report, 2026-10-15).
- **Pacing and retries:** requests are 500 ms apart. The client retries
  Yahoo rate limits (999/429) and server errors twice with backoff
  (1 s, 3 s). If Yahoo is still throttling after that, the export waits
  20 s and asks again, then 45 s, then gives up on that season. After a
  throttle the rest of the run goes 1 s apart. A wait that would pass the
  4-minute budget isn't started.
- **Failures:** a section that still fails is recorded in the report. An
  expired or rejected token ends the run with `409`.

## Rate limits

Yahoo throttles bursts with a non-standard HTTP **999**. Next.js's
server-side `fetch` used to turn that into a thrown `RangeError` (`init["status"]
must be in the range of 200 to 599`), so the client's retries never ran. Fixed:
Yahoo requests now carry an `AbortSignal` (a 30-second timeout), which takes them
out of Next's request de-duplication, so a 999 reaches the client and is retried
with backoff. On 2026-10-15 Yahoo throttled the report after about 20
requests in quick succession and kept refusing through the 1 s and 3 s
retries, which is why the export now pauses for 20-45 s and slows down. If
Yahoo keeps refusing, the report says so under `notChecked`.
Running the export straight after a Sync Now makes throttling more likely,
since the sync has just made a burst of requests. Waiting about 10 minutes
(still inside the token's hour) should help, though that's a guess, not a
measured fact.

## Reading the report

- `recovered`: what Yahoo returned in full, with counts.
- `inaccessible`: seasons or sections Yahoo refused or that failed, with
  Yahoo's own error.
- `requiresOriginalFiles`: what the original files must still supply.
  - Per season: a missing draft, unpriced picks, or an unreadable season.
  - Always: recorded keeper costs and overrides, which picks were keepers,
    offseason trades, pre-2021 history and FYPD (already stored).
- `notChecked`: what this run couldn't read. This covers Yahoo's rate
  limit (HTTP 999), a temporary error, a timeout or the time budget, and
  anything after that point in a season. It's **unknown, not missing**:
  never treat it as a gap or as complete. Retry later. A transaction log
  cut short is never presented as the log: the season's
  `transactions.complete` is `false`, there's no Antlerboard comparison,
  and its CSV download answers `503`.
- Only Yahoo's own refusal (400, 403 or 404) puts a season in
  `inaccessible` and `requiresOriginalFiles`.
- `seasons[].antlerboard`: for seasons Antlerboard already synced, how many
  Yahoo transaction keys match the stored ones.
- `seasons[].transactions.skipped`: why the log wasn't read this run (the
  connected season). Its `recovered` line gives how many transactions
  Antlerboard stores. It's neither missing nor unchecked.
