-- Run after 0001_initial.sql on a disposable PostgreSQL database.
-- Fixtures roll back; failures propagate through psql ON_ERROR_STOP.
BEGIN;
DO $$
DECLARE
  conversation uuid := gen_random_uuid();
  message uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  task uuid := gen_random_uuid();
  idea uuid := gen_random_uuid();
  job uuid := gen_random_uuid();
BEGIN
  INSERT INTO conversations (id, client_capture_id, payload_sha256, mode, capture_timezone)
    VALUES (conversation, gen_random_uuid(), repeat('a', 64), 'text', 'Europe/Copenhagen');
  INSERT INTO messages (id, conversation_id, ordinal, role, content, origin_key)
    VALUES (message, conversation, 0, 'user', 'I will verify Forgejo tomorrow.', 'smoke-message');
  INSERT INTO sources (id, message_id, origin_key, content)
    VALUES (source, message, 'smoke-source', 'I will verify Forgejo tomorrow.');
  INSERT INTO knowledge_items (id, kind, title, origin_key, created_by)
    VALUES (task, 'task', 'Verify Forgejo', 'smoke-task', 'worker'),
      (idea, 'idea', 'Another server', 'smoke-idea', 'worker');
  INSERT INTO tasks (item_id, action, disposition, due_date, due_source_id)
    VALUES (task, 'Verify Forgejo', 'commitment', '2026-10-20', source);
  INSERT INTO ideas (item_id, thought) VALUES (idea, 'Maybe buy another server');
  INSERT INTO item_sources (item_id, source_id, start_offset, end_offset, quote, role, confidence)
    VALUES (task, source, 0, 29, 'I will verify Forgejo tomorrow', 'supports', 0.99);

  BEGIN
    INSERT INTO tasks (item_id, action, disposition) VALUES (idea, 'Invalid kind', 'commitment');
    RAISE EXCEPTION 'wrong registry kind was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  BEGIN
    UPDATE tasks SET due_at = '2026-10-20T12:00:00Z' WHERE item_id = task;
    RAISE EXCEPTION 'two deadline types were accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE tasks SET status = 'completed' WHERE item_id = task;
    RAISE EXCEPTION 'completion without timestamp was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE sources SET audio_start_ms = 0 WHERE id = source;
    RAISE EXCEPTION 'partial audio range was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO knowledge_items (kind, title, origin_key, created_by)
      VALUES ('task', 'Duplicate', 'smoke-task', 'worker');
    RAISE EXCEPTION 'duplicate generated origin was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  INSERT INTO processing_jobs (id, conversation_id, kind, dedupe_key)
    VALUES (job, conversation, 'extract', 'smoke-extract');
  BEGIN
    UPDATE processing_jobs SET status = 'running' WHERE id = job;
    RAISE EXCEPTION 'running job without lease was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE processing_jobs SET status = 'running', lease_token = gen_random_uuid(),
    lease_until = now() + interval '120 seconds' WHERE id = job;

  INSERT INTO embeddings (source_id, model, input_sha256, chunk_index, start_offset, end_offset, content)
    VALUES (source, 'lexical-v1', repeat('b', 64), 0, 0, 30, 'I will verify Forgejo tomorrow.');
  IF NOT EXISTS (SELECT 1 FROM embeddings WHERE source_id = source
      AND search_document @@ websearch_to_tsquery('simple', 'Forgejo')) THEN
    RAISE EXCEPTION 'lexical search failed without a vector';
  END IF;
  BEGIN
    UPDATE embeddings SET embedding = '[1,2,3]'::vector WHERE source_id = source;
    RAISE EXCEPTION 'wrong vector dimension was accepted';
  EXCEPTION WHEN data_exception THEN NULL;
  END;
END $$;
ROLLBACK;
