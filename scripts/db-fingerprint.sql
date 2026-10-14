-- Read-only fingerprint of every table in the public schema: row count plus
-- an md5 of the rows' text form, in a stable order. Run it against two
-- databases (e.g. a source and a restored copy, or production and a backup
-- branch) and compare the output - identical JSON means identical data.
-- Safe against production: it only reads.
--
--   psql "$DATABASE_URL" -At -f scripts/db-fingerprint.sql
select json_object_agg(table_name, x.c || ':' || x.m order by table_name) from (
  select table_name,
         query_to_xml(format('select count(*) c, md5(coalesce(string_agg(t::text, E''\n'' order by t::text), '''')) m from public.%I t', table_name), false, true, '') q
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE'
) s,
lateral (select (xpath('/row/c/text()', q))[1]::text c, (xpath('/row/m/text()', q))[1]::text m) x;
