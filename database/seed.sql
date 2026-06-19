INSERT INTO users (id, email, display_name, first_name, last_name, timezone, locale, presence)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'dmitry@aleph.local', 'Dmitry Aleph', 'Dmitry', 'Aleph', 'Europe/Moscow', 'ru-RU', 'online'),
  ('10000000-0000-4000-8000-000000000002', 'anna@aleph.local', 'Анна Волкова', 'Анна', 'Волкова', 'Europe/Moscow', 'ru-RU', 'online'),
  ('10000000-0000-4000-8000-000000000003', 'max@aleph.local', 'Максим Орлов', 'Максим', 'Орлов', 'Europe/Moscow', 'ru-RU', 'away'),
  ('10000000-0000-4000-8000-000000000004', 'elena@aleph.local', 'Елена Соколова', 'Елена', 'Соколова', 'Europe/Moscow', 'ru-RU', 'busy')
ON CONFLICT (id) DO NOTHING;

INSERT INTO contacts (owner_id, contact_user_id)
VALUES
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000004')
ON CONFLICT DO NOTHING;

INSERT INTO conversations (id, kind, title, created_by)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'direct', NULL, '10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002', 'group', 'Команда продукта', '10000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversation_members (conversation_id, user_id, role, last_read_at)
VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'owner', now()),
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'member', now()),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'owner', now()),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'member', now()),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'member', now()),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004', 'member', now())
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at)
VALUES
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'text', 'Привет! Макеты встречи готовы.', now() - interval '35 minutes'),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'text', 'Отлично, посмотрим на созвоне.', now() - interval '31 minutes'),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'text', 'Собрал вопросы к планированию релиза.', now() - interval '2 hours')
ON CONFLICT (id) DO NOTHING;

INSERT INTO meetings (id, host_id, title, description, room_name, starts_at, ends_at, timezone, status)
VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Синхронизация команды', 'Еженедельный статус по продукту', 'team-sync-demo', date_trunc('day', now()) + interval '1 day 11 hours', date_trunc('day', now()) + interval '1 day 12 hours', 'Europe/Moscow', 'scheduled'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', 'Демо AlephMeets', 'Проверка звонка и демонстрации экрана', 'aleph-demo-room', date_trunc('day', now()) + interval '3 days 15 hours', date_trunc('day', now()) + interval '3 days 16 hours', 'Europe/Moscow', 'scheduled')
ON CONFLICT (id) DO NOTHING;

INSERT INTO meeting_attendees (meeting_id, user_id, email, response)
VALUES
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'anna@aleph.local', 'accepted'),
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003', 'max@aleph.local', 'tentative'),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000004', 'elena@aleph.local', 'invited')
ON CONFLICT DO NOTHING;
