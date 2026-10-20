# Second Brain

A private, self-hosted place to put thoughts down and find them later.

The home screen is one input. Write a brain dump, record audio, or ask about
something you saved. Every message is preserved first, then handled by one
agent turn that decides what it was and acts on it: it records commitments (who
asked, when, the deadline in your words), closes them when you say they're done,
and answers questions from everything you saved, citing your own words. It never
asks you anything; when unsure it records the item and labels it unconfirmed.
Earlier conversations, records, corrections and settings sit in the menu.

How the agent works, and what it guarantees: [docs/agent.md](docs/agent.md).

Implemented with Next.js, Fastify, PostgreSQL/pgvector, Redis/BullMQ, and local
file storage. Cloud processing is optional and requires explicit consent in
settings. No GPU is required. Natural speech-to-speech conversations are a later
phase; the current voice path records, transcribes, and organizes brain dumps.

## Run locally

Use Node 24 LTS, pnpm 10.28.2, Docker, and ffmpeg/ffprobe.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Set POSTGRES_PASSWORD and DATABASE_URL to matching private credentials.
docker compose --env-file .env -f infrastructure/compose.yaml up -d
pnpm setup
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. `pnpm setup` reads a password privately and writes
its hash under `DATA_DIR/secrets`. It generates `SESSION_SECRET` in `.env`.
Do not pass passwords as command arguments or commit `.env`.

Use your **ChatGPT subscription** with `pnpm connect:chatgpt`, set
`AI_PROVIDER=chatgpt` and `REASONING_MODEL`, then enable cloud processing in
Settings. See [subscription setup](docs/chatgpt-subscription.md) for model
selection, Docker/SSH connection, allowance limits, and unsupported audio/embeddings.

With `AI_PROVIDER=none` (or before consent) every message is still saved and
keyword-searchable, but nothing is organized or answered. To use Platform API
billing, configure `AI_PROVIDER=openai`, `AI_API_KEY`, `REASONING_MODEL`,
`EMBEDDING_MODEL` and `TRANSCRIPTION_MODEL`. The agent's model needs tool calling
and structured outputs on the Responses API. Embeddings must return 1,536
dimensions. Relevant text/audio leaves your server when cloud processing is enabled.

Before relying on it, run the scenario evaluation against your own model:
`pnpm eval:agent --live --send-synthetic-to-provider --database <eval db>`
(see [evaluation](evaluation/README.md)).

## Deployment and checks

- [Server deployment, backups, and restore](docs/operations.md)
- [The memory agent: flow, tools and guarantees](docs/agent.md)
- [Current interface](docs/interface.md)
- [Implementation specification](docs/implementation-spec.md)
- [Acceptance scenarios](docs/acceptance-tests.md) and [evidence/open work](docs/acceptance-status.md)
- [Verification and remaining external checks](docs/validation.md)
- [Scenario evaluation against your model](evaluation/README.md)

`pnpm check` runs TypeScript, unit/integration tests, and a production build.
Tests require dedicated local PostgreSQL and Redis instances; see validation.
`pnpm test:e2e` checks the single-input workflow on desktop and phone layouts.

The deterministic fake AI provider is for tests and development only: a scripted
stand-in that drives the agent's real tools. It is not a language model. Live provider quality and physical-device
acceptance must be checked with your own configuration before relying on the app.

GitHub Actions runs the typecheck, database/integration, production build, and
browser suite with dedicated PostgreSQL/pgvector and Redis services. Local
integration checks also require Redis on port 56379; `TEST_REDIS_URL` can select a
dedicated alternative. Fault tests isolate their own queue and do not flush Redis.
