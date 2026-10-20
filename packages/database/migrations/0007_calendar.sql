BEGIN;
-- The calendar: a task is plotted between the day it starts (planned, scheduled
-- or allowed to begin) and its deadline. Either end is a date or, with a time,
-- an instant. Loose timing becomes a range ("next week": Monday to Sunday)
-- while due_hint keeps the user's words. due_source_id justifies the schedule.
ALTER TABLE tasks ADD COLUMN start_date date;
ALTER TABLE tasks ADD COLUMN start_at timestamptz;
ALTER TABLE tasks ADD CONSTRAINT tasks_start_check CHECK (start_date IS NULL OR start_at IS NULL);
ALTER TABLE tasks ADD CONSTRAINT tasks_start_source_check
  CHECK ((start_date IS NULL AND start_at IS NULL) OR due_source_id IS NOT NULL);
CREATE INDEX tasks_open_start_idx ON tasks (start_date, start_at) WHERE status IN ('open', 'in_progress');

DROP VIEW item_records;
CREATE VIEW item_records AS SELECT k.*, coalesce(m.assertion,t.action,i.thought,p.current_state,e.canonical_name,'') AS content,
 m.category,m.epistemic_state,m.valid_from,m.valid_until,m.supersedes_item_id,
 p.outcome,p.current_state,p.last_decision,p.blocker,p.next_step,p.summary_edited_by_user,
 t.action,t.disposition,t.status,t.due_date,t.due_at,t.completed_at,
 t.requested_by,t.agreed_at,t.due_hint,t.last_mentioned_at,t.start_date,t.start_at,
 coalesce(t.project_id,i.project_id) AS project_id,e.entity_type,e.canonical_name,
 coalesce(p.aliases,e.aliases,'{}'::text[]) AS aliases
 FROM knowledge_items k LEFT JOIN memories m ON m.item_id=k.id LEFT JOIN projects p ON p.item_id=k.id
 LEFT JOIN tasks t ON t.item_id=k.id LEFT JOIN ideas i ON i.item_id=k.id LEFT JOIN entities e ON e.item_id=k.id;
COMMIT;
