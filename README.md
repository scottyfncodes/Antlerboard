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
  (`keeper-engine.test.ts`). `src/lib/keeper-sync.ts` bridges it to the
  database, materializing results into `KeeperRecord` rows.
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
2. Run `npx prisma db push` and `npm run db:seed` against it (or import
   real league history via Commissioner > Import).
3. Set the Yahoo/VAPID env vars if/when you want those features live.
4. Deploy to Vercel. `vercel.json` wires up two cron jobs
   (`/api/cron/yahoo-sync`, `/api/cron/notifications`) - both are protected
   by `CRON_SECRET`.
