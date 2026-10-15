-- Candidate DDL. Explicit migration only, same database as vp and mini_photo_jobs/context.
-- Provider result URL is private server data, never an HTTP response or log field.
CREATE TABLE IF NOT EXISTS mini_photo_generation (
  job_id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, spec_hash CHAR(64) NOT NULL,
  policy LONGTEXT NOT NULL, asset_id VARCHAR(128) NOT NULL UNIQUE, output_key VARCHAR(512) NOT NULL UNIQUE,
  marked_sha256 CHAR(64), marked_length BIGINT, marked_type VARCHAR(32), provider_receipt LONGTEXT, review_receipt LONGTEXT,
  moderation_reference CHAR(32) UNIQUE, moderation_extension VARCHAR(4), moderation_cleanup_pending INTEGER NOT NULL DEFAULT 0,
  output_cleanup_pending INTEGER NOT NULL DEFAULT 1, registered INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  FOREIGN KEY(job_id) REFERENCES mini_photo_jobs(id), FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  CHECK(registered IN (0,1)), CHECK(output_cleanup_pending IN (0,1)), CHECK(moderation_cleanup_pending IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS mini_photo_generation_operations (
  job_id VARCHAR(80) NOT NULL, step VARCHAR(24) NOT NULL, state VARCHAR(16) NOT NULL,
  token CHAR(32) NOT NULL, attempts INTEGER NOT NULL, started_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY(job_id,step), FOREIGN KEY(job_id) REFERENCES mini_photo_generation(job_id),
  CHECK(state IN ('started','succeeded','unknown')), CHECK(attempts > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS mini_photo_generation_cleanup (
  job_id VARCHAR(80) NOT NULL, kind VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE,
  state VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, operation_token CHAR(32),
  delete_status VARCHAR(16) NOT NULL DEFAULT 'not_started', observation VARCHAR(16) NOT NULL DEFAULT 'not_checked',
  next_at BIGINT NOT NULL, checked_at BIGINT, absent_observations INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY(job_id,kind), FOREIGN KEY(job_id) REFERENCES mini_photo_generation(job_id),
  CHECK(kind IN ('output','moderation')), CHECK(state IN ('pending','observing','absent_observed','present','unknown')),
  CHECK(delete_status IN ('not_started','unknown','acknowledged')), CHECK(observation IN ('not_checked','unknown','absent','present')),
  CHECK(attempts >= 0), CHECK(absent_observations >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
