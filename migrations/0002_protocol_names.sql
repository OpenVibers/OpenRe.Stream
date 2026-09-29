-- phase: migrate
-- One protocol name per transport (T4 decision 2): 'whip' is an input alias, stored as 'webrtc', and
-- the 'webrtc-ingest'/'sfu' worker kinds are one 'webrtc' worker. Rewrite the rows written before the
-- rename. Never edited after it runs; a further rename is a new migration.
--
-- Protocols: map 'whip' to 'webrtc' and drop duplicates, keeping the first occurrence's position.
-- (Stream definitions are the only place protocols are stored; workers.store validates on write.)
UPDATE stream_definitions
SET protocols = (
    SELECT jsonb_agg(x.p ORDER BY x.ord)::text
    FROM (
        SELECT DISTINCT ON (mapped) mapped AS p, ord
        FROM (
            SELECT (CASE WHEN v = 'whip' THEN 'webrtc' ELSE v END) AS mapped, ord
            FROM jsonb_array_elements_text(protocols::jsonb) WITH ORDINALITY AS e(v, ord)
        ) m
        ORDER BY mapped, ord
    ) x
)
WHERE protocols LIKE '%"whip"%';

-- Workers: both legacy kinds become 'webrtc'. Their generations were unique only within each old
-- kind, so they are renumbered into one clean run for UNIQUE (kind, generation). No 'webrtc' row can
-- exist before this migration (the kind is introduced with it), so the merge cannot collide.
WITH legacy AS (
    SELECT id, -(row_number() OVER (ORDER BY generation, started_at, id)) AS tmp
    FROM workers
    WHERE kind IN ('webrtc-ingest', 'sfu')
)
UPDATE workers w
SET kind = 'webrtc', generation = legacy.tmp
FROM legacy
WHERE w.id = legacy.id;

WITH merged AS (
    SELECT id, row_number() OVER (ORDER BY generation, started_at, id) AS rn
    FROM workers
    WHERE kind = 'webrtc'
)
UPDATE workers w
SET generation = merged.rn
FROM merged
WHERE w.id = merged.id;
