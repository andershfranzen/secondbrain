# Pin this base digest alongside the infrastructure images on release.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS base
RUN npm install --global pnpm@10.28.2
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
ENV API_ORIGIN=http://api:3001
RUN pnpm build
FROM base AS runtime
RUN apt-get update && apt-get install --yes --no-install-recommends ffmpeg postgresql-client-17 restic ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
RUN chmod -R a+rX /app
RUN mkdir -p /data /erasures /chatgpt-auth && chown node:node /data /erasures /chatgpt-auth
USER node
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/data ERASURE_MANIFEST_PATH=/erasures/manifest.jsonl
EXPOSE 3000 3001
CMD ["pnpm","start:api"]
