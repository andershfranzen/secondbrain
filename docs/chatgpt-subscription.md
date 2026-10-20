# Use your ChatGPT subscription

Second Brain supports OpenAI's **Sign in with ChatGPT** flow for locally hosted
applications. You authorize Second Brain in your browser; the server stores a
renewable OAuth session. No OpenAI Platform API key or client secret is required.
The memory agent (organizing notes, tracking commitments, answering questions
with sources) uses the connected account's ChatGPT allowance. Eligibility and model access are determined by OpenAI
when you connect; this implementation has not yet been verified with a live account.

This is the subscription sign-in approach documented by OpenClaw, using OpenAI's
public Responses endpoint. It does not reuse browser cookies or another app's
credentials. Hermes also supports subscription access through Codex OAuth.

## Local development

Install the project and complete the normal database/application setup first.
From the repository root:

```sh
pnpm connect:chatgpt
```

Open the printed authorization URL in your browser and grant ChatGPT plan usage.
The callback listens only on `127.0.0.1` and expires after ten minutes. Do not paste
tokens into the app or chat. For a remote server, keep the connector running and
run its printed `ssh -N -L ...` command on your computer before opening the URL.
This forwards the browser's loopback callback to the server; Tailscale Serve is
not the OAuth callback.

List the models available to this connection:

```sh
pnpm models:chatgpt
```

Choose model slugs from that output for these `.env` values:

```dotenv
AI_PROVIDER=chatgpt
CHATGPT_CREDENTIALS_PATH=./secrets/chatgpt.json
REASONING_MODEL=<supported-model-slug>
```

The chosen model runs the agent: it must support function tools and structured
JSON output on the Responses API. Pick the strongest reasoning model your plan
offers; missing a commitment is the failure that matters. Each message costs a
few model calls (one per tool round), all counted against your allowance.

OpenAI documents that this endpoint accepts function tools, requires
`store:false` and streaming, and does not support `previous_response_id`. The
agent therefore resends the whole tool history on every step and never relies
on server-side state. Restart the API and worker, then enable cloud processing in Settings.
If pnpm is unavailable, use `npx --yes pnpm@10.28.2` in place of `pnpm`.

## Docker on the home server

Use the normal production setup in [operations.md](operations.md), build the
application image, then connect using the additional Compose file:

```sh
docker compose --env-file .env \
  -f infrastructure/compose.production.yaml \
  -f infrastructure/compose.chatgpt.yaml \
  --profile auth run --rm chatgpt-connect
```

Follow the printed SSH forwarding instructions from your computer. The connector
uses host networking on Linux so its loopback callback can be forwarded by SSH.
It receives only the dedicated credential volume, without your captures or database.

List models using the same volume:

```sh
docker compose --env-file .env \
  -f infrastructure/compose.production.yaml \
  -f infrastructure/compose.chatgpt.yaml \
  --profile auth run --rm chatgpt-connect pnpm models:chatgpt
```

Set `REASONING_MODEL` in `.env`, then start/recreate the app
with both files:

```sh
docker compose --env-file .env \
  -f infrastructure/compose.production.yaml \
  -f infrastructure/compose.chatgpt.yaml up -d --build
```

Use both files for subsequent application restarts and updates. The override sets
`AI_PROVIDER=chatgpt` for the API and worker and mounts their shared credential
volume. Do not remove that volume during an ordinary update.

## Limits, privacy, and recovery

- Before relying on it, run the scenario evaluation against your connection:
  `pnpm eval:agent --live --send-synthetic-to-provider --database <eval-db-url>`.
  It replays a synthetic month of work notes and reports missed commitments.
  See [evaluation](../evaluation/README.md).
- This connection supports **text reasoning**. It does not provide transcription,
  speech-to-speech conversations, or embeddings. Original recordings are safely
  retained; transcription jobs wait for a compatible provider. Recall uses text
  search, current structured knowledge, and aliases without semantic vectors.
- Subscription mode never falls back to your Platform API key, even if one exists
  in `.env`. When the allowance is unavailable, jobs wait/retry and captures remain
  saved. An expired or revoked connection requires reauthorization.
- OpenAI can permit **credits after plan limits** if enabled in your ChatGPT
  account. To stay within the subscription, disable that option for this app in
  [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage). Second Brain does
  not control OpenAI's account-level credit settings. Allowances are shared with
  other eligible apps; this is not unlimited usage.
- Relevant captured text and source excerpts are sent to OpenAI after you enable
  cloud processing. Originals, provenance, corrections, and chat history remain in
  your database. Requests use `store:false`, but this is not a claim that OpenAI
  never processes or retains request data under its applicable policies.
- Credentials use owner-only files and atomic replacement; API and worker serialize
  refreshes so rotating refresh tokens cannot race. Credentials never enter browser
  storage, exports, provider telemetry, or the application backup. The dedicated
  Docker auth volume is excluded from backup; reconnect after a restore.
- Keep the credential path outside `DATA_DIR` and any exported or backed-up folder.
  Keep its `.host.json` companion for the same host. Treat the entire auth directory
  as private. A new host should receive a new host identifier.

Run `pnpm connect:chatgpt` again to reauthorize the same connected account. To revoke
its renewable session and remove local tokens:

```sh
pnpm disconnect:chatgpt
```

For Docker, replace `pnpm models:chatgpt` in the command above with
`pnpm disconnect:chatgpt`. Stop the API and worker before disconnecting, and restart
them after reconnecting. If remote revocation cannot be confirmed, credentials
remain available for retry; you can also disconnect Second Brain in ChatGPT Settings.
The connector currently manages one active registration at the configured path.

## References

Verified against official documentation on 19 October 2026:

- [OpenAI: registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI: models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI: sessions, refresh, and usage](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI: preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenAI: self-hosted machines](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [OpenClaw: OpenAI authentication](https://docs.openclaw.ai/providers/openai/authentication)
