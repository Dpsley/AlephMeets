ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS storage_bucket text,
  ADD COLUMN IF NOT EXISTS storage_key text,
  ADD COLUMN IF NOT EXISTS storage_url text;

CREATE UNIQUE INDEX IF NOT EXISTS attachments_storage_bucket_key_idx
  ON attachments(storage_bucket, storage_key)
  WHERE storage_bucket IS NOT NULL AND storage_key IS NOT NULL;
