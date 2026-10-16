-- One-time data correction: remove the second copy of each historical prop bet.
--
-- Same cause as scripts/dedupe-historical-trades.sql: the workbook import
-- (/api/commissioner/import/historical/commit) created prop-bet rows on every
-- run until #30. 20 rows on 2026-09-21 17:54 UTC, then 16 identical rows on
-- 2026-09-22 03:16 UTC. 36 rows, 20 distinct bets (read-only, 2026-10-16).
--
-- Keeps the oldest row of each group of rows identical in every content
-- column (team links included), deletes the rest. Nothing references
-- HistoricalPropBet rows, so a delete removes nothing else.
--
-- PRODUCTION WRITE - NOT RUN. Only with the commissioner's explicit approval,
-- after a Neon backup branch of main. All-or-nothing: each guard raises,
-- rolling everything back, if production isn't exactly in the state this
-- was written for.
--
--   psql "$PROD_URL" -v ON_ERROR_STOP=1 -f scripts/dedupe-historical-prop-bets.sql

begin;

create temporary table pb_groups on commit drop as
select id,
       row_number() over (
         partition by "leagueId", "seasonYear", "teamAName", "teamAId", "teamBName", "teamBId", amount, description, "sourceRef"
         order by "createdAt", id
       ) as copy
from "HistoricalPropBet";

do $$
begin
  if (select count(*) from "HistoricalPropBet") <> 36 then
    raise exception 'Expected 36 historical prop bets - stop.';
  end if;
  if (select count(*) from pb_groups where copy = 1) <> 20 or (select count(*) from pb_groups where copy = 2) <> 16
     or exists (select 1 from pb_groups where copy > 2) then
    raise exception 'Expected 20 distinct prop bets with 16 duplicated exactly once - stop.';
  end if;
end $$;

delete from "HistoricalPropBet" where id in (select id from pb_groups where copy > 1);

insert into "AuditLogEntry" (id, "actorName", action, "entityType", "isHistoricalCorrection", before, after)
values ('historical-prop-bet-dedupe', 'Commissioner (applied by Claude Code)', 'HISTORICAL_PROP_BET_DEDUPE', 'HistoricalPropBet', true,
        '{"rows": 36, "distinct": 20}', '{"rows": 20, "distinct": 20}');

do $$
begin
  if (select count(*) from "HistoricalPropBet") <> 20
     or (select count(distinct "sourceRef") from "HistoricalPropBet") <> 20 then
    raise exception 'Post-check failed - rolling back.';
  end if;
end $$;

commit;
