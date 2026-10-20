BEGIN;
-- Retain the actual result of an accepted proposal, including selection of an
-- existing target or creation of a replacement assertion. Never infer an old
-- reviewed target from its name. Legacy target selections remain unknown.
ALTER TABLE review_proposals
  ADD COLUMN resolved_item_id uuid REFERENCES knowledge_items(id) ON DELETE SET NULL,
  ADD COLUMN relationship_context_unchanged boolean NOT NULL DEFAULT false;
UPDATE review_proposals p SET resolved_item_id=k.id
FROM knowledge_items k
WHERE p.status='accepted' AND k.origin_key='review:' || p.id::text;
CREATE INDEX review_resolved_item_idx ON review_proposals(resolved_item_id)
  WHERE resolved_item_id IS NOT NULL;
COMMIT;
