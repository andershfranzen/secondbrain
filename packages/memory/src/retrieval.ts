import { type Database, one } from "@secondbrain/database";
import { type AIProvider } from "@secondbrain/ai";
import {
  type RetrievedEvidence,
  hash,
  normalize,
  kinds,
  z,
  fail,
} from "@secondbrain/shared";
// Function words that carry no recall signal in English or Danish questions.
const stopwords = new Set(
  `a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or our should so than that the their them then there these they this to us was we were what when where which who why will with would you your
  af alle at blev da de dem den der det du efter eller en er et for fra har hvad hvem hvor hvordan hvorfor hvis i ikke jeg kan med men mig min mit måske når og om op på sig skal som til var vi vil være`.split(
    /\s+/,
  ),
);
/** OR of meaningful terms; to_tsquery is safe because tokens are letters and digits only. */
export function lexicalTerms(q: string) {
  const words = [
    ...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ].slice(0, 32);
  const terms = words.filter((w) => !stopwords.has(w));
  return (terms.length ? terms : words).join(" | ");
}
export async function search(
  db: Database,
  ai: AIProvider,
  q: string,
  options: {
    projectId?: string;
    kind?: (typeof kinds)[number];
    cursor?: string;
    historical?: boolean;
    semantic?: boolean;
    limit?: number;
    /** Sources never returned, e.g. the message being answered. */
    exclude?: string[];
  } = {},
) {
  const phrase =
    q
      .replace(
        /^(?:find|search(?: for)?|recall|show me|look up|remind me(?: about)?|tell me(?: about)?)\s+/i,
        "",
      )
      .trim() || q;
  const lexicalQuery = lexicalTerms(phrase);
  const fingerprint = hash(
    JSON.stringify({
      q,
      projectId: options.projectId ?? null,
      kind: options.kind ?? null,
      historical: options.historical ?? false,
    }),
  );
  let after: { score: number; key: string } | undefined;
  if (options.cursor) {
    try {
      const cursor = z
        .strictObject({
          fingerprint: z.string(),
          score: z.number(),
          key: z.string().max(300),
        })
        .parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString()));
      if (cursor.fingerprint !== fingerprint) throw new Error();
      after = { score: cursor.score, key: cursor.key };
    } catch {
      fail(400, "INVALID_CURSOR", "Search cursor does not match this query.");
    }
  }
  const settings = (await one(db, "SELECT * FROM app_settings"))!;
  let vector: number[] | undefined;
  if (
    options.semantic !== false &&
    settings.cloud_consent_at &&
    ai.configured &&
    ai.capabilities?.embeddings !== false &&
    !!settings.active_embedding_model
  )
    try {
      const embedded = await ai.embed(
        [q],
        AbortSignal.timeout(60000),
        settings.active_embedding_model,
      );
      if (
        embedded.model !== settings.active_embedding_model ||
        embedded.dimensions !== 1536 ||
        embedded.vectors.length !== 1 ||
        embedded.vectors[0]!.length !== 1536
      )
        throw new Error("Embedding namespace mismatch");
      vector = embedded.vectors[0];
    } catch {
      /* lexical fallback */
    }
  const historical = options.historical ?? false;
  const live = `FROM embeddings e JOIN sources s ON s.id=e.source_id JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id
 WHERE s.available AND s.kind<>'question' AND c.state<>'deleting'
 AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM item_sources isp JOIN knowledge_items k ON k.id=isp.item_id WHERE isp.source_id=s.id AND k.lifecycle='superseded' AND isp.start_offset<e.end_offset AND isp.end_offset>e.start_offset))
 AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM item_sources filter_source JOIN knowledge_items filter_item ON filter_item.id=filter_source.item_id WHERE filter_source.source_id=s.id AND filter_item.kind=$4 AND filter_item.projection_state='valid' AND ($2 OR filter_item.lifecycle='active')))
 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM item_sources ips LEFT JOIN relationships r ON (r.from_item_id=ips.item_id AND r.to_item_id=$3 OR r.to_item_id=ips.item_id AND r.from_item_id=$3) WHERE ips.source_id=s.id AND (ips.item_id=$3 OR r.id IS NOT NULL)))`;
  const select = `SELECT e.*,m.conversation_id,c.created_at AS captured_at`;
  const lexical = (
    await db.query(
      `${select} ${live} AND e.model='lexical-v1' AND e.search_document @@ to_tsquery('simple',$1) ORDER BY ts_rank_cd(e.search_document,to_tsquery('simple',$1)) DESC,e.source_id,e.start_offset LIMIT 30`,
      [
        lexicalQuery,
        historical,
        options.projectId ?? null,
        options.kind ?? null,
      ],
    )
  ).rows;
  let semantic: typeof lexical = [];
  if (vector)
    semantic = (
      await db.query(
        `${select} ${live} AND $1::text IS NOT NULL AND e.model=$5 AND e.embedding IS NOT NULL ORDER BY e.embedding <=> $6::vector,e.source_id,e.start_offset LIMIT 30`,
        [
          q,
          historical,
          options.projectId ?? null,
          options.kind ?? null,
          settings.active_embedding_model,
          JSON.stringify(vector),
        ],
      )
    ).rows;
  const itemFrom = `FROM embeddings e JOIN item_records k ON k.id=e.item_id AND k.revision=e.item_revision
    JOIN LATERAL(SELECT support.*,s.content AS original_content,m.conversation_id,c.created_at AS captured_at
      FROM item_sources support JOIN sources s ON s.id=support.source_id JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id
      WHERE support.item_id=k.id AND s.available AND s.kind<>'question' AND c.state<>'deleting'
      AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM item_sources old_support JOIN knowledge_items old ON old.id=old_support.item_id WHERE old_support.source_id=s.id AND old.lifecycle='superseded' AND old_support.start_offset<support.end_offset AND old_support.end_offset>support.start_offset))
      ORDER BY (support.role='corrects') DESC,s.created_at DESC,s.id LIMIT 1) support ON true
    WHERE k.projection_state='valid' AND ($2::boolean OR k.lifecycle='active') AND ($4::text IS NULL OR k.kind=$4)
    AND ($3::uuid IS NULL OR k.id=$3 OR k.project_id=$3 OR EXISTS(SELECT 1 FROM relationships r WHERE (r.from_item_id=k.id AND r.to_item_id=$3) OR(r.to_item_id=k.id AND r.from_item_id=$3)))`;
  const itemSelect = `SELECT e.id,e.item_id,e.item_revision,k.title AS item_title,k.content AS item_content,k.epistemic_state,k.lifecycle,support.source_id,support.quote AS content,support.start_offset,support.end_offset,support.conversation_id,support.captured_at`;
  const itemLexical = (
    await db.query(
      `${itemSelect} ${itemFrom} AND e.model='lexical-v1' AND e.search_document @@ to_tsquery('simple',$1) ORDER BY ts_rank_cd(e.search_document,to_tsquery('simple',$1)) DESC,k.id LIMIT 30`,
      [
        lexicalQuery,
        historical,
        options.projectId ?? null,
        options.kind ?? null,
      ],
    )
  ).rows;
  const itemSemantic = vector
    ? (
        await db.query(
          `${itemSelect} ${itemFrom} AND $1::text IS NOT NULL AND e.model=$5 AND e.embedding IS NOT NULL ORDER BY e.embedding <=> $6::vector,k.id LIMIT 30`,
          [
            q,
            historical,
            options.projectId ?? null,
            options.kind ?? null,
            settings.active_embedding_model,
            JSON.stringify(vector),
          ],
        )
      ).rows
    : [];
  const scores = new Map<string, { row: any; score: number }>();
  for (const rows of [lexical, semantic, itemLexical, itemSemantic]) {
    let rank = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.source_id}:${row.start_offset}:${row.end_offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const old = scores.get(key);
      scores.set(key, {
        row: row.item_id ? row : (old?.row ?? row),
        score: (old?.score ?? 0) + 1 / (60 + ++rank),
      });
    }
  }
  // Exact titles provide a useful channel for short names, even before embeddings.
  const exact = (
    await db.query(
      `${itemSelect} ${itemFrom} AND $1::text IS NOT NULL AND e.model='lexical-v1' AND (lower(regexp_replace(trim(k.title),'\\s+',' ','g'))=$5 OR EXISTS(SELECT 1 FROM unnest(k.aliases) alias WHERE lower(regexp_replace(trim(alias),'\\s+',' ','g'))=$5)) ORDER BY k.id LIMIT 30`,
      [
        lexicalQuery,
        historical,
        options.projectId ?? null,
        options.kind ?? null,
        normalize(phrase),
      ],
    )
  ).rows;
  for (const row of exact) {
    const key = `${row.source_id}:${row.start_offset}:${row.end_offset}`;
    scores.set(key, { row, score: (scores.get(key)?.score ?? 0) + 1 / 61 });
  }
  const seedSources = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((x) => x.row.source_id);
  const related = (
    await db.query(
      `SELECT DISTINCT s.id AS source_id,s.content,0 AS start_offset,length(s.content) AS end_offset,m.conversation_id,c.created_at AS captured_at FROM item_sources a JOIN relationships r ON r.from_item_id=a.item_id OR r.to_item_id=a.item_id JOIN item_records k ON k.id=CASE WHEN r.from_item_id=a.item_id THEN r.to_item_id ELSE r.from_item_id END JOIN item_sources b ON b.item_id=k.id JOIN sources s ON s.id=b.source_id JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id WHERE a.source_id=ANY($1::uuid[]) AND ($2::boolean OR k.lifecycle='active') AND ($3::uuid IS NULL OR k.id=$3 OR k.project_id=$3 OR r.from_item_id=$3 OR r.to_item_id=$3) AND ($4::text IS NULL OR k.kind=$4) AND k.projection_state='valid' AND s.available AND s.kind<>'question' AND c.state<>'deleting' AND EXISTS(SELECT 1 FROM relationship_sources rs JOIN sources support ON support.id=rs.source_id WHERE rs.relationship_id=r.id AND support.available) AND ($2::boolean OR NOT EXISTS(SELECT 1 FROM item_sources old JOIN knowledge_items o ON o.id=old.item_id WHERE old.source_id=s.id AND o.lifecycle='superseded')) ORDER BY s.id LIMIT 10`,
      [
        seedSources,
        historical,
        options.projectId ?? null,
        options.kind ?? null,
      ],
    )
  ).rows;
  for (const row of related) {
    const key = `${row.source_id}:${row.start_offset}:${row.end_offset}`;
    scores.set(key, { row, score: (scores.get(key)?.score ?? 0) + 1 / 90 });
  }
  // Hydrate candidates again so a deletion or edit during ranking cannot leak a stale projection.
  const sourceIds = [
    ...new Set([...scores.values()].map((x) => x.row.source_id)),
  ];
  const liveSources = new Map(
    (
      await db.query(
        `SELECT s.*,m.conversation_id,m.created_at AS captured_at,coalesce((SELECT jsonb_agg(jsonb_build_object('start',i.start_offset,'end',i.end_offset)) FROM item_sources i JOIN knowledge_items k ON k.id=i.item_id WHERE i.source_id=s.id AND k.lifecycle='superseded'),'[]'::jsonb) AS superseded_ranges FROM sources s JOIN messages m ON m.id=s.message_id JOIN conversations c ON c.id=m.conversation_id WHERE s.id=ANY($1::uuid[]) AND s.available AND s.kind<>'question' AND c.state<>'deleting'`,
        [sourceIds],
      )
    ).rows.map((s) => [s.id, s]),
  );
  const itemIds = [
    ...new Set(
      [...scores.values()].flatMap((x) =>
        x.row.item_id ? [x.row.item_id] : [],
      ),
    ),
  ];
  const liveItems = new Map(
    (
      await db.query(
        `SELECT * FROM item_records WHERE id=ANY($1::uuid[]) AND projection_state='valid' AND ($2::boolean OR lifecycle='active')`,
        [itemIds, historical],
      )
    ).rows.map((i) => [i.id, i]),
  );
  const ranked = [...scores.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort(
      (a, b) =>
        b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const selected: typeof ranked = [];
  const seenItems = new Set<string>();
  for (const candidate of ranked) {
    const r = candidate.row,
      source = liveSources.get(r.source_id),
      item = r.item_id ? liveItems.get(r.item_id) : undefined;
    if (
      !source ||
      (!historical &&
        source.superseded_ranges.some(
          (range: { start: number; end: number }) =>
            Math.max(range.start, r.start_offset) <
            Math.min(range.end, r.end_offset),
        )) ||
      (r.item_id && (!item || item.revision !== r.item_revision)) ||
      (r.item_id && seenItems.has(r.item_id))
    )
      continue;
    if (
      selected.some(
        (x) =>
          x.row.source_id === r.source_id &&
          Math.max(x.row.start_offset, r.start_offset) <
            Math.min(x.row.end_offset, r.end_offset),
      )
    )
      continue;
    if (r.item_id) seenItems.add(r.item_id);
    selected.push(candidate);
  }
  const remaining = selected.filter(
    (x) =>
      !after ||
      x.score < after.score ||
      (x.score === after.score && x.key > after.key),
  );
  let budget = 24000;
  const items: RetrievedEvidence[] = [];
  let last: (typeof ranked)[number] | undefined;
  for (const candidate of remaining) {
    if (items.length >= Math.min(options.limit ?? 12, 100) || budget <= 0)
      break;
    const { row, score } = candidate,
      source = liveSources.get(row.source_id)!;
    if (options.exclude?.includes(source.id)) continue;
    const item = row.item_id ? liveItems.get(row.item_id) : undefined;
    const content = [...source.content]
      .slice(
        row.start_offset,
        Math.min(row.end_offset, row.start_offset + budget),
      )
      .join("");
    if (!content) continue;
    budget -= [...content].length;
    items.push({
      sourceId: source.id,
      content,
      start: row.start_offset,
      end: row.start_offset + [...content].length,
      conversationId: source.conversation_id,
      createdAt: source.captured_at.toISOString(),
      score,
      historical,
      superseded: source.superseded_ranges.some(
        (range: { start: number; end: number }) =>
          Math.max(range.start, row.start_offset) <
          Math.min(range.end, row.end_offset),
      ),
      ...(item
        ? {
            itemId: item.id,
            itemRevision: item.revision,
            itemTitle: item.title,
            itemContent: item.content,
            epistemicState: item.epistemic_state ?? undefined,
            lifecycle: item.lifecycle,
          }
        : {}),
    });
    last = candidate;
  }
  const more =
    last &&
    remaining.some(
      (x) =>
        x.score < last!.score || (x.score === last!.score && x.key > last!.key),
    );
  return {
    items,
    nextCursor: more
      ? Buffer.from(
          JSON.stringify({ fingerprint, score: last!.score, key: last!.key }),
        ).toString("base64url")
      : null,
    modes: [
      ...(vector ? ["lexical", "semantic"] : ["lexical"]),
      ...(related.length ? ["relationships"] : []),
    ],
  };
}
