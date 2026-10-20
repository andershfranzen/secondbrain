BEGIN;
-- What a running turn is doing right now (the tool it is using, the answer as
-- it is written), so the client can show it before the turn completes.
ALTER TABLE processing_jobs ADD COLUMN progress jsonb;
COMMIT;
