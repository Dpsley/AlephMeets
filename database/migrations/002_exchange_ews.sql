ALTER TABLE calendar_accounts
  DROP CONSTRAINT calendar_accounts_provider_check;

ALTER TABLE calendar_accounts
  ADD CONSTRAINT calendar_accounts_provider_check
  CHECK (provider IN ('exchange_ews', 'microsoft_graph'));

ALTER TABLE calendar_accounts
  ADD COLUMN server_url text,
  ADD COLUMN email text,
  ADD COLUMN username text,
  ADD COLUMN domain text,
  ADD COLUMN auth_method text CHECK (auth_method IN ('basic', 'ntlm')),
  ADD COLUMN encrypted_secret text,
  ADD COLUMN verify_tls boolean NOT NULL DEFAULT true,
  ADD COLUMN last_sync_error text;

CREATE INDEX calendar_accounts_user_provider_idx
  ON calendar_accounts (user_id, provider);
