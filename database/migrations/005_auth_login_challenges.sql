CREATE TABLE auth_login_challenges (
  phone text PRIMARY KEY,
  auid text NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_login_challenges_expiry_idx ON auth_login_challenges (expires_at);
