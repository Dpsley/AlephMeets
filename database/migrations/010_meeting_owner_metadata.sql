ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS owner_email text,
  ADD COLUMN IF NOT EXISTS owner_display_name text;

UPDATE meetings meeting
SET owner_email = COALESCE(meeting.owner_email, host.email),
    owner_display_name = COALESCE(meeting.owner_display_name, host.display_name)
FROM users host
WHERE meeting.host_id = host.id
  AND (meeting.owner_email IS NULL OR meeting.owner_display_name IS NULL);

