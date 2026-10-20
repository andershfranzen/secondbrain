import {
  type Queryable,
  type Database,
  type Row,
  one,
  enqueue,
  indexText,
  camel,
} from "@secondbrain/database";
import {
  randomUUID,
  hash,
  fail,
  assertEvidence,
  Candidate,
  ItemPatch,
  normalize,
  operationId,
  type Evidence,
} from "@secondbrain/shared";
import { rollRepeat } from "./calendar.js";

export async function sourcesFor(db: Queryable, ids: string[]) {
  return (
    await db.query(
      `SELECT s.id,s.content,s.kind,m.created_at AS "createdAt",c.capture_timezone AS timezone FROM sources s JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id WHERE s.id=ANY($1::uuid[]) AND s.available AND c.state<>'deleting'`,
      [ids],
    )
  ).rows;
}
export async function sourceFor(db: Queryable, id: string) {
  const s = await one(
    db,
    `SELECT s.*,m.conversation_id,c.created_at AS captured_at,a.state AS audio_state FROM sources s JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id LEFT JOIN attachments a ON a.id=s.attachment_id WHERE s.id=$1 AND s.available AND c.state<>'deleting'`,
    [id],
  );
  return s ?? fail(404, "NOT_FOUND", "Source not found.");
}
export async function manualSource(db: Queryable, text: string) {
  const settings = (await one(db, "SELECT timezone FROM app_settings"))!,
    c = (await one(
      db,
      `INSERT INTO conversations(mode,capture_timezone,state,title) VALUES('manual',$1,'ready','Manual change') RETURNING *`,
      [settings.timezone],
    ))!;
  return addSource(db, c.id, text, `manual:${randomUUID()}`);
}
export async function addSource(
  db: Queryable,
  conversationId: string,
  text: string,
  key: string,
  attachmentId: string | null = null,
  startMs: number | null = null,
  endMs: number | null = null,
) {
  const existing = await one(db, "SELECT * FROM sources WHERE origin_key=$1", [
    key,
  ]);
  if (existing) return existing;
  const m = (await one(
    db,
    `INSERT INTO messages(conversation_id,ordinal,role,content,origin_key) SELECT $1,coalesce(max(ordinal)+1,0),'user',$2,$3 FROM messages WHERE conversation_id=$1 RETURNING *`,
    [conversationId, text, key],
  ))!;
  const s = (await one(
    db,
    `INSERT INTO sources(message_id,attachment_id,origin_key,content,audio_start_ms,audio_end_ms) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [m.id, attachmentId, key, text, startMs, endMs],
  ))!;
  await indexText(db, { sourceId: s.id }, text);
  return s;
}
export async function captureText(
  db: Database,
  input: { clientCaptureId: string; text: string },
) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.clientCaptureId,
    ]);
    const digest = hash(input.text),
      old = await one(
        tx,
        "SELECT * FROM conversations WHERE client_capture_id=$1",
        [input.clientCaptureId],
      );
    if (old) {
      if (old.payload_sha256 !== digest || old.mode !== "text")
        fail(
          409,
          "CAPTURE_CONFLICT",
          "That capture ID already belongs to different content.",
        );
      return {
        conversation: old,
        job: await one(
          tx,
          "SELECT * FROM processing_jobs WHERE conversation_id=$1 ORDER BY created_at LIMIT 1",
          [old.id],
        ),
        replay: true,
      };
    }
    const settings = (await one(
      tx,
      "SELECT timezone,maintenance FROM app_settings",
    ))!;
    if (settings.maintenance)
      fail(503, "MAINTENANCE", "Backup in progress. Try again shortly.");
    const c = (await one(
      tx,
      `INSERT INTO conversations(client_capture_id,payload_sha256,mode,capture_timezone,title) VALUES($1,$2,'text',$3,$4) RETURNING *`,
      [
        input.clientCaptureId,
        digest,
        settings.timezone,
        input.text.trim().split("\n")[0]!.slice(0, 120),
      ],
    ))!;
    await addSource(tx, c.id, input.text, `capture:${c.id}`);
    const job = await enqueue(
      tx,
      "converse",
      `converse:${c.id}:capture`,
      c.id,
      { hint: "note" },
    );
    return { conversation: c, job, replay: false };
  });
}
/**
 * The single composer. The original is stored and indexed before any AI runs;
 * one agent turn then decides whether it was a note, a question, or both.
 */
export async function postMessage(
  db: Database,
  input: { clientMessageId: string; text: string; conversationId?: string },
) {
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.clientMessageId,
    ]);
    const key = `message:${input.clientMessageId}`;
    const old = await one(tx, "SELECT * FROM messages WHERE origin_key=$1", [
      key,
    ]);
    if (old) {
      if (old.content !== input.text)
        fail(
          409,
          "MESSAGE_CONFLICT",
          "That message ID already belongs to different text.",
        );
      return {
        message: old,
        source: await one(tx, "SELECT * FROM sources WHERE message_id=$1", [
          old.id,
        ]),
        job: await one(
          tx,
          "SELECT * FROM processing_jobs WHERE dedupe_key=$1",
          [`converse:${old.id}`],
        ),
        replay: true,
      };
    }
    const settings = (await one(
      tx,
      "SELECT timezone,maintenance FROM app_settings",
    ))!;
    if (settings.maintenance)
      fail(503, "MAINTENANCE", "Backup in progress. Try again shortly.");
    let conversationId = input.conversationId;
    if (conversationId) {
      if (
        !(await one(
          tx,
          "SELECT id FROM conversations WHERE id=$1 AND mode='chat' AND state<>'deleting' FOR UPDATE",
          [conversationId],
        ))
      )
        fail(
          404,
          "CONVERSATION_NOT_FOUND",
          "That conversation no longer exists.",
        );
    } else
      conversationId = (await one(
        tx,
        "INSERT INTO conversations(mode,capture_timezone,state,title) VALUES('chat',$1,'ready',$2) RETURNING id",
        [settings.timezone, input.text.trim().split("\n")[0]!.slice(0, 120)],
      ))!.id;
    // Even ordinals hold messages; each reply takes the odd slot after its message.
    const message = (await one(
      tx,
      `INSERT INTO messages(conversation_id,ordinal,role,content,origin_key) SELECT $1,coalesce(max(ordinal)+2-(max(ordinal)%2),0),'user',$2,$3 FROM messages WHERE conversation_id=$1 RETURNING *`,
      [conversationId, input.text, key],
    ))!;
    const source = (await one(
      tx,
      `INSERT INTO sources(message_id,origin_key,content,kind) VALUES($1,$2,$3,'pending') RETURNING *`,
      [message.id, key, input.text],
    ))!;
    await indexText(tx, { sourceId: source.id }, input.text);
    const job = await enqueue(
      tx,
      "converse",
      `converse:${message.id}`,
      conversationId!,
      { messageIds: [message.id] },
    );
    return { message, source, job, replay: false };
  });
}
export async function getItem(db: Queryable, id: string) {
  const item = await one(db, "SELECT * FROM item_records WHERE id=$1", [id]);
  if (item?.projection_state === "invalidated")
    fail(
      410,
      "SOURCE_REMOVED",
      "This record is being rebuilt after a source was removed.",
    );
  return item ?? fail(404, "NOT_FOUND", "Item not found.");
}
export async function event(
  db: Queryable,
  id: string,
  op: string,
  type: string,
  actor: string,
  before: unknown,
  sourceId: string | null,
  reason: string,
) {
  const after = await getItem(db, id);
  await db.query(
    `INSERT INTO memory_events(item_id,operation_id,event_type,actor,source_id,before_snapshot,after_snapshot,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_id,item_id) DO NOTHING`,
    [
      id,
      op,
      type,
      actor,
      sourceId,
      before ? JSON.stringify(camel(before)) : null,
      JSON.stringify(camel(after)),
      reason,
    ],
  );
  await indexText(
    db,
    { itemId: id, revision: after.revision },
    [
      after.title,
      after.content,
      ...(after.aliases ?? []),
      ...["outcome", "last_decision", "blocker", "next_step"].flatMap((key) =>
        after[key] ? [`${key}: ${after[key]}`] : [],
      ),
    ].join("\n"),
  );
  await enqueue(db, "embed", `embed-item:${id}:${after.revision}`, null, {
    itemId: id,
    revision: after.revision,
  });
}
export async function linkEvidence(
  db: Queryable,
  id: string,
  evidence: Evidence[],
  role = "supports",
) {
  const live = await sourcesFor(db, [
    ...new Set(evidence.map((e) => e.sourceId)),
  ]);
  assertEvidence(evidence, live as any);
  for (const e of evidence)
    await db.query(
      `INSERT INTO item_sources(item_id,source_id,start_offset,end_offset,quote,role,confidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [id, e.sourceId, e.start, e.end, e.quote, role, 1],
    );
}
export async function createCandidate(
  db: Queryable,
  candidate: Candidate,
  key: string,
  actor = "worker",
  projectId: string | null = null,
) {
  const old = await one(
    db,
    "SELECT id FROM knowledge_items WHERE origin_key=$1",
    [key],
  );
  if (old) return getItem(db, old.id);
  if (
    candidate.kind !== "task" &&
    (candidate.commitment !== "none" || candidate.due)
  )
    fail(
      422,
      "INVALID_CANDIDATE",
      "Only tasks can have commitments or deadlines.",
    );
  const live = await sourcesFor(
    db,
    candidate.evidence.map((e) => e.sourceId),
  );
  assertEvidence(candidate.evidence, live as any);
  if (candidate.due) assertEvidence([candidate.due.evidence], live as any);
  const k = (await one(
      db,
      "INSERT INTO knowledge_items(kind,title,origin_key,created_by) VALUES($1,$2,$3,$4) RETURNING *",
      [candidate.kind, candidate.title, key, actor],
    ))!,
    id = k.id;
  switch (candidate.kind) {
    case "memory":
      await db.query(
        "INSERT INTO memories(item_id,assertion,category,epistemic_state) VALUES($1,$2,$3,$4)",
        [id, candidate.content, candidate.category, candidate.epistemicState],
      );
      break;
    case "project":
      await db.query(
        "INSERT INTO projects(item_id,outcome,current_state,last_decision,blocker,next_step) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          candidate.outcome,
          candidate.currentState,
          candidate.lastDecision,
          candidate.blocker,
          candidate.nextStep,
        ],
      );
      break;
    case "task":
      await db.query(
        "INSERT INTO tasks(item_id,action,disposition,project_id,due_date,due_at,due_source_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          candidate.content,
          candidate.commitment === "explicit" ? "commitment" : "suggested",
          projectId,
          candidate.due?.type === "date" ? candidate.due.value : null,
          candidate.due?.type === "instant" ? candidate.due.value : null,
          candidate.due?.evidence.sourceId ?? null,
        ],
      );
      break;
    case "idea":
      await db.query(
        "INSERT INTO ideas(item_id,thought,project_id) VALUES($1,$2,$3)",
        [id, candidate.content, projectId],
      );
      break;
    case "entity":
      await db.query(
        "INSERT INTO entities(item_id,canonical_name,entity_type) VALUES($1,$2,$3)",
        [id, candidate.title, candidate.entityType],
      );
      break;
  }
  await linkEvidence(db, id, candidate.evidence);
  await event(
    db,
    id,
    operationId(key),
    "created",
    actor,
    null,
    candidate.evidence[0]!.sourceId,
    "Created from source evidence",
  );
  return getItem(db, id);
}
export async function relationship(
  db: Queryable,
  from: string,
  to: string,
  type: string,
  evidence: Evidence[],
  key: string,
) {
  if (from === to) return;
  assertEvidence(
    evidence,
    (await sourcesFor(
      db,
      evidence.map((e) => e.sourceId),
    )) as any,
  );
  const r = (await one(
    db,
    `INSERT INTO relationships(from_item_id,to_item_id,type,origin_key) VALUES($1,$2,$3,$4) ON CONFLICT(from_item_id,to_item_id,type) DO UPDATE SET type=EXCLUDED.type RETURNING id`,
    [from, to, type, key],
  ))!;
  for (const e of evidence)
    await db.query(
      "INSERT INTO relationship_sources(relationship_id,source_id,start_offset,end_offset,quote,confidence) VALUES($1,$2,$3,$4,$5,1) ON CONFLICT DO NOTHING",
      [r.id, e.sourceId, e.start, e.end, e.quote],
    );
}
export async function patchItem(
  db: Queryable,
  id: string,
  expected: number,
  input: unknown,
  sourceId?: string,
) {
  const patch = ItemPatch.parse(input),
    old = await getItem(db, id);
  if (old.revision !== expected)
    fail(
      412,
      "STALE_REVISION",
      "This item changed. Refresh it before editing.",
    );
  if (
    old.kind === "memory" &&
    patch.content !== undefined &&
    patch.content !== old.content
  ) {
    if (patch.lifecycle)
      fail(422, "INVALID_CHANGE", "Correct and archive as separate actions.");
    const next = await correctMemory(
      db,
      id,
      expected,
      patch.content,
      "Manual correction",
    );
    if (patch.title && patch.title !== next.title) {
      await db.query(
        "UPDATE knowledge_items SET title=$1,revision=revision+1 WHERE id=$2",
        [patch.title, next.id],
      );
      await event(
        db,
        next.id,
        randomUUID(),
        "updated",
        "user",
        next,
        null,
        "Title changed during correction",
      );
    }
    return getItem(db, next.id);
  }
  if (patch.aliases && old.kind !== "project" && old.kind !== "entity")
    fail(422, "INVALID_FIELD", "Only projects and entities have aliases.");
  if (patch.status && old.kind !== "task")
    fail(422, "INVALID_FIELD", "Only tasks have a task status.");
  if (
    (patch.dueDate !== undefined || patch.dueAt !== undefined) &&
    old.kind !== "task"
  )
    fail(422, "INVALID_FIELD", "Only tasks have deadlines.");
  const projectFields = [
    "outcome",
    "currentState",
    "lastDecision",
    "blocker",
    "nextStep",
  ];
  if (old.kind !== "project" && projectFields.some((f) => f in patch))
    fail(422, "INVALID_FIELD", "Project fields require a project.");
  const changed = await db.query(
    "UPDATE knowledge_items SET title=coalesce($1,title),lifecycle=coalesce($2,lifecycle),revision=revision+1,updated_at=now(),projection_state='valid' WHERE id=$3 AND revision=$4 RETURNING id",
    [patch.title ?? null, patch.lifecycle ?? null, id, expected],
  );
  if (!changed.rowCount)
    fail(
      412,
      "STALE_REVISION",
      "This item changed. Refresh it before editing.",
    );
  const text = `Manual update to ${patch.title ?? old.title}:\n${JSON.stringify(patch)}`,
    source = sourceId
      ? await sourceFor(db, sourceId)
      : await manualSource(db, text);
  await linkEvidence(
    db,
    id,
    [
      {
        sourceId: source.id,
        start: 0,
        end: [...source.content].length,
        quote: source.content,
      },
    ],
    "corrects",
  );
  if (patch.aliases)
    await db.query(
      `UPDATE ${old.kind === "project" ? "projects" : "entities"} SET aliases=$1 WHERE item_id=$2`,
      [[...new Set(patch.aliases)], id],
    );
  if (patch.content !== undefined) {
    const table = {
      memory: "memories",
      task: "tasks",
      idea: "ideas",
      entity: "entities",
      project: "projects",
    }[old.kind as "memory"];
    const col = {
      memory: "assertion",
      task: "action",
      idea: "thought",
      entity: "canonical_name",
      project: "current_state",
    }[old.kind as "memory"];
    await db.query(`UPDATE ${table} SET ${col}=$1 WHERE item_id=$2`, [
      patch.content,
      id,
    ]);
  }
  if (old.kind === "project") {
    for (const [name, col] of Object.entries({
      outcome: "outcome",
      currentState: "current_state",
      lastDecision: "last_decision",
      blocker: "blocker",
      nextStep: "next_step",
    }))
      if (name in patch)
        await db.query(`UPDATE projects SET ${col}=$1 WHERE item_id=$2`, [
          (patch as any)[name],
          id,
        ]);
    await db.query(
      "UPDATE projects SET summary_edited_by_user=true WHERE item_id=$1",
      [id],
    );
  }
  if (old.kind === "task") {
    if (patch.status)
      await db.query(
        `UPDATE tasks SET status=$1,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE item_id=$2`,
        [patch.status, id],
      );
    // A repeating task moves on to its next occurrence instead of closing.
    if (patch.status === "completed") await rollRepeat(db, id);
    if (patch.dueDate !== undefined || patch.dueAt !== undefined) {
      if (patch.dueDate && patch.dueAt)
        fail(422, "DEADLINE_CONFLICT", "Choose a date or a specific time.");
      await db.query(
        "UPDATE tasks SET due_date=$1,due_at=$2,due_source_id=$3 WHERE item_id=$4",
        [patch.dueDate ?? null, patch.dueAt ?? null, source.id, id],
      );
    }
  }
  await event(
    db,
    id,
    randomUUID(),
    patch.lifecycle === "archived" ? "archived" : "updated",
    "user",
    old,
    source.id,
    "Manual update",
  );
  return getItem(db, id);
}
export async function correctMemory(
  db: Queryable,
  id: string,
  revision: number,
  assertion: string,
  reason: string,
) {
  const old = await getItem(db, id);
  if (old.kind !== "memory")
    fail(422, "INVALID_KIND", "Only memories can be superseded.");
  const lock = await db.query(
    `UPDATE knowledge_items SET lifecycle='superseded',revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2 RETURNING id`,
    [id, revision],
  );
  if (!lock.rowCount) fail(412, "STALE_REVISION", "This item changed.");
  const source = await manualSource(db, `${assertion}\nReason: ${reason}`),
    candidate: Candidate = {
      kind: "memory",
      category: old.category,
      title: old.title,
      content: assertion,
      epistemicState: "confirmed",
      confidence: 1,
      localId: randomUUID(),
      commitment: "none",
      due: null,
      evidence: [
        {
          sourceId: source.id,
          start: 0,
          end: [...assertion].length,
          quote: assertion,
        },
      ],
    };
  const next = await createCandidate(
    db,
    candidate,
    `correction:${source.id}`,
    "user",
  );
  await db.query("UPDATE memories SET supersedes_item_id=$1 WHERE item_id=$2", [
    id,
    next.id,
  ]);
  await db.query("UPDATE knowledge_items SET revision=revision+1 WHERE id=$1", [
    next.id,
  ]);
  await event(
    db,
    next.id,
    randomUUID(),
    "updated",
    "user",
    next,
    source.id,
    "Linked to superseded assertion",
  );
  await event(
    db,
    id,
    randomUUID(),
    "superseded",
    "user",
    old,
    source.id,
    reason,
  );
  await linkNamedProject(
    db,
    next.id,
    candidate.evidence,
    `correction:${source.id}:project`,
  );
  return getItem(db, next.id);
}
async function linkNamedProject(
  db: Queryable,
  itemId: string,
  evidence: Evidence[],
  key: string,
) {
  const item = await one(
    db,
    "SELECT * FROM knowledge_items WHERE id=$1 FOR UPDATE",
    [itemId],
  );
  if (
    !item ||
    item.kind === "project" ||
    item.lifecycle !== "active" ||
    item.projection_state !== "valid"
  )
    return;
  const quote = normalize(evidence.map((e) => e.quote).join(" "));
  const matchesName = (p: Row) =>
    [p.title, ...p.aliases].some((name: string) =>
      mentionsName(quote, normalize(name)),
    );
  const projects = (
    await db.query(
      "SELECT * FROM item_records WHERE kind='project' AND lifecycle='active' AND projection_state='valid'",
    )
  ).rows.filter(matchesName);
  if (projects.length !== 1) return;
  const projectId = projects[0]!.id;
  await db.query("SELECT id FROM knowledge_items WHERE id=$1 FOR UPDATE", [
    projectId,
  ]);
  const current = await one(
    db,
    "SELECT * FROM item_records WHERE id=$1 AND lifecycle='active' AND projection_state='valid'",
    [projectId],
  );
  if (current && matchesName(current))
    await relationship(db, itemId, projectId, "part_of", evidence, key);
}
function mentionsName(text: string, name: string) {
  if (!name) return false;
  let from = 0;
  for (
    let index;
    (index = text.indexOf(name, from)) >= 0;
    from = index + name.length
  ) {
    const before = [...text.slice(0, index)].at(-1) ?? "";
    const after = [...text.slice(index + name.length)][0] ?? "";
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after))
      return true;
  }
  return false;
}
