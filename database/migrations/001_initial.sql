CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_presence AS ENUM ('online', 'away', 'busy', 'offline');
CREATE TYPE conversation_kind AS ENUM ('direct', 'group', 'meeting');
CREATE TYPE message_kind AS ENUM ('text', 'file', 'audio', 'system');
CREATE TYPE meeting_status AS ENUM ('scheduled', 'live', 'ended', 'cancelled');
CREATE TYPE attendee_status AS ENUM ('invited', 'accepted', 'declined', 'tentative');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  first_name text,
  last_name text,
  avatar_url text,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en-US',
  presence user_presence NOT NULL DEFAULT 'offline',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias text,
  favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, contact_user_id),
  CHECK (owner_id <> contact_user_id)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind conversation_kind NOT NULL,
  title text,
  avatar_url text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  last_read_at timestamptz,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind message_kind NOT NULL DEFAULT 'text',
  body text,
  reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (body IS NOT NULL OR kind IN ('file', 'audio', 'system'))
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  original_name text NOT NULL,
  storage_name text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  description text,
  room_name text NOT NULL UNIQUE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  status meeting_status NOT NULL DEFAULT 'scheduled',
  passcode_hash text,
  waiting_room boolean NOT NULL DEFAULT true,
  allow_join_before_host boolean NOT NULL DEFAULT false,
  mute_on_entry boolean NOT NULL DEFAULT true,
  record_automatically boolean NOT NULL DEFAULT false,
  recurrence_rule text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE meeting_attendees (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  response attendee_status NOT NULL DEFAULT 'invited',
  joined_at timestamptz,
  left_at timestamptz,
  PRIMARY KEY (meeting_id, email)
);

CREATE TABLE calendar_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('outlook_com', 'microsoft_graph')),
  external_account_id text,
  display_name text NOT NULL,
  sync_enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  sync_cursor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, external_account_id)
);

CREATE TABLE calendar_event_links (
  account_id uuid NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  external_event_id text NOT NULL,
  external_change_key text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, meeting_id),
  UNIQUE (account_id, external_event_id)
);

CREATE INDEX messages_conversation_created_idx ON messages (conversation_id, created_at DESC);
CREATE INDEX meetings_host_start_idx ON meetings (host_id, starts_at);
CREATE INDEX meeting_attendees_user_idx ON meeting_attendees (user_id, meeting_id);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id, conversation_id);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER meetings_set_updated_at BEFORE UPDATE ON meetings
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
