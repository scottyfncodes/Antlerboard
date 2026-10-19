-- Read-only. The seven FYPD players whose Yahoo id mappings are still pending
-- the commissioner's separate approval. Each must still have no Yahoo id.
-- Expect 7 rows, every "yahooPlayerId" empty.

-- F1. The seven players (ids re-read from production 2026-10-17)
SELECT p.id, p.name, p."yahooPlayerId", p."createdAt",
       (SELECT count(*) FROM "FypdSelection" f WHERE f."playerId" = p.id) AS fypd_selections
FROM "Player" p
WHERE p.id IN ('cmubjpgy0001wgqsl6sqoo7u8', 'cmubjph26003ggqslajf8accf', 'cmubjph2y003sgqsly95sf3rm',
               'cmubjpgxf001ogqsldnn2conf', 'cmubjpguv000ogqsleko5r9cb', 'cmubjpkhx008jgqsl2iipko5a',
               'cmubjpkgi007zgqslb1znlsgr')
ORDER BY p.name;

-- F2. Evidence only: any player already holding one of the proposed Yahoo ids
SELECT id, name, "yahooPlayerId"
FROM "Player"
WHERE "yahooPlayerId" IN ('64314', '64479', '64327', '64315', '64350', '65737', '65722')
   OR substring("yahooPlayerId" from '\.p\.(\d+)$') IN ('64314', '64479', '64327', '64315', '64350', '65737', '65722')
ORDER BY name;
