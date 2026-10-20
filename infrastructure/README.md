# Development infrastructure

This Compose file starts PostgreSQL/pgvector and Redis only. Application services,
Dockerfiles, backup scripts and production hardening are implementation work
specified in [the implementation document](../docs/implementation-spec.md).
Image tags here are development baselines; pin tested digests for production.

Set `POSTGRES_PASSWORD` privately in your environment, then run from the repository:

```sh
docker compose -f infrastructure/compose.yaml up -d --wait
docker compose -f infrastructure/compose.yaml exec -T postgres \
  psql -U secondbrain -d secondbrain -v ON_ERROR_STOP=1 \
  < packages/database/migrations/0001_initial.sql
```

Run the initial migration once against an empty database. The future application
migration runner must track applied versions/checksums and hold an advisory lock.

After applying it to a disposable database, run the transactional smoke checks:

```sh
docker compose -f infrastructure/compose.yaml exec -T postgres \
  psql -U secondbrain -d secondbrain -v ON_ERROR_STOP=1 \
  < packages/database/tests/0001_smoke.sql
```

The checks roll back fixtures and verify typed foreign keys, deadline/completion
constraints, source ranges, generated-origin uniqueness, job leases, vector
dimensions and lexical retrieval without a vector. They do not test application
logic that has not been implemented.

Stopping with `docker compose -f infrastructure/compose.yaml down` retains data;
adding `--volumes` deletes it. The loopback ports are for local development only.
Redis is unauthenticated on loopback in this development configuration; do not
expose it to other machines. Production services use a private Compose network.
