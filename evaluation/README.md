# Agent evaluation

The scenarios are in
[`tests/fixtures/agent-scenarios.ts`](../tests/fixtures/agent-scenarios.ts).
Each one is a dated timeline of synthetic messages replayed through the real
pipeline (originals saved first, one agent turn per message, at the message's
simulated time), followed by questions asked "later". The main scenario is a
September of work notes in English and Danish:

- deferred commitments from different people ("said yes but not until after
  the release", "Told him sure", "Jeg har lovet Peter…");
- a hedged maybe-commitment that must be kept, labeled unconfirmed;
- a completion and a cancellation that must close earlier commitments;
- distractors (lunch, a laptop battery) and an idea that is not a commitment.
- a rambling, filler-heavy dump ("ok so uh Lars came by…") that must become a
  clean commitment.

A second scenario, `dansk-kalender`, is an October of Danish notes with the
timing people actually write: "inden næste kørsel d. 30. oktober", "i uge 42",
"torsdag kl. 10", "inden fredag", "næste måned", "fredag i næste uge", a
deadline that moves, a completion, filler ("øh", "selvf") and a task with no
date behind it ("når releasen er ude"). Its checks include the dates each task
lands on, and its questions ask what is due this week, what is overdue, what
was promised to whom and what is due in November.

A third scenario checks that a question never becomes a fact.

## What is scored

- **Ledger:** each expected commitment exists as a task, with the right status
  (open, or completed/cancelled), who asked, and certainty where specified.
  Failures here are reported as `missedCommitments`, the metric that matters most.
  A check can also list filler that must not survive into the item's title or
  content (quotes are exempt, since they are the user's original words).
  Date checks accept a set of acceptable start and deadline days (and a time
  for appointments); `undated` requires no dates and the wording in the hint.
- **Answers:** every expected item appears in the answer, and nothing closed or
  irrelevant is listed among the answer's citations or cited items.

Expectations accept alternative phrasings, so a correct answer worded
differently still passes. Read the replies in the report as well; phrase checks
cannot judge tone or wrong detail.

## Running it

It needs a dedicated PostgreSQL database whose name contains `eval`. The runner
creates it if missing, migrates it and **erases it** for each scenario. It never
reads your real database.

Check the harness itself with the scripted fake agent (no model calls; it is
expected to fail many checks because it is not a language model):

```sh
pnpm eval:agent --fake --database postgres://…/secondbrain_eval --output evaluation/results/harness.json
```

With your provider configured in `.env` (for the subscription:
`AI_PROVIDER=chatgpt`, `REASONING_MODEL`, a connected credential file):

```sh
pnpm eval:agent --live --send-synthetic-to-provider \
  --database postgres://…/secondbrain_eval --output evaluation/results/live-1.json
```

The flag permits sending only the synthetic scenarios to the model. A full run
takes a few dozen agent turns against your allowance. The command exits non-zero
on any missed commitment, missing answer item, wrongly listed item or failed turn.

Reports are written with owner-only permissions and never overwrite an existing
file; use a new name for each run. They contain the synthetic text, replies and
scores, never credentials. The results folder is ignored by Git.

## Before relying on it

Run the live evaluation at least three times. Investigate every missed
commitment: open the report's ledger entry, then rerun after adjusting the model
choice. Add your own phrasing patterns as new steps in the scenario file when
you find something the agent handles badly; the harness scores them the same way.
