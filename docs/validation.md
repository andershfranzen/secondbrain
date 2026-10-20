# Verification

## Agent refactor — 20 October 2026

One tool-using agent turn now handles every message (see [agent.md](agent.md)).
Checked with synthetic data, PostgreSQL 17/pgvector and Redis, the scripted fake
agent, and local stubs of the Platform and ChatGPT subscription Responses
endpoints. **No real model or ChatGPT account was used**, so model judgment is
unverified; run `pnpm eval:agent --live` before relying on it.

- TypeScript (backend and web), Prettier, 73 unit/integration tests, the
  production build and 12 browser tests (desktop and phone) passed.
- Agent coverage: originals saved and keyword-searchable before any AI;
  idempotent message IDs; a deferred commitment recorded with who asked and the
  loose deadline, then listed completely a month later; a later "finished" note
  closing it; follow-ups in one conversation; turns run oldest first; erased notes
  invalidating replies built on them; failed turns kept and retryable; local
  capture time given to the agent.
- Tool boundary: invented quotes, question sources, unknown items and impossible
  dates are refused; a quoted question is never confirmed; a list answer missing
  an item is rejected and corrected through the real loop before anything is shown.
- Transport: stateless streamed tool loop with strict tools and structured output,
  full history resent each step, rejected answers returned with the reason,
  partial streams refused, 401/429 classification, consent enforced before any
  request, allowlisted usage only; the same loop over the subscription route with
  OAuth bearer tokens and no `previous_response_id`.
- Scenario evaluation: the harness replays a dated month of work notes and scores
  ledger and answers. With the fake agent it correctly reports misses (Danish
  promise, "Told him sure", the cancelled venue, over-broad lists), showing it
  discriminates; live model results are not yet measured.

The sections below describe the earlier extraction/review pipeline; items about
extraction, reconciliation, review proposals and recall requests are historical.

## Earlier verification

Checked on 19 October 2026. Tests use synthetic data, the deterministic fake
provider, and local HTTP stubs for Platform and ChatGPT subscription adapters, with PostgreSQL 17/pgvector
and Redis. No real provider key or ChatGPT account was used.

- TypeScript checks, 116 unit/integration tests, and production Next.js
  build passed. Coverage includes authentication/CSRF, capture idempotency,
  Unicode evidence offsets, deadline grounding, consent, lease fencing/retries,
  conservative memory extraction, duplicate provenance, reviews, corrections,
  hybrid recall, invalidation, deletion, exports, and audio durability.
- New coverage includes serialized contextual follow-ups, stable conversation
  ordering, current item/alias retrieval, query-bound search cursors, semantic
  duplicate review suggestions, source changes during answer generation, SSE
  replay/session revocation, exhausted-lease recovery, and sanitized usage totals.
- The OpenAI adapter HTTP stub verifies strict JSON schemas, one schema correction,
  401/429 classification, Retry-After, no hidden SDK retries, and consent revocation
  without a request. Usage records contain only allowlisted metadata, never
  requests, captured content, error messages, headers, or API keys. These checks
  do not establish live model quality or account compatibility.
- Subscription checks cover loopback registration with PKCE/state, signed identity
  and nonce verification, protected token files, retained registration, serialized
  rotating refreshes, 401 renewal, plan scope, revoked/malformed grants, network
  failures, completed SSE responses, quota failures before/after streaming, and
  refusal to use Platform API credentials. Unsupported transcription/embedding
  jobs block without consuming attempts, while lexical retrieval remains available.
  Docker subscription override passed startup, auth-volume permissions, and the
  web/API authentication boundary. Live sign-in and plan eligibility remain unverified.
- Queue recovery now uses real Redis/BullMQ through a test-owned TCP fault proxy.
  Capture succeeds while Redis is unavailable; deleting the isolated queue's
  delivery state still allows every stage to complete once from the PostgreSQL
  ledger. The shared Redis instance is never flushed.
- Media durability checks inject disk-full writes, failed renames, and real SQL
  rollback. Orphan sweeping removes abandoned files while preserving referenced
  recordings and active upload leases. Real WebM/MP4 input, duration limits, and
  path-shaped multipart filename rejection are covered.
- The transcription adapter now uses the encoder's actual segment timeline.
  A real twenty-minute-plus-tail audio fixture checks each uploaded MP3 chunk,
  assembled stub transcript, size limit, consecutive absolute timestamps, and
  the short tail's actual duration. This tests media handling, not live speech
  recognition quality. Negated English/Danish commitments go to review; Danish
  uncertainty remains uncertain despite high extraction confidence.
- Successful zero-candidate extraction leaves the original searchable and available
  as recall evidence. An authenticated manual embedding retry does not repeat
  extraction/reconciliation or duplicate its task/source.
- Reconciliation regressions exercise the mixed-project corpus against real
  PostgreSQL with scripted extraction, separate-date project updates, identical
  project names, concurrent first mentions, concurrent identical assertions and result replay. Exact matches
  cannot bypass commitment/deadline checks or reintroduce superseded memories.
  A paused lookup resumes safely after a manual correction. Concurrent accepts
  apply once; dismissals clear needs_review. Accepted deadlines and structured
  project changes retain fresh user evidence, revision history and indexing.
- Reviewed endpoints persist their actual resolved item IDs. Deferred relationships
  are restored when both accepted/automatic endpoints remain live, with original
  exact-quote provenance. Rejections, archived endpoints, source deletion and
  meaning-changing edits do not recreate old links. Reviewed corrections use the
  replacement memory ID; edited accepted tasks link to an explicitly named project.
  Repeated acceptance and reconciliation leave relationships/revisions unchanged.
- Extraction rejects duplicate local IDs, unknown/self endpoints and invalid
  evidence before saving model results or applying projections. Overlapping chunks
  retain distinct thoughts and rewire duplicated endpoint IDs. More than 100 total
  candidates can survive a multi-chunk dump, and saturated windows are re-extracted
  in smaller overlapping pieces instead of accepting truncation.
- Readiness compares the packaged migration names and checksums against the
  database, including migration 0005 for reviewed relationship resolution. A
  matching row count with an unrelated migration or wrong checksum stays unready.
  A legacy migration regression backfills only separately identified reviewed
  items, leaves unknown target selections unassigned, and clears deleted item
  references without inventing a replacement.
- Differently named projects sharing a generic summary remain distinct. A forced
  semantic match with a conflicting name goes to review rather than gaining
  provenance as an exact duplicate. Overlap duplicates retain the lowest reported
  confidence for candidates and relationships.
- SQL calendar dates remain date strings rather than timezone-dependent midnight
  timestamps. The API regression checks an exact `2026-10-25` deadline; this fixes
  the observed Copenhagen response shifting it to the previous UTC day.
- The 30-capture synthetic evaluation harness passed its scripted run. Fixtures
  include Danish, emoji, mixed languages, negation, uncertainty, project ambiguity,
  changed preferences and hostile quoted content. Per-kind scores measure structure
  and evidence only; semantic and reconciliation reviews remain pending. See
  [evaluation instructions](../evaluation/README.md). No live accuracy score is claimed.
- `.github/workflows/verify.yaml` runs the same typecheck, migration/integration,
  production build, and desktop/phone browser checks with pinned action revisions
  and PostgreSQL/Redis images. The local CI-mode browser run passed. A hosted
  GitHub Actions run has not been observed; the workflow has not been pushed.
- Audio checks use a real PCM WAV file and ffprobe. Multipart upload,
  authenticated playback ranges, MIME mismatch, corrupted content, truncated
  streams, upload size limits, transcription, and audio retention passed.
- `pnpm test:e2e`: ten tests passed across desktop Chromium and Pixel 7 browser
  layouts. They exercise the one-box home, capture/recall/source links, memory
  corrections, draft preservation, projects, conversation history, manifest, and
  private-cache behavior, and durable follow-up conversation continuity.
- Taste Skill v2 app-screen lint: zero failures. Clock padding, the floating-menu
  shadow, and detail-field labels explain remaining warnings. Final OLED home and
  Settings visual inspection passed at 1440, 768, and 390 pixels; all twelve output
  screenshots were opened. Settings has no warnings. Home retains the deliberate
  whitespace around the input-only screen. See [design-review.md](design-review.md)
  for the critique, scores, and before/after comparison. Reduced-motion CSS disables
  all interaction animation; physical OLED devices have not been checked.
- The final Docker image built successfully. `scripts/verify-compose.ts` passed
  the production topology smoke check: isolated database/Redis, migrations, API
  readiness, worker, web/API proxy, and unauthenticated-access boundary. Its
  temporary containers, volumes, and credentials were removed.
- Initial migration and SQL constraint smoke checks passed on PostgreSQL 17.
  All five migrations are applied through the versioned migration runner in
  integration tests and operational verification. An isolated-schema regression
  verifies rollback on a failed SQL statement, restart without replaying committed
  work, checksum mismatch rejection, and legacy recall message reordering without
  ordinal collisions or changes to capture messages.
- `scripts/verify-restore.ts` passed inside the application runtime image using
  PostgreSQL 17 client tools and restic. It checks encrypted backup/restore,
  original attachment SHA-256 integrity, deletion after backup replayed from the
  independent erasure manifest, session revocation, and refusal to restore over
  an existing database. Its temporary databases and repository are removed.

## Reproduce automated checks

Use only dedicated test instances. The default integration DSN points to
`secondbrain_test` on loopback port 55432 with test-only credentials. The E2E
runner resets `secondbrain_e2e` and uses Redis on port 56379. These are destructive
fixtures; never point them at your personal database.

```sh
docker run -d --name secondbrain-test-postgres -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=integration-only pgvector/pgvector:pg17
docker run -d --name secondbrain-test-redis -p 127.0.0.1:56379:6379 redis:7-alpine
pnpm check
pnpm test:e2e
```

The operational restore drill is documented in [operations.md](operations.md).

## Remaining acceptance work

Cloud model quality, structured extraction with your chosen models, live
transcription, embedding-provider changes, and provider-specific error handling
need verification with a real account. Physical Android/iOS microphone behavior,
installation, Tailscale HTTPS access, and sustained load/large archives have not
been verified. The full set of 38 acceptance scenarios is not yet an automated
release suite. [acceptance-status.md](acceptance-status.md) maps each scenario and
release gate to current evidence and the work still open. These checks do not claim every scenario or later roadmap phase
has been completed.

Current limits include conservative regex-based input routing and no streaming
voice, proactive reminders, or calendar integration. Follow-up recall uses a
model-based conversation planner when configured; chat remains context rather
than factual evidence. Semantic matches suggest review targets and never authorize
automatic identity merges. Search pagination covers the ranked candidate pool,
not an exhaustive archive enumeration or a concurrent-write snapshot. Settings
shows processing health, vector coverage, disk space, backups and reported token
counts; billing estimates and per-provider pricing are not implemented. Usage
from a process that crashes before its fenced job commit cannot be recovered from
the local ledger, and providers may omit token counts.
