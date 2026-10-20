BEGIN;
-- The morning brief: one push a day built from the calendar, no model involved.
ALTER TABLE processing_jobs DROP CONSTRAINT processing_jobs_kind_check;
ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN
  ('transcribe', 'extract', 'reconcile', 'embed', 'answer', 'purge', 'export',
   'retention', 'rebuild', 'converse', 'brief'));
COMMIT;
