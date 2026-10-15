-- One-time data correction: relabel the two stored FYPD drafts by the
-- season they precede, as the app labels them everywhere (FypdDraft.year;
-- see the historical-import check route's FYPD_TABLE_*_YEAR). They were
-- written on 2026-09-21 one year low.
--
--   stored 2025 (Kade Anderson #1, 53 picks, 2025 MLB class) -> 2026 FYPD
--   stored 2024 (Konnor Griffin #1, 60 picks, 2024 MLB class) -> 2025 FYPD
--
-- Both were confirmed by the commissioner on 2026-10-15 against the league's
-- own pick lists (every pick, manager and player matched). The pending
-- import batch that duplicates the Griffin draft is discarded in the same
-- transaction.
--
-- PRODUCTION WRITE. Run only with the commissioner's explicit approval,
-- after taking a Neon backup branch of main. All-or-nothing: each guard
-- raises (rolling everything back) if production isn't exactly in the state
-- this was written for, and the row counts are checked at the end.
--
--   psql "$PROD_URL" -v ON_ERROR_STOP=1 -f scripts/fix-fypd-years.sql

begin;

do $$
begin
  if exists (select 1 from "FypdDraft" where year = 2026) then
    raise exception 'A 2026 FYPD already exists - stop.';
  end if;
  if (select count(*) from "FypdDraft" d join "FypdSelection" s on s."draftId" = d.id join "Player" p on p.id = s."playerId"
      where d.year = 2025 and s."overallPick" = 1 and p.name = 'Kade Anderson') <> 1
     or (select count(*) from "FypdSelection" s join "FypdDraft" d on d.id = s."draftId" where d.year = 2025) <> 53 then
    raise exception 'The stored 2025 FYPD is not the 53-pick Kade Anderson draft - stop.';
  end if;
  if (select count(*) from "FypdDraft" d join "FypdSelection" s on s."draftId" = d.id join "Player" p on p.id = s."playerId"
      where d.year = 2024 and s."overallPick" = 1 and p.name = 'Konnor Griffin') <> 1
     or (select count(*) from "FypdSelection" s join "FypdDraft" d on d.id = s."draftId" where d.year = 2024) <> 60 then
    raise exception 'The stored 2024 FYPD is not the 60-pick Konnor Griffin draft - stop.';
  end if;
end $$;

-- Order matters: (leagueId, year) is unique, so 2025 moves to 2026 first.
update "FypdDraft" set year = 2026, "updatedAt" = now() where year = 2025;
update "FypdDraft" set year = 2025, "updatedAt" = now() where year = 2024;

-- The staging batches the drafts were promoted from, for consistency.
update "FypdImportBatch" set "seasonYear" = 2026
  where status = 'CONFIRMED' and "seasonYear" = 2025 and label = 'Table 1 (cols A-D)';
update "FypdImportBatch" set "seasonYear" = 2025
  where status = 'CONFIRMED' and "seasonYear" = 2024 and label = 'Table 2 (cols R-Y)';

-- The pending batch is a second copy of the Griffin (2025 FYPD) picks.
update "FypdImportBatch" set status = 'DISCARDED',
  notes = 'Discarded 2026-10-15: duplicate of the 2025 FYPD (Konnor Griffin #1), already stored. Commissioner-confirmed.'
  where status = 'PENDING_REVIEW' and "seasonYear" = 2025 and label = 'Table 1 (cols A-D)'
    and jsonb_array_length("rawPicks"::jsonb) = 60;

insert into "AuditLogEntry" (id, "actorName", action, "entityType", "isHistoricalCorrection", before, after)
values (
  'fypd-year-relabel-2026-10-15', 'Commissioner (applied by Claude Code)', 'FYPD_YEAR_RELABEL', 'FypdDraft', true,
  '{"Kade Anderson draft": 2025, "Konnor Griffin draft": 2024, "pendingBatch": "PENDING_REVIEW"}',
  '{"Kade Anderson draft": 2026, "Konnor Griffin draft": 2025, "pendingBatch": "DISCARDED"}'
);

do $$
begin
  if (select count(*) from "FypdSelection" s join "FypdDraft" d on d.id = s."draftId" where d.year = 2026) <> 53
     or (select count(*) from "FypdSelection" s join "FypdDraft" d on d.id = s."draftId" where d.year = 2025) <> 60
     or exists (select 1 from "FypdDraft" where year = 2024)
     or (select count(*) from "FypdImportBatch" where status = 'PENDING_REVIEW') <> 0
     or (select count(*) from "FypdImportBatch" where status = 'CONFIRMED' and "seasonYear" = 2026) <> 1
     or (select count(*) from "FypdImportBatch" where status = 'CONFIRMED' and "seasonYear" = 2025) <> 2 then
    raise exception 'Post-check failed - rolling back.';
  end if;
end $$;

commit;
