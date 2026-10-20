BEGIN;
-- One-tap undo. A turn keeps what it changed: the items it created, and for each
-- item it updated the rows as they were before (item, kind detail, source links).
-- Undo restores those rows and retires the created items; a later change to any
-- of them blocks it. Erasure clears undo data that holds the erased text.
ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_status_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_check
  CHECK (status IN ('completed', 'invalidated', 'undone'));
ALTER TABLE agent_turns ADD COLUMN undo jsonb;
ALTER TABLE agent_turns ADD COLUMN undo_items uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_turns ADD COLUMN undone_at timestamptz;
CREATE INDEX agent_turns_undo_items_idx ON agent_turns USING gin (undo_items);
COMMIT;
