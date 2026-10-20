# Running the server

Use Ubuntu, Docker Compose v2, Tailscale, and a private model-provider account
if you want cloud processing. Start with Node 24 LTS and pnpm 10.28.2 for setup.

For ChatGPT subscription access, use the [subscription setup](chatgpt-subscription.md)
and its Compose override in addition to these steps. No Platform API key is needed.

## First installation

1. Copy `.env.example` to `.env`. Set a randomly generated hexadecimal
   `POSTGRES_PASSWORD` and the matching development `DATABASE_URL`. Hexadecimal
   avoids URL-escaping problems in the Compose database URL.
2. Run `pnpm install --frozen-lockfile` and `pnpm setup` in an interactive
   terminal. Setup reads a password without echoing it and generates
   `SESSION_SECRET`. Preserve `.env` privately. Never commit or share it.
3. Set `APP_ORIGIN` to your exact Tailscale HTTPS origin, with no trailing slash.
   Set provider/model settings if needed; `AI_PROVIDER=none` works for text and
   lexical search. Production refuses the fake provider and insecure origins.
4. Create private bind directories: `mkdir -p erasures backups` and
   `chmod 700 erasures backups`. The application runs as UID/GID 1000; ensure
   these directories are owned by that user. The erasure directory must survive
   replacing or restoring the application data volume.
5. Build and provision the container password:

   ```sh
   docker compose --env-file .env -f infrastructure/compose.production.yaml build
   docker compose --env-file .env -f infrastructure/compose.production.yaml run --rm --no-deps api pnpm setup --password-only
   docker compose --env-file .env -f infrastructure/compose.production.yaml up -d
   ```

   The container setup prompts privately. The password hash is stored in the
   persistent application volume. It intentionally refuses to overwrite an
   existing hash. The local setup hash and container hash live in separate data
   directories; use the password you set in the container when signing in.

6. Run `sudo tailscale serve --bg http://127.0.0.1:3000` on the server. Restrict
   access through tailnet policy. Only web port 3000 is published, on loopback;
   PostgreSQL, Redis, API, and worker remain inside the Compose network.
7. Open the HTTPS address and sign in. Enable cloud processing in Settings only
   after reviewing the data flow. Test microphone capture on the actual phone.

Production runs a migration service before starting the API. Readiness requires
the packaged migration names and checksums to match the database. Migration 0005
adds durable accepted-review item resolution; unknown legacy target selections
are not inferred or used to restore relationships automatically. Logs avoid request
bodies and credentials.
Docker logs rotate. Original audio defaults to 30-day retention; incomplete
transcription protects recordings from expiry. Capture retries and processing
leases are stored in PostgreSQL, so Redis loss does not lose originals.

The PWA caches icons and its public offline page only. Offline edits remain in
memory in the open page; they are not durably queued in browser storage. Do not
close an offline page containing unsaved input.

## Back up

The image includes PostgreSQL 17 client tools, ffmpeg, and restic. Backups briefly
put the application in maintenance mode, take a consistent database dump and
original-file copy, verify file hashes, and send the bundle to encrypted restic
storage. Retention keeps seven daily and four weekly snapshots. Back up `.env`,
the application password hash, and recovery credentials separately and privately.

Provision a random restic password inside the application volume without printing
it, then initialize the repository:

```sh
docker compose --env-file .env -f infrastructure/compose.production.yaml run --rm --no-deps operations node -e 'require("fs").writeFileSync("/data/secrets/restic-password",require("crypto").randomBytes(32).toString("hex"),{mode:0o600,flag:"wx"})'
docker compose --env-file .env -f infrastructure/compose.production.yaml run --rm --no-deps operations restic init
docker compose --env-file .env -f infrastructure/compose.production.yaml run --rm --no-deps operations pnpm ops backup
```

Keep a private recovery copy of `/data/secrets/restic-password` on another device.
Configure a second-destination restic repository or copy its encrypted repository
there. A backup on the same physical disk does not protect against disk loss.
Use `infrastructure/backup.cron.example` as the scheduling starting point; supply
absolute project paths and monitor backup status in Settings.

Deletion writes a separate, fsynced `erasures/manifest.jsonl`. Protect and copy that
manifest independently of snapshots. Never restore an older manifest over it.
Downloaded exports and old encrypted snapshots retain their own copies until
removed or expired; restore replays subsequent erasures before enabling reads.

## Morning brief

Set `NTFY_URL` (an ntfy server reachable from the worker), `NTFY_TOPIC` and
`NTFY_TOKEN` (a token allowed to publish to that topic; prefer a write-only
user) to receive one push a day at `BRIEF_TIME` in the configured timezone. It
lists what is overdue, due or starting today, what is due or starting in the
next six days, and deadlines in the next two weeks not mentioned for two weeks.
It is built from the ledger without a model and is skipped on quiet days, and a
worker that was down at brief time does not send it more than three hours late.
Subscribe to the topic in the ntfy app on your phone.

## Restore

Restore into an **empty, isolated PostgreSQL database and fresh application data
volume**, with the application stopped. Never test a restore over your only copy.
The CLI refuses a database that already contains application tables.

1. Mount your encrypted repository, password file, and current independent
   erasure manifest in an operations container. Provision an explicitly empty
   manifest only for an installation that has never accepted deletions.
2. Run `restic restore <snapshot-id> --target /backups/restored`. Locate the
   directory containing `manifest.json`, `database.dump`, and `erasures.jsonl`.
3. Set the operations container's `DATABASE_URL` and `DATA_DIR` to the isolated
   target. Run `pnpm ops restore /backups/restored/<bundle-directory>` there.
   The bundle path must be mounted into the container.
4. Restore verifies attachment hashes, replays independent erasures, clears
   sessions and export pins, and returns unfinished leases to retryable state.
   Keep the instance isolated on any error. Discard a failed target and retry in
   a new empty database; the CLI does not make a partially restored target live.
5. Provision password/provider configuration separately. Inspect originals,
   citations, erased data, and playback before switching traffic to the restored
   instance. Sign in again; sessions from the snapshot are revoked.

For an automated isolated drill against the dedicated test PostgreSQL on port
55432, run inside the built image:

```sh
docker run --rm --network host --user "$(id -u):$(id -g)" -v "$PWD:/app:ro" secondbrain:local node --import tsx scripts/verify-restore.ts
```

The drill creates uniquely named temporary databases and a temporary encrypted
repository, checks erasure replay and attachment integrity, and removes its data.

## Upgrades

Take a backup, build the new image, and run Compose up again. Migrations verify
checksums and serialize execution. Inspect health and processing failures after
an upgrade. Schema downgrades are not automatic; roll back through a verified
isolated restore when necessary.

This implementation covers Phase 1: capture, transcription, extraction, sourced
memory, conservative merging/review, hybrid recall, corrections, exports, and
operations. Streaming speech conversations, calendar integration, proactive
notifications and per-provider cost estimates
are not implemented.

Settings reports pending-job age, expired leases, safe failure codes, semantic
index coverage, available disk space and recent backup/restore runs. Low space
means less than 1 GiB or 10% free. Completed job attempts retain sanitized provider
model/schema/prompt versions, request duration and reported token counts; missing
usage is explicitly unknown. These counts are operational evidence, not a bill.
