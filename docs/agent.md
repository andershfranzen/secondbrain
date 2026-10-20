# The memory agent

Everything typed or recorded into the single input is handled by one agent turn.
The agent decides what the message was (a note, a question, both, or an
instruction such as "that's done") and acts on it with tools. It never asks the
user anything: when something is ambiguous it records its best judgment and
labels it **unconfirmed**. This replaced the regex router, the fixed extraction
and matching rules, and the review queue (October 2026).

The model does the interpreting. The code enforces only the invariants that
must never break.

## Flow

1. `POST /api/v1/messages` stores the message and its source and indexes it for
   keyword search **before any AI runs**, then queues one `converse` job.
   The source's kind is `pending` until the turn decides. Message IDs are
   idempotent; reusing one with different text returns 409.
2. The worker runs turns **one at a time, oldest first**, so a question asked
   right after a brain dump sees what that dump recorded. A new job wakes the
   worker at once (`LISTEN`/`NOTIFY`); the 5-second poll is the fallback.
3. The agent receives the message with its local capture time, the last turns of
   the conversation, the ledger's size, the calendar (today and the coming
   weeks) and the **open list**: every open task and active project, most
   urgent first, with dates and its latest quotes (up to 60). Everything else
   it reads through tools.
4. Write tools validate immediately and return errors the model can correct.
   Nothing is written while the agent works: when its final answer passes the
   checks below, the whole turn commits atomically inside the job's lease.
5. `GET /api/v1/messages/:id` reports `queued`, `working`, `retrying`,
   `blocked` (no consent or provider), `failed` (with `POST …/retry`) or
   `done` with the reply and what changed. While `working` it carries
   `progress`: what the agent is doing ("Checking the calendar") and, for a
   question, the reply as the model streams it. The client polls quickly while a
   turn works and shows the draft; the committed turn replaces it, so nothing
   unchecked is ever kept.

Text captures (`/captures/text`) and recordings (after transcription) use the
same turn, marked as notes.

## Tools

| Tool           | Purpose                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_notes` | Meaning and keyword search over notes and items, with dates and the related item.                                                                           |
| `list_items`   | Exhaustive, filtered listing (kind, open or done, person, project, text). Returns at most 400; with `forAnswer` it must not be truncated.                   |
| `calendar`     | Open tasks between two days, by day: overdue, starting, due and spanning, plus undated open tasks. With `forAnswer` every dated item must be accounted for. |
| `get_item`     | One item with every supporting quote, related items and recent history.                                                                                     |
| `read_source`  | The full original text of a note, to copy exact quotes.                                                                                                     |
| `create_item`  | New task, project, memory, idea or person/thing, with certainty and evidence.                                                                               |
| `update_item`  | Change, complete, cancel, reopen, re-date or archive an item, with evidence. Changing a memory's content supersedes it; the old version stays in history.   |
| `link_items`   | part_of, depends_on, precedes, mentions or related_to, with evidence.                                                                                       |

## Answering in one step

Questions about open commitments ("what's outstanding", "what did I promise
Birgit", "what's due by Friday") are answered straight from the open list, with
no tool call. The answer declares the filter it applied (`openListScope`:
kinds, person, due by); code reruns that filter against the database and sends
the answer back until every match is cited or left out with a reason. That is
the same completeness guarantee as a `forAnswer` listing, one model round trip
sooner. Listings and the calendar also return each item's latest quotes, so
citing them needs no extra call.

## Undo

Every turn that changed the ledger records what it changed: the items it
created, and for each updated item its rows as they were before and as the turn
left them. `POST /api/v1/turns/:id/undo` (the Undo link beside "Saved") removes
the created items, restores the updated ones, and drops the relationships the
turn added. The note itself stays, and the stored reply is marked undone so
later turns know. Undo is refused while any of those items differs from how the
turn left it, which holds again once the later change is itself undone; it can
never discard newer work. Deleting a source clears undo data that holds its
text.

## Items are rewritten, notes are kept

Brain dumps are messy. The agent writes every item's title and content in its
own clean words: a short label, plus one to three self-contained sentences with
filler dropped, pronouns resolved and every concrete detail (names, numbers,
dates, conditions) kept. One dump can become several items; restatements merge
into one, and a later change rewrites the description rather than appending to
it. It keeps the user's language and never adds or changes meaning; a hedge
becomes `unconfirmed`. Titles over 120 characters are refused.

The original note is stored untouched before any AI runs. Each item links back
to it through short exact quotes, which are provenance, not the item's text.

Tasks carry **who asked** (`requestedBy`), **when it was agreed**, their place
on the calendar, the user's own loose timing (`dueHint`, such as "next month")
and when it was last mentioned.

## The calendar

Every task with timing sits between a **start** (when it is planned or may
begin) and a **deadline** (the last day it can be done). Either end is a date or,
with a time, an instant in the user's timezone; an appointment is a timed start.
The agent resolves relative timing against the capture time and turns loose
timing into a window while keeping the words: "next week" is Monday to Sunday,
"uge 44" that ISO week, "next month" its first to last day, "not this week" a
start next Monday. Timing with no date behind it ("after the release") stays a
hint only; the agent never invents a date or adds lead time. One cited source
justifies the schedule; erasing it clears the dates.

Questions about time use the `calendar` tool, so "what's due this week" is
answered from the full range, overdue work first.

**Repeating commitments** ("the cost report every month-end", "hver mandag")
are one task with a rule (every day, week, month or year, with an interval)
dated at its next occurrence. Completing it, by the agent, by hand or from the
morning brief, moves the dates on to the following occurrence and keeps the task
open; the series counts from its first date, so a month-end stays at the month's
end. Moving the dates moves one occurrence; cancelling ends the series. The
calendar tool also lists later occurrences in the range.

## Invariants enforced in code

- **Originals first.** A message is durable and keyword-searchable before the
  provider is called. With AI unavailable, messages still save and keyword
  matches are shown; they are organized once processing is available.
- **Evidence is the user's own words.** Items and answers are worded by the
  agent, but every write and every answer claim cites a source and a quote. The code locates the quote in the source (tolerating
  whitespace and typographic quotes), stores exact offsets, and rechecks them at
  commit. Models copy quotes; they don't count offsets.
- **Questions and replies are never evidence.** A message the agent classifies
  as a pure question becomes a `question` source: preserved, but excluded from
  retrieval and from citations. Writes citing it are dropped. A quote containing
  a question mark can never back a confirmed item. Agent replies are stored as
  conversation context only.
- **Complete lists.** Every item returned by a `forAnswer` listing must be
  accounted for in the final answer: included in a claim, or excluded with a
  reason. Otherwise the answer goes back to the agent with the missing IDs, up to
  three times, and the turn fails rather than showing an incomplete list.
- **No duplicates by title.** Creating an active item with the same kind and
  title as an existing one is refused, so the agent updates the existing item.
- **Atomic, idempotent turns.** Writes apply in one transaction under the job's
  lease with deterministic operation IDs; a retry reruns the whole turn and
  cannot partially apply. An item changed since the agent read it aborts the
  commit and the turn reruns.
- **Deletion.** Erasing a conversation invalidates every turn that read or cited
  its sources (lineage covers everything the agent saw, not only citations),
  blanks those replies, and restarts any turn still in flight elsewhere.
- **Consent.** Turns run only with cloud consent and a configured provider;
  revoking consent pauses them.

## Provider

The agent runs on `REASONING_MODEL` through the Responses API with strict
function tools and a strict structured final answer, streamed, `store:false`.
The ChatGPT subscription route has no server-side state, so each step resends
the full history (message, function calls, tool results). The same loop serves
`AI_PROVIDER=openai`. Steps are bounded (40) and every call's token usage is
recorded without content.

## Reliability

`pnpm eval:agent` replays synthetic month-long timelines through this pipeline
in a throwaway database and scores the ledger and the answers: commitments
recorded with who asked, completions and cancellations applied, unconfirmed
items labeled, "what do I have outstanding?" complete, and nothing closed or
asked listed as fact. Run it against your own model before relying on the app;
see [evaluation](../evaluation/README.md). Unit, integration and browser tests
use a scripted fake agent that drives the real tools; they verify the plumbing
and guarantees, not model judgment.

## Limits

- Interpretation quality depends on the model; the evaluation measures it but
  cannot prove it for every phrasing.
- With the subscription there are no embeddings, so retrieval is keyword-based
  (OR of meaningful terms, ranked), plus exhaustive structured listing.
- Long histories are summarized by tools, not loaded wholesale; a listing of more
  than 400 matching items must be narrowed before it can back an answer.
