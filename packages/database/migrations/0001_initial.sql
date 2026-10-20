-- PostgreSQL 17 + pgvector. Run once through a versioned migration runner.
-- Single-user schema. Domain transactions enforce the invariants documented
-- in docs/implementation-spec.md; this migration is not an application.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE app_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  timezone text NOT NULL DEFAULT 'Europe/Copenhagen',
  audio_retention_days integer NOT NULL DEFAULT 30 CHECK (audio_retention_days >= 0),
  cloud_consent_at timestamptz,
  active_embedding_model text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings (singleton) VALUES (true);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_capture_id uuid UNIQUE,
  payload_sha256 text CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('text', 'audio', 'recall', 'manual')),
  title text,
  capture_timezone text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued', 'transcribing', 'organizing', 'ready', 'needs_review', 'failed', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode NOT IN ('text', 'audio') OR
    (client_capture_id IS NOT NULL AND payload_sha256 IS NOT NULL))
);
CREATE INDEX conversations_order_idx ON conversations (created_at DESC, id DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  origin_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, ordinal)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 104857600),
  duration_ms integer CHECK (duration_ms > 0 AND duration_ms <= 1800000),
  state text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'purging', 'purged')),
  retain_until timestamptz,
  purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'purged') = (purged_at IS NOT NULL))
);
CREATE INDEX attachments_retention_idx ON attachments (retain_until)
  WHERE state = 'available';

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  attachment_id uuid REFERENCES attachments(id),
  origin_key text NOT NULL UNIQUE,
  content text NOT NULL CHECK (length(content) > 0),
  available boolean NOT NULL DEFAULT true,
  audio_start_ms integer,
  audio_end_ms integer,
  supersedes_source_id uuid REFERENCES sources(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((audio_start_ms IS NULL AND audio_end_ms IS NULL) OR
    (audio_start_ms IS NOT NULL AND audio_end_ms IS NOT NULL AND
      attachment_id IS NOT NULL AND audio_start_ms >= 0 AND audio_end_ms > audio_start_ms)),
  CHECK (id IS DISTINCT FROM supersedes_source_id)
);
CREATE INDEX sources_message_idx ON sources (message_id);
CREATE INDEX sources_attachment_idx ON sources (attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX sources_supersedes_idx ON sources (supersedes_source_id)
  WHERE supersedes_source_id IS NOT NULL;

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('memory', 'project', 'task', 'idea', 'entity')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived', 'superseded')),
  projection_state text NOT NULL DEFAULT 'valid' CHECK (projection_state IN ('valid', 'invalidated')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  origin_key text NOT NULL UNIQUE,
  created_by text NOT NULL CHECK (created_by IN ('user', 'worker')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, kind)
);
CREATE INDEX knowledge_items_list_idx ON knowledge_items
  (kind, lifecycle, created_at DESC, id DESC);
CREATE INDEX knowledge_items_title_idx ON knowledge_items (lower(title));

CREATE TABLE memories (
  item_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'memory' CHECK (kind = 'memory'),
  assertion text NOT NULL CHECK (length(assertion) > 0),
  category text NOT NULL CHECK (category IN ('fact', 'preference', 'decision', 'context')),
  epistemic_state text NOT NULL CHECK (epistemic_state IN ('confirmed', 'uncertain', 'proposed', 'contradicted')),
  valid_from timestamptz,
  valid_until timestamptz,
  supersedes_item_id uuid REFERENCES memories(item_id),
  FOREIGN KEY (item_id, kind) REFERENCES knowledge_items(id, kind),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK (item_id IS DISTINCT FROM supersedes_item_id)
);

CREATE TABLE projects (
  item_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'project' CHECK (kind = 'project'),
  outcome text,
  current_state text,
  last_decision text,
  blocker text,
  next_step text,
  aliases text[] NOT NULL DEFAULT '{}',
  summary_edited_by_user boolean NOT NULL DEFAULT false,
  FOREIGN KEY (item_id, kind) REFERENCES knowledge_items(id, kind)
);
CREATE INDEX projects_aliases_idx ON projects USING gin (aliases);

CREATE TABLE tasks (
  item_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'task' CHECK (kind = 'task'),
  action text NOT NULL CHECK (length(action) > 0),
  project_id uuid REFERENCES projects(item_id),
  disposition text NOT NULL CHECK (disposition IN ('commitment', 'suggested')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  due_date date,
  due_at timestamptz,
  due_source_id uuid REFERENCES sources(id),
  completed_at timestamptz,
  FOREIGN KEY (item_id, kind) REFERENCES knowledge_items(id, kind),
  CHECK (due_date IS NULL OR due_at IS NULL),
  CHECK ((due_date IS NULL AND due_at IS NULL) OR due_source_id IS NOT NULL),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX tasks_project_idx ON tasks (project_id);
CREATE INDEX tasks_open_date_idx ON tasks (due_date, due_at) WHERE status IN ('open', 'in_progress');

CREATE TABLE ideas (
  item_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'idea' CHECK (kind = 'idea'),
  thought text NOT NULL CHECK (length(thought) > 0),
  project_id uuid REFERENCES projects(item_id),
  FOREIGN KEY (item_id, kind) REFERENCES knowledge_items(id, kind)
);
CREATE INDEX ideas_project_idx ON ideas (project_id);

CREATE TABLE entities (
  item_id uuid PRIMARY KEY,
  kind text NOT NULL DEFAULT 'entity' CHECK (kind = 'entity'),
  entity_type text NOT NULL CHECK (entity_type IN ('person', 'product', 'organization', 'place', 'concept')),
  canonical_name text NOT NULL CHECK (length(canonical_name) > 0),
  aliases text[] NOT NULL DEFAULT '{}',
  FOREIGN KEY (item_id, kind) REFERENCES knowledge_items(id, kind)
);
CREATE INDEX entities_aliases_idx ON entities USING gin (aliases);

CREATE TABLE item_sources (
  item_id uuid NOT NULL REFERENCES knowledge_items(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  quote text NOT NULL CHECK (length(quote) > 0),
  role text NOT NULL CHECK (role IN ('supports', 'corrects', 'contradicts')),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (item_id, source_id, start_offset, end_offset, role)
);
CREATE INDEX item_sources_reverse_idx ON item_sources (source_id, item_id);

CREATE TABLE relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  to_item_id uuid NOT NULL REFERENCES knowledge_items(id),
  type text NOT NULL CHECK (type IN ('related_to', 'part_of', 'precedes', 'depends_on', 'mentions')),
  origin_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_item_id, to_item_id, type),
  CHECK (from_item_id <> to_item_id)
);
CREATE INDEX relationships_reverse_idx ON relationships (to_item_id, type);

CREATE TABLE relationship_sources (
  relationship_id uuid NOT NULL REFERENCES relationships(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  quote text NOT NULL CHECK (length(quote) > 0),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  PRIMARY KEY (relationship_id, source_id, start_offset, end_offset)
);
CREATE INDEX relationship_sources_reverse_idx ON relationship_sources (source_id);

CREATE TABLE processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  parent_job_id uuid REFERENCES processing_jobs(id),
  kind text NOT NULL CHECK (kind IN
    ('transcribe', 'extract', 'reconcile', 'embed', 'answer', 'purge', 'export', 'retention', 'rebuild')),
  dedupe_key text NOT NULL UNIQUE,
  input_version integer NOT NULL DEFAULT 1 CHECK (input_version > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  blocked_reason text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  provider_metadata jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX processing_jobs_due_idx ON processing_jobs (run_after, id)
  WHERE status IN ('pending', 'retry_wait') AND blocked_reason IS NULL;
CREATE INDEX processing_jobs_leases_idx ON processing_jobs (lease_until) WHERE status = 'running';
CREATE INDEX processing_jobs_conversation_idx ON processing_jobs (conversation_id);

CREATE TABLE review_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_job_id uuid NOT NULL REFERENCES processing_jobs(id),
  origin_key text NOT NULL UNIQUE,
  candidate_local_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'invalidated')),
  reason text NOT NULL,
  proposed_change jsonb NOT NULL,
  expected_revisions jsonb NOT NULL DEFAULT '{}',
  resolved_operation_id uuid UNIQUE,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status NOT IN ('accepted', 'rejected') OR resolved_at IS NOT NULL)
);
CREATE INDEX review_proposals_pending_idx ON review_proposals (created_at, id) WHERE status = 'pending';
CREATE TABLE review_proposal_sources (
  proposal_id uuid NOT NULL REFERENCES review_proposals(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  PRIMARY KEY (proposal_id, source_id)
);
CREATE INDEX review_proposal_sources_reverse_idx ON review_proposal_sources (source_id);

CREATE TABLE memory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES knowledge_items(id),
  operation_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN
    ('created', 'updated', 'sourced', 'superseded', 'archived', 'restored', 'invalidated')),
  actor text NOT NULL CHECK (actor IN ('user', 'worker')),
  source_id uuid REFERENCES sources(id),
  before_snapshot jsonb,
  after_snapshot jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, item_id)
);
CREATE INDEX memory_events_item_idx ON memory_events (item_id, created_at, id);
CREATE INDEX memory_events_source_idx ON memory_events (source_id) WHERE source_id IS NOT NULL;

CREATE TABLE embeddings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id),
  item_id uuid REFERENCES knowledge_items(id),
  item_revision integer CHECK (item_revision > 0),
  model text NOT NULL,
  input_sha256 text NOT NULL CHECK (input_sha256 ~ '^[a-f0-9]{64}$'),
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  content text NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding vector(1536), -- NULL allows lexical indexing while provider is unavailable
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_id IS NOT NULL) <> (item_id IS NOT NULL)),
  CHECK ((item_id IS NOT NULL) = (item_revision IS NOT NULL))
);
CREATE UNIQUE INDEX embeddings_source_unique_idx ON embeddings (source_id, model, chunk_index)
  WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX embeddings_item_unique_idx ON embeddings (item_id, item_revision, model, chunk_index)
  WHERE item_id IS NOT NULL;
CREATE INDEX embeddings_text_idx ON embeddings USING gin (search_document);
CREATE INDEX embeddings_vector_idx ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX embeddings_model_idx ON embeddings (model);

CREATE TABLE recall_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_request_id uuid NOT NULL UNIQUE,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  question_message_id uuid NOT NULL REFERENCES messages(id),
  project_id uuid REFERENCES projects(item_id),
  job_id uuid NOT NULL UNIQUE REFERENCES processing_jobs(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'invalidated')),
  final_answer jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE recall_request_sources (
  request_id uuid NOT NULL REFERENCES recall_requests(id),
  source_id uuid NOT NULL REFERENCES sources(id),
  PRIMARY KEY (request_id, source_id)
);
CREATE INDEX recall_request_sources_reverse_idx ON recall_request_sources (source_id);
CREATE TABLE recall_events (
  request_id uuid NOT NULL REFERENCES recall_requests(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  type text NOT NULL CHECK (type IN ('status', 'answer', 'complete', 'error')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, sequence)
);

CREATE TABLE exports (
  job_id uuid PRIMARY KEY REFERENCES processing_jobs(id),
  storage_key text UNIQUE,
  expires_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE export_sources (
  job_id uuid NOT NULL REFERENCES exports(job_id),
  source_id uuid NOT NULL REFERENCES sources(id),
  PRIMARY KEY (job_id, source_id)
);
CREATE INDEX export_sources_reverse_idx ON export_sources (source_id);
CREATE TABLE attachment_pins (
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  job_id uuid NOT NULL REFERENCES processing_jobs(id),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (attachment_id, job_id)
);

-- Content-free erasure ledger, included in backups and kept separately on the
-- backup destination. Restore replays newer erasures before serving traffic.
CREATE TABLE erasures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL, -- deliberately no FK: survives hard deletion
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  retain_until timestamptz NOT NULL,
  UNIQUE (conversation_id)
);
COMMIT;
