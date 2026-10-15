-- Candidate MySQL DDL. Explicit reviewed migration only; never run at import/startup.
-- Requires the existing vp_accounts / vp_audit and the photo job table in the same database.
-- No separate entitlement, reservation, or payment ledger is created here.
CREATE TABLE IF NOT EXISTS mini_photo_accounts (
  user_id VARCHAR(80) PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  consent_epoch INTEGER NOT NULL DEFAULT 0,
  basic_version VARCHAR(80),
  face_version VARCHAR(80),
  subject_authorization VARCHAR(16),
  updated_at BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  CHECK(enabled IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS mini_photo_effects (
  effect_id VARCHAR(80) NOT NULL,
  version VARCHAR(80) NOT NULL,
  provider VARCHAR(80) NOT NULL,
  model VARCHAR(100) NOT NULL,
  purpose VARCHAR(100) NOT NULL,
  parameters LONGTEXT NOT NULL,
  enabled INTEGER NOT NULL,
  review_reference VARCHAR(128) NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(effect_id,version),
  CHECK(enabled IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS mini_photo_assets (
  id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(80) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  storage_key VARCHAR(512) NOT NULL UNIQUE,
  sha256 CHAR(64) NOT NULL,
  byte_length BIGINT NOT NULL,
  content_type VARCHAR(32) NOT NULL,
  consent_epoch INTEGER NOT NULL,
  job_id VARCHAR(80) UNIQUE,
  moderation_reference VARCHAR(128) NOT NULL,
  label_version VARCHAR(80),
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  CHECK(kind IN ('input','output')),
  CHECK(state IN ('ready','staged','published','revoked','deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS mini_photo_works (
  job_id VARCHAR(80) PRIMARY KEY,
  asset_id VARCHAR(128) NOT NULL UNIQUE,
  user_id VARCHAR(80) NOT NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  FOREIGN KEY(asset_id) REFERENCES mini_photo_assets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
