BEGIN;
-- Reserve a response position after each question. Existing sessions may have
-- queued several questions before an earlier answer arrived; pair those answers
-- with their request rather than preserving arrival order.
CREATE TEMP TABLE recall_turn_order ON COMMIT DROP AS
SELECT m.id,m.conversation_id,
  ((dense_rank() OVER (PARTITION BY m.conversation_id ORDER BY coalesce(q.ordinal,m.ordinal)))-1)*2
    + CASE WHEN m.role='assistant' THEN 1 ELSE 0 END AS new_ordinal
FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.mode='recall'
LEFT JOIN recall_requests r ON m.role='assistant' AND m.origin_key='answer:'||r.job_id::text
LEFT JOIN messages q ON q.id=r.question_message_id;
-- Move above the current range first to avoid transient unique collisions.
WITH bounds AS (SELECT conversation_id,max(ordinal)+1 AS offset FROM messages GROUP BY conversation_id)
UPDATE messages m SET ordinal=m.ordinal+b.offset FROM bounds b,recall_turn_order o
WHERE m.id=o.id AND b.conversation_id=m.conversation_id;
UPDATE messages m SET ordinal=o.new_ordinal FROM recall_turn_order o WHERE m.id=o.id;
COMMIT;
