-- Candidate MySQL DDL only; reviewed explicit migration, never startup/import SQL.
-- Run after vp_accounts and photo-jobs/context-schema.sql in the SAME database.
-- Metadata only. Raw photographs remain in immutable private OSS objects.
CREATE TABLE IF NOT EXISTS mini_photo_uploads (
  id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, idem CHAR(32) NOT NULL,
  state VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE, asset_id VARCHAR(128) NOT NULL UNIQUE,
  sha256 CHAR(64) NOT NULL, byte_length BIGINT NOT NULL, content_type VARCHAR(32) NOT NULL,
  consent_epoch INTEGER NOT NULL, basic_version VARCHAR(80) NOT NULL, face_version VARCHAR(80) NOT NULL,
  moderation_version VARCHAR(80) NOT NULL, moderation_service VARCHAR(80) NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, recovery_checks INTEGER NOT NULL DEFAULT 0, receipt LONGTEXT,
  source_cleanup_pending INTEGER NOT NULL DEFAULT 0, moderation_cleanup_pending INTEGER NOT NULL DEFAULT 0,
  moderation_cleanup_reference CHAR(32) UNIQUE, moderation_cleanup_extension VARCHAR(4),
  expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  UNIQUE(user_id,idem), FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
  CHECK(state IN ('staging','queued','claimed','reviewed','ready','rejected','review','unknown','cancelled')),
  CHECK(attempts IN (0,1)), CHECK(source_cleanup_pending IN (0,1)), CHECK(moderation_cleanup_pending IN (0,1)),
  CHECK(byte_length > 0 AND byte_length <= 2097152)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Deletion evidence stays pending for recheck; no row means "permanently gone".
CREATE TABLE IF NOT EXISTS mini_photo_upload_cleanup (
  upload_id VARCHAR(80) NOT NULL, kind VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE,
  state VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, operation_token CHAR(32),
  delete_status VARCHAR(16) NOT NULL DEFAULT 'not_started', observation VARCHAR(16) NOT NULL DEFAULT 'not_checked',
  next_at BIGINT NOT NULL, delete_started_at BIGINT, checked_at BIGINT, last_absent_at BIGINT, last_present_at BIGINT,
  absent_observations INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  PRIMARY KEY(upload_id,kind), FOREIGN KEY(upload_id) REFERENCES mini_photo_uploads(id),
  CHECK(kind IN ('source','moderation')), CHECK(state IN ('pending','observing','absent_observed','present','unknown')),
  CHECK(delete_status IN ('not_started','unknown','acknowledged')), CHECK(observation IN ('not_checked','unknown','absent','present')),
  CHECK(attempts >= 0), CHECK(absent_observations >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
