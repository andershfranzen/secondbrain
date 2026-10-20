BEGIN;
CREATE VIEW item_records AS SELECT k.*, coalesce(m.assertion,t.action,i.thought,p.current_state,e.canonical_name,'') AS content,
 m.category,m.epistemic_state,m.valid_from,m.valid_until,m.supersedes_item_id,
 p.outcome,p.current_state,p.last_decision,p.blocker,p.next_step,p.summary_edited_by_user,
 t.action,t.disposition,t.status,t.due_date,t.due_at,t.completed_at,
 coalesce(t.project_id,i.project_id) AS project_id,e.entity_type,e.canonical_name,
 coalesce(p.aliases,e.aliases,'{}'::text[]) AS aliases
 FROM knowledge_items k LEFT JOIN memories m ON m.item_id=k.id LEFT JOIN projects p ON p.item_id=k.id
 LEFT JOIN tasks t ON t.item_id=k.id LEFT JOIN ideas i ON i.item_id=k.id LEFT JOIN entities e ON e.item_id=k.id;
COMMIT;
