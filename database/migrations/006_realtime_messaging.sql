ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN last_seen_at timestamptz;

ALTER TABLE contacts DROP COLUMN IF EXISTS favorite;

ALTER TABLE messages
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE meeting_attendees ADD COLUMN id uuid DEFAULT gen_random_uuid();
ALTER TABLE meeting_attendees DROP CONSTRAINT meeting_attendees_pkey;
ALTER TABLE meeting_attendees ALTER COLUMN id SET NOT NULL;
ALTER TABLE meeting_attendees ADD PRIMARY KEY (id);
ALTER TABLE meeting_attendees ALTER COLUMN email DROP NOT NULL;
ALTER TABLE meeting_attendees
  ADD CONSTRAINT meeting_attendees_identity_check CHECK (user_id IS NOT NULL OR email IS NOT NULL);

CREATE UNIQUE INDEX meeting_attendees_meeting_user_unique_idx
  ON meeting_attendees (meeting_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX meeting_attendees_meeting_email_unique_idx
  ON meeting_attendees (meeting_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX users_presence_last_seen_idx ON users (presence, last_seen_at);
