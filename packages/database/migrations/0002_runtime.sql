BEGIN;
ALTER TABLE app_settings ADD COLUMN maintenance boolean NOT NULL DEFAULT false;
CREATE TABLE audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL,
 reference_id uuid,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE upload_leases (
 storage_key text PRIMARY KEY,
 expires_at timestamptz NOT NULL
);
CREATE TABLE backup_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('backup','restore')),
 status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 snapshot_id text
);
COMMIT;
