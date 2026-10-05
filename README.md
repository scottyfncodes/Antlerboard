# Antlerboard

The Claw & Antler League's (C&A) front office. Yahoo runs the fantasy
league; Antlerboard understands it - keeper history, keeper costs, tags,
trades, DPUD, draft colors, and league history all live here, and none of
it is ever overwritten by a Yahoo sync.

## Stack

- **Next.js 15** (App Router) + React 19 + TypeScript
- **Tailwind CSS v4** for styling
- **PostgreSQL** via **Prisma** (targets Vercel Postgres/Neon in production)
- **Vitest** for unit + integration tests
- Web Push via `web-push` (VAPID) for optional notifications
- Deployed on **Vercel**, including Vercel Cron for scheduled sync/notifications

## Getting started

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL at minimum
npx prisma db push        # create the schema in your database
npm run db:seed           # load realistic C&A demo data
npm run dev
```

Open http://localhost:3000. The seed script creates a full fictional
league (10 teams, ~140 players, multi-season keeper history, trades, DPUD
bets, notifications) covering every keeper/tag/trade scenario in the spec.

### Environment variables

See `.env.example`. `DATABASE_URL` is required for everything else to
work; `YAHOO_CLIENT_ID`/`YAHOO_CLIENT_SECRET`/`YAHOO_REDIRECT_URI` are only
needed to exercise the Yahoo OAuth flow, and `VAPID_PUBLIC_KEY`/
`VAPID_PRIVATE_KEY` are only needed for Web Push. The app degrades
gracefully (with clear in-app messaging) when either is unset.

### Scripts

- `npm run dev` / `npm run build` / `npm start`
- `npm run lint`
- `npm test` - runs the Vitest suite once (uses `.env.test` / a separate
  test database - never your dev data)
- `npm run db:push` - sync `prisma/schema.prisma` to the database
- `npm run db:seed` - wipe and reload the demo league
- `npm run db:studio` - Prisma Studio

## Architecture notes

- `src/lib/keeper-engine.ts` is the **only** place keeper-year / keeper-cost
  / forced-redraft math happens. It's pure and fully unit tested
  (`keeper-engine.test.ts`). The confirmed C&A rules live in
  `src/lib/config.ts`: base price is the auction cost or winning FAAB bid,
  each kept year adds +1, +3, +5, +7, +9 (so year 5 is base + 25), five
  kept years then back to the auction, a drop resets the clock, a trade
  carries it, and an FYPD call-up is free but starts the clock at an
  assumed $4. `src/lib/keeper-sync.ts` bridges the engine to the database,
  materializing one `KeeperRecord` per player per season per stint:
  `startTeamId` is the team that declared the keeper, `teamId` the team
  holding the player after in-season trades, and `DROPPED` marks a row
  whose stint ended during that season.
- `src/lib/import/` holds the league-history import. Step 1 on
  Commissioner > Import > League History reads the master workbook (team
  names, trades, prop bets, FYPD boards). Step 2 takes three files - the
  master workbook, the canonical auction history, and the Yahoo
  transaction export - and `league-history-builder.ts` turns them into a
  dated event stream per player (drafts, FAAB adds with their bids, drops,
  in-season and offseason trades, releases at each keeper deadline), runs
  the engine over it, and reports every place the computed cost disagrees
  with the workbook before `league-history-commit.ts` writes anything.
  Recorded costs that differ are kept as flagged commissioner overrides.
  Every row the import writes carries a `league-history:` sourceRef, so a
  re-run replaces its own rows and leaves hand-entered data alone.
- `src/lib/draft-color-engine.ts` computes the 5-color draft cycle from a
  single anchor point, honoring skipped seasons without breaking the cycle.
- `src/lib/yahoo/` holds the OAuth client and sync engine. The sync engine
  only ever writes fields Yahoo actually owns (team names, standings,
  transactions) - see the comment at the top of `sync.ts`.
- `src/lib/trades.ts`, `src/lib/offers.ts`, `src/lib/dpud.ts` hold the state
  machines for Trade Center, Make Me an Offer, and DPUD, each with their
  own integration test file.
- Commissioner-only routes are gated server-side via
  `requireCommissioner()` in `src/lib/current-manager.ts`. There is no
  full auth system (see Known Limitations in the audit) - a
  manager-switcher cookie stands in for login, appropriate for a private,
  trusted league tool.

## Deploying

1. Create a Vercel Postgres (or Neon) database and set `DATABASE_URL`.
2. Run `npx prisma db push` and `npm run db:seed` against it, or import
   the real league history via Commissioner > Import > League History
   (Step 1 with the master workbook, then Step 2 with the master workbook,
   the auction history and the Yahoo transaction export - tick "remove the
   demo league" on the first Step 1 run).
3. Set the Yahoo/VAPID env vars if/when you want those features live.
4. Deploy to Vercel. `vercel.json` wires up two cron jobs
   (`/api/cron/yahoo-sync`, `/api/cron/notifications`) - both are protected
   by `CRON_SECRET`.
