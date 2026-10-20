BEGIN;
-- One agent turn handles every message: a note, a question, an update, or all
-- of them at once. The regex router, fixed extraction rules and review queue
-- are retired; the agent records its own uncertainty instead of asking.

ALTER TABLE conversations DROP CONSTRAINT conversations_mode_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_mode_check
  CHECK (mode IN ('text', 'audio', 'recall', 'manual', 'chat'));

ALTER TABLE processing_jobs DROP CONSTRAINT processing_jobs_kind_check;
ALTER TABLE processing_jobs ADD CONSTRAINT processing_jobs_kind_check CHECK (kind IN
  ('transcribe', 'extract', 'reconcile', 'embed', 'answer', 'purge', 'export',
   'retention', 'rebuild', 'converse'));

-- A source is evidence only when it records what the user said. Questions stay
-- preserved originals but can never support a memory or an answer. New chat
-- messages are 'pending' until their agent turn decides what they were.
ALTER TABLE sources ADD COLUMN kind text NOT NULL DEFAULT 'note'
  CHECK (kind IN ('note', 'question', 'pending'));

-- Every item carries the agent's confidence as a visible label.
ALTER TABLE knowledge_items ADD COLUMN certainty text NOT NULL DEFAULT 'confirmed'
  CHECK (certainty IN ('confirmed', 'unconfirmed'));
UPDATE knowledge_items k SET certainty='unconfirmed'
  FROM memories m WHERE m.item_id=k.id AND m.epistemic_state<>'confirmed';

-- Commitments: who asked, when it was agreed, a loose deadline in the user's
-- words ("next month") and when it was last mentioned.
ALTER TABLE tasks ADD COLUMN requested_by text CHECK (length(requested_by) BETWEEN 1 AND 300);
ALTER TABLE tasks ADD COLUMN agreed_at timestamptz;
ALTER TABLE tasks ADD COLUMN due_hint text CHECK (length(due_hint) BETWEEN 1 AND 300);
ALTER TABLE tasks ADD COLUMN last_mentioned_at timestamptz;

DROP VIEW item_records;
CREATE VIEW item_records AS SELECT k.*, coalesce(m.assertion,t.action,i.thought,p.current_state,e.canonical_name,'') AS content,
 m.category,m.epistemic_state,m.valid_from,m.valid_until,m.supersedes_item_id,
 p.outcome,p.current_state,p.last_decision,p.blocker,p.next_step,p.summary_edited_by_user,
 t.action,t.disposition,t.status,t.due_date,t.due_at,t.completed_at,
 t.requested_by,t.agreed_at,t.due_hint,t.last_mentioned_at,
 coalesce(t.project_id,i.project_id) AS project_id,e.entity_type,e.canonical_name,
 coalesce(p.aliases,e.aliases,'{}'::text[]) AS aliases
 FROM knowledge_items k LEFT JOIN memories m ON m.item_id=k.id LEFT JOIN projects p ON p.item_id=k.id
 LEFT JOIN tasks t ON t.item_id=k.id LEFT JOIN ideas i ON i.item_id=k.id LEFT JOIN entities e ON e.item_id=k.id;

-- The result of one agent turn. The reply is never evidence. Lineage lists every
-- source the agent read or cited, so erasing a source invalidates the turn.
CREATE TABLE agent_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES processing_jobs(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  message_id uuid REFERENCES messages(id),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'invalidated')),
  message_kind text NOT NULL CHECK (message_kind IN ('note', 'question', 'mixed', 'instruction')),
  reply jsonb NOT NULL,
  actions jsonb NOT NULL DEFAULT '[]',
  steps jsonb NOT NULL DEFAULT '[]',
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_turns_conversation_idx ON agent_turns (conversation_id, created_at);
CREATE INDEX agent_turns_message_idx ON agent_turns (message_id) WHERE message_id IS NOT NULL;
CREATE TABLE agent_turn_sources (
  turn_id uuid NOT NULL REFERENCES agent_turns(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  PRIMARY KEY (turn_id, source_id)
);
CREATE INDEX agent_turn_sources_reverse_idx ON agent_turn_sources (source_id);

-- Captures still waiting for the retired extraction pipeline, or holding review
-- proposals nobody decided, get a fresh agent pass; it records what is missing.
INSERT INTO processing_jobs(kind,dedupe_key,conversation_id,payload)
SELECT 'converse','converse:legacy:'||c.id::text,c.id,'{"hint":"note"}'::jsonb
FROM conversations c
WHERE c.mode IN ('text','audio') AND c.state<>'deleting'
  AND (EXISTS(SELECT 1 FROM processing_jobs j WHERE j.conversation_id=c.id
      AND j.kind IN ('extract','reconcile') AND j.status IN ('pending','retry_wait','running','failed'))
    OR EXISTS(SELECT 1 FROM review_proposals r JOIN processing_jobs j ON j.id=r.extraction_job_id
      WHERE j.conversation_id=c.id AND r.status='pending'))
ON CONFLICT (dedupe_key) DO NOTHING;
UPDATE processing_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now()
WHERE kind IN ('extract','reconcile','answer') AND status IN ('pending','retry_wait','running');
UPDATE recall_requests SET status='failed' WHERE status='pending';
UPDATE review_proposals SET status='invalidated' WHERE status='pending';
UPDATE conversations SET state='ready' WHERE state='needs_review';
COMMIT;
