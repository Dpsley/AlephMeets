import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createApp, EXCHANGE_SYNC_INTERVAL_MS } from './app.js'
import { pool } from './db.js'
import type { CurrentUser } from './config.js'

const testUsers: Record<string, CurrentUser> = {
  dmitry: {
    id: '10000000-0000-4000-8000-000000000001',
    phone: '79990000001',
    email: 'dmitry@aleph.local',
    displayName: 'Dmitry Aleph',
    firstName: 'Dmitry',
    lastName: 'Aleph',
    avatarUrl: null,
    timezone: 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'online',
  },
  anna: {
    id: '10000000-0000-4000-8000-000000000002',
    phone: '79990000002',
    email: 'anna@aleph.local',
    displayName: 'Анна Волкова',
    firstName: 'Анна',
    lastName: 'Волкова',
    avatarUrl: null,
    timezone: 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'online',
  },
}

async function createTestApp() {
  return createApp({
    authenticate: async (token) => {
      const user = testUsers[token]
      if (!user) throw Object.assign(new Error('Authentication required'), { statusCode: 401 })
      return user
    },
  })
}

const dmitryAuth = { authorization: 'Bearer dmitry' }
const annaAuth = { authorization: 'Bearer anna' }

test('schedules Exchange calendar sync every five minutes', () => {
  assert.equal(EXCHANGE_SYNC_INTERVAL_MS, 300_000)
})

after(async () => {
  await pool.end()
})

test('CORS preflight allows meeting status PATCH requests', async () => {
  const app = await createTestApp()
  try {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/meetings/40000000-0000-4000-8000-000000000001/status',
      headers: {
        origin: 'null',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'content-type',
      },
    })
    assert.equal(response.statusCode, 204)
    assert.match(response.headers['access-control-allow-methods'] ?? '', /PATCH/)
  } finally {
    await app.close()
  }
})

test('keeps Bearer identities isolated per concurrent request', async () => {
  const app = await createTestApp()
  try {
    const [dmitryResponse, annaResponse] = await Promise.all([
      app.inject({
        method: 'GET',
        url: '/api/session',
        headers: dmitryAuth,
      }),
      app.inject({
        method: 'GET',
        url: '/api/session',
        headers: annaAuth,
      }),
    ])
    assert.equal(dmitryResponse.json().user.email, 'dmitry@aleph.local')
    assert.equal(annaResponse.json().user.email, 'anna@aleph.local')
  } finally {
    await app.close()
  }
})

test('creates a meeting with a registered attendee', async () => {
  const app = await createTestApp()
  let meetingId: string | undefined
  try {
    const startsAt = new Date(Date.now() + 60_000)
    const response = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__attendee_uuid_regression_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: ['anna@aleph.local'],
        waitingRoom: false,
        muteOnEntry: false,
        allowJoinBeforeHost: true,
      },
    })
    assert.equal(response.statusCode, 201, response.body)
    meetingId = response.json().meeting.id
    const attendee = await pool.query(
      'SELECT user_id FROM meeting_attendees WHERE meeting_id = $1',
      [meetingId],
    )
    assert.equal(attendee.rows[0]?.user_id, '10000000-0000-4000-8000-000000000002')
  } finally {
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id = $1', [meetingId])
    await app.close()
  }
})

test('creates a meeting attendee that has no email', async () => {
  const app = await createTestApp()
  const attendeeId = '10000000-0000-4000-8000-000000000099'
  let meetingId: string | undefined
  try {
    await pool.query(
      `INSERT INTO users (id, phone, email, display_name, timezone, locale)
       VALUES ($1,$2,NULL,$3,'Europe/Moscow','ru-RU')`,
      [attendeeId, '79990000099', 'No Email User'],
    )
    const startsAt = new Date(Date.now() + 60_000)
    const response = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__attendee_without_email_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: [],
        attendeeUserIds: [attendeeId],
      },
    })
    assert.equal(response.statusCode, 201, response.body)
    meetingId = response.json().meeting.id
    const attendee = await pool.query(
      'SELECT user_id, email FROM meeting_attendees WHERE meeting_id = $1',
      [meetingId],
    )
    assert.deepEqual(attendee.rows[0], { user_id: attendeeId, email: null })
  } finally {
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id = $1', [meetingId])
    await pool.query('DELETE FROM users WHERE id = $1', [attendeeId])
    await app.close()
  }
})

test('reports presence as online only while the heartbeat is fresh', async () => {
  const app = await createTestApp()
  const annaId = '10000000-0000-4000-8000-000000000002'
  try {
    await pool.query(
      `UPDATE users SET presence = 'online', last_seen_at = now() WHERE id = $1`,
      [annaId],
    )
    const online = await app.inject({ method: 'GET', url: '/api/contacts', headers: dmitryAuth })
    assert.equal(
      online.json().contacts.find((contact: { id: string }) => contact.id === annaId)?.status,
      'online',
    )

    await pool.query(
      `UPDATE users SET last_seen_at = now() - interval '2 minutes' WHERE id = $1`,
      [annaId],
    )
    const offline = await app.inject({ method: 'GET', url: '/api/contacts', headers: dmitryAuth })
    assert.equal(
      offline.json().contacts.find((contact: { id: string }) => contact.id === annaId)?.status,
      'offline',
    )
  } finally {
    await pool.query(
      `UPDATE users SET presence = 'offline', last_seen_at = NULL WHERE id = $1`,
      [annaId],
    )
    await app.close()
  }
})

test('reuses direct conversations and reports message read status', async () => {
  const app = await createTestApp()
  let messageId: string | undefined
  try {
    const createPayload = { memberIds: ['10000000-0000-4000-8000-000000000002'] }
    const firstConversation = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: dmitryAuth,
      payload: createPayload,
    })
    const secondConversation = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: dmitryAuth,
      payload: createPayload,
    })
    assert.equal(firstConversation.statusCode, 200, firstConversation.body)
    assert.equal(secondConversation.json().conversation.id, firstConversation.json().conversation.id)
    const conversationId = firstConversation.json().conversation.id as string

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: dmitryAuth,
      payload: { body: '__delivery_status_test__' },
    })
    assert.equal(sent.statusCode, 201, sent.body)
    messageId = sent.json().message.id
    assert.equal(sent.json().message.deliveryStatus, 'delivered')

    await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: annaAuth,
    })
    const senderView = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: dmitryAuth,
    })
    const message = senderView.json().messages.find((item: { id: string }) => item.id === messageId)
    assert.equal(message?.deliveryStatus, 'read')
  } finally {
    if (messageId) await pool.query('DELETE FROM messages WHERE id = $1', [messageId])
    await app.close()
  }
})

test('stores a completed direct call in the conversation history', async () => {
  const app = await createTestApp()
  let meetingId: string | undefined
  let messageId: string | undefined
  try {
    const conversationResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: dmitryAuth,
      payload: { memberIds: ['10000000-0000-4000-8000-000000000002'] },
    })
    const conversationId = conversationResponse.json().conversation.id as string
    const startsAt = new Date()
    const meetingResponse = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__direct_call_history_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: [],
        attendeeUserIds: ['10000000-0000-4000-8000-000000000002'],
      },
    })
    meetingId = meetingResponse.json().meeting.id
    const started = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/calls`,
      headers: dmitryAuth,
      payload: { meetingId },
    })
    assert.equal(started.statusCode, 201, started.body)
    messageId = started.json().message.id

    const finished = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}/calls/${messageId}`,
      headers: annaAuth,
      payload: { status: 'ended', durationMs: 65_000 },
    })
    assert.equal(finished.statusCode, 200, finished.body)
    assert.equal(finished.json().message.metadata.status, 'ended')
    assert.match(finished.json().message.body, /1:05/)
  } finally {
    if (messageId) await pool.query('DELETE FROM messages WHERE id = $1', [messageId])
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id = $1', [meetingId])
    await app.close()
  }
})

test('allows only the group owner to manage title and members', async () => {
  const app = await createTestApp()
  let conversationId: string | undefined
  const dmitry = dmitryAuth
  const anna = annaAuth
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: dmitry,
      payload: {
        title: '__group_management_test__',
        memberIds: ['10000000-0000-4000-8000-000000000002'],
      },
    })
    assert.equal(created.statusCode, 201, created.body)
    conversationId = created.json().conversation.id

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: anna,
      payload: { title: 'Нельзя переименовать' },
    })
    assert.equal(forbidden.statusCode, 403)

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: dmitry,
      payload: { title: 'Новая тестовая группа' },
    })
    assert.equal(renamed.statusCode, 200, renamed.body)

    const added = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/members`,
      headers: dmitry,
      payload: { memberIds: ['10000000-0000-4000-8000-000000000003'] },
    })
    assert.equal(added.statusCode, 200, added.body)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}/members/10000000-0000-4000-8000-000000000002`,
      headers: dmitry,
    })
    assert.equal(removed.statusCode, 200, removed.body)

    const members = await pool.query(
      'SELECT user_id, role FROM conversation_members WHERE conversation_id = $1 ORDER BY role, user_id',
      [conversationId],
    )
    assert.deepEqual(members.rows, [
      { user_id: '10000000-0000-4000-8000-000000000003', role: 'member' },
      { user_id: '10000000-0000-4000-8000-000000000001', role: 'owner' },
    ])
  } finally {
    if (conversationId) await pool.query('DELETE FROM conversations WHERE id = $1', [conversationId])
    await app.close()
  }
})
