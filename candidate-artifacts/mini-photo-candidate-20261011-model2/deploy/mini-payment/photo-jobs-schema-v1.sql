-- Candidate only. Never executed at import or service startup.
-- Apply to the separately verified mini-program database after backup and schema review.
-- Existing runtime account needs only its current database-scoped CRUD grants.
CREATE TABLE IF NOT EXISTS mini_photo_jobs (
  id VARCHAR(80) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL,
  idem VARCHAR(128) NOT NULL,
  spec LONGTEXT NOT NULL,
  spec_hash CHAR(64) NOT NULL,
  billing_ref VARCHAR(128) NOT NULL,
  state VARCHAR(24) NOT NULL,
  claim_token VARCHAR(80),
  claimed_at BIGINT,
  attempt INTEGER NOT NULL DEFAULT 0,
  output_asset_id VARCHAR(128),
  provider_ref VARCHAR(128),
  failure_code VARCHAR(64),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, idem),
  UNIQUE(user_id, billing_ref),
  FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  CHECK(attempt IN (0,1)),
  CHECK(state IN ('queued','claimed','result_ready','succeeded','cancelled','blocked','unknown')),
  CHECK(state NOT IN ('result_ready','succeeded') OR output_asset_id IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE INDEX mini_photo_jobs_pending ON mini_photo_jobs(state,created_at,id);
