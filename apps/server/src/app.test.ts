import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createApp } from './app.js'
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
