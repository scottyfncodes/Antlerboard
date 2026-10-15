-- One-time data correction: remove the second copy of each historical trade.
--
-- The trade log was loaded twice by /api/commissioner/import/historical/commit
-- (it creates trade rows on every run; team-season records it upserts):
-- 44 rows on 2026-09-21 17:54 UTC, then 43 identical rows on 2026-09-22
-- 03:16 UTC (every trade except "row 57"). 87 rows, 44 distinct trades.
--
-- Keeps the oldest row of each group of rows identical in every content
-- column (team links included), deletes the rest. Nothing references
-- HistoricalTrade rows, so a delete removes nothing else.
--
-- PRODUCTION WRITE - NOT RUN. Only with the commissioner's explicit approval,
-- after a Neon backup branch of main, and after the league-history import
-- (or before it - the content match includes the team links either way).
-- All-or-nothing: each guard raises, rolling everything back, if production
-- isn't exactly in the state this was written for.
--
--   psql "$PROD_URL" -v ON_ERROR_STOP=1 -f scripts/dedupe-historical-trades.sql

begin;

create temporary table ht_groups on commit drop as
select id,
       row_number() over (
         partition by "leagueId", "seasonYear", "tradeDate", "teamAName", "teamAId", "teamAPlayersRaw", "teamADropsRaw",
                      "teamBName", "teamBId", "teamBPlayersRaw", "teamBDropsRaw", "sourceRef"
         order by "createdAt", id
       ) as copy
from "HistoricalTrade";

do $$
begin
  if (select count(*) from "HistoricalTrade") <> 87 then
    raise exception 'Expected 87 historical trades - stop.';
  end if;
  if (select count(*) from ht_groups where copy = 1) <> 44 or (select count(*) from ht_groups where copy = 2) <> 43
     or exists (select 1 from ht_groups where copy > 2) then
    raise exception 'Expected 44 distinct trades with 43 duplicated exactly once - stop.';
  end if;
end $$;

delete from "HistoricalTrade" where id in (select id from ht_groups where copy > 1);

insert into "AuditLogEntry" (id, "actorName", action, "entityType", "isHistoricalCorrection", before, after)
values ('historical-trade-dedupe', 'Commissioner (applied by Claude Code)', 'HISTORICAL_TRADE_DEDUPE', 'HistoricalTrade', true,
        '{"rows": 87, "distinct": 44}', '{"rows": 44, "distinct": 44}');

do $$
begin
  if (select count(*) from "HistoricalTrade") <> 44
     or (select count(distinct "sourceRef") from "HistoricalTrade") <> 44 then
    raise exception 'Post-check failed - rolling back.';
  end if;
end $$;

commit;
