BEGIN;
-- Repeating commitments ("the cost report every month-end"). The task always
-- shows its next occurrence; completing it moves the dates to the following
-- one instead of closing the task. repeat_anchor is the day the series counts
-- from, so a month-end series stays at the month's end.
ALTER TABLE tasks ADD COLUMN repeat_every text CHECK (repeat_every IN ('day', 'week', 'month', 'year'));
ALTER TABLE tasks ADD COLUMN repeat_interval smallint CHECK (repeat_interval BETWEEN 1 AND 366);
ALTER TABLE tasks ADD COLUMN repeat_anchor date;
ALTER TABLE tasks ADD COLUMN last_done_at timestamptz;
ALTER TABLE tasks ADD CONSTRAINT tasks_repeat_check CHECK (
  (repeat_every IS NULL AND repeat_interval IS NULL AND repeat_anchor IS NULL)
  OR (repeat_every IS NOT NULL AND repeat_interval IS NOT NULL AND repeat_anchor IS NOT NULL));

DROP VIEW item_records;
CREATE VIEW item_records AS SELECT k.*, coalesce(m.assertion,t.action,i.thought,p.current_state,e.canonical_name,'') AS content,
 m.category,m.epistemic_state,m.valid_from,m.valid_until,m.supersedes_item_id,
 p.outcome,p.current_state,p.last_decision,p.blocker,p.next_step,p.summary_edited_by_user,
 t.action,t.disposition,t.status,t.due_date,t.due_at,t.completed_at,
 t.requested_by,t.agreed_at,t.due_hint,t.last_mentioned_at,t.start_date,t.start_at,
 t.repeat_every,t.repeat_interval,t.repeat_anchor,t.last_done_at,
 coalesce(t.project_id,i.project_id) AS project_id,e.entity_type,e.canonical_name,
 coalesce(p.aliases,e.aliases,'{}'::text[]) AS aliases
 FROM knowledge_items k LEFT JOIN memories m ON m.item_id=k.id LEFT JOIN projects p ON p.item_id=k.id
 LEFT JOIN tasks t ON t.item_id=k.id LEFT JOIN ideas i ON i.item_id=k.id LEFT JOIN entities e ON e.item_id=k.id;
COMMIT;
