import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createApp, EXCHANGE_SYNC_INTERVAL_MS } from './app.js'
import { pool } from './db.js'
import { config, type CurrentUser } from './config.js'
import { decryptIdpPayload } from './idp.js'

const testUsers: Record<string, CurrentUser> = {
  dmitry: {
    id: '10000000-0000-4000-8000-000000000001',
    phone: '79990000001',
    email: 'dmitry@aleph.local',
    displayName: 'Dmitry Aleph',
    firstName: 'Dmitry',
    lastName: 'Aleph',
    department: null,
    position: null,
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
    department: null,
    position: null,
    avatarUrl: null,
    timezone: 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'online',
  },
}

const deletedLiveKitRooms: string[] = []
let liveKitRoomExists = true

async function createTestApp() {
  return createApp({
    authenticate: async (token) => {
      const user = testUsers[token]
      if (!user) throw Object.assign(new Error('Authentication required'), { statusCode: 401 })
      return user
    },
    roomService: {
      listParticipants: async () => [
        { identity: testUsers.anna!.id, name: testUsers.anna!.displayName } as never,
      ],
      listRooms: async (roomNames) => liveKitRoomExists
        ? roomNames?.map((name) => ({ name }) as never) ?? []
        : [],
      deleteRoom: async (roomName) => { deletedLiveKitRooms.push(roomName) },
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

test('CORS headers are present on auth failures', async () => {
  const app = await createTestApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { origin: 'http://localhost:5173' },
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173')
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

test('creates recurring scheduled meetings', async () => {
  const app = await createTestApp()
  const meetingIds: string[] = []
  try {
    const startsAt = new Date(Date.now() + 60_000)
    const response = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__recurring_meeting_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: ['anna@aleph.local'],
        recurrenceRule: 'weekly',
        recurrenceCount: 3,
      },
    })
    assert.equal(response.statusCode, 201, response.body)
    const body = response.json() as { meetings: Array<{ id: string }> }
    assert.equal(body.meetings.length, 3)
    meetingIds.push(...body.meetings.map((meeting) => meeting.id))

    const result = await pool.query(
      `SELECT starts_at, recurrence_rule
       FROM meetings
       WHERE id = ANY($1::uuid[])
       ORDER BY starts_at`,
      [meetingIds],
    )
    assert.equal(result.rowCount, 3)
    assert.deepEqual(result.rows.map((row) => row.recurrence_rule), ['weekly', 'weekly', 'weekly'])
    assert.equal(
      new Date(result.rows[1].starts_at).getTime() - new Date(result.rows[0].starts_at).getTime(),
      7 * 24 * 60 * 60 * 1000,
    )
  } finally {
    if (meetingIds.length) await pool.query('DELETE FROM meetings WHERE id = ANY($1::uuid[])', [meetingIds])
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

test('transfers organizer role and lets only the new organizer end the room', async () => {
  const app = await createTestApp()
  let meetingId: string | undefined
  deletedLiveKitRooms.length = 0
  try {
    const startsAt = new Date()
    const created = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__organizer_transfer_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: [],
        attendeeUserIds: [testUsers.anna!.id],
      },
    })
    assert.equal(created.statusCode, 201, created.body)
    meetingId = created.json().meeting.id
    const roomName = created.json().meeting.roomName as string
    await pool.query("UPDATE meetings SET status='live' WHERE id=$1", [meetingId])

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/host`,
      headers: annaAuth,
      payload: { newHostId: testUsers.dmitry!.id },
    })
    assert.equal(forbidden.statusCode, 403, forbidden.body)

    const transferred = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/host`,
      headers: dmitryAuth,
      payload: { newHostId: testUsers.anna!.id },
    })
    assert.equal(transferred.statusCode, 200, transferred.body)
    assert.equal(transferred.json().meeting.hostId, testUsers.anna!.id)

    const oldOrganizer = await pool.query(
      'SELECT 1 FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',
      [meetingId, testUsers.dmitry!.id],
    )
    assert.equal(oldOrganizer.rowCount, 1)

    const oldHostEnd = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/end`,
      headers: dmitryAuth,
    })
    assert.equal(oldHostEnd.statusCode, 403, oldHostEnd.body)

    const ended = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/end`,
      headers: annaAuth,
    })
    assert.equal(ended.statusCode, 200, ended.body)
    assert.equal(ended.json().meeting.status, 'ended')
    assert.deepEqual(deletedLiveKitRooms, [roomName])
  } finally {
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id=$1', [meetingId])
    await app.close()
  }
})

test('ends a direct call before the LiveKit room exists', async () => {
  const app = await createTestApp()
  let meetingId: string | undefined
  liveKitRoomExists = false
  deletedLiveKitRooms.length = 0
  try {
    const startsAt = new Date()
    const created = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__cancel_before_answer_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: [],
        attendeeUserIds: [testUsers.anna!.id],
      },
    })
    meetingId = created.json().meeting.id
    await pool.query("UPDATE meetings SET status='live' WHERE id=$1", [meetingId])

    const ended = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/end`,
      headers: dmitryAuth,
    })
    assert.equal(ended.statusCode, 200, ended.body)
    assert.equal(ended.json().meeting.status, 'ended')
    assert.deepEqual(deletedLiveKitRooms, [])
  } finally {
    liveKitRoomExists = true
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id=$1', [meetingId])
    await app.close()
  }
})

test('invites a contact into a live meeting and records a decline', async () => {
  const app = await createTestApp()
  let meetingId: string | undefined
  try {
    await pool.query(
      `INSERT INTO contacts (owner_id, contact_user_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [testUsers.dmitry!.id, testUsers.anna!.id],
    )
    const startsAt = new Date()
    const created = await app.inject({
      method: 'POST',
      url: '/api/meetings',
      headers: dmitryAuth,
      payload: {
        title: '__live_invitation_test__',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 60 * 60_000).toISOString(),
        timezone: 'Europe/Moscow',
        attendees: [],
        attendeeUserIds: [],
      },
    })
    meetingId = created.json().meeting.id
    await pool.query("UPDATE meetings SET status='live' WHERE id=$1", [meetingId])

    const invited = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/invitations`,
      headers: dmitryAuth,
      payload: { userIds: [testUsers.anna!.id] },
    })
    assert.equal(invited.statusCode, 200, invited.body)
    assert.deepEqual(invited.json().invited, [testUsers.anna!.id])

    const declined = await app.inject({
      method: 'POST',
      url: `/api/meetings/${meetingId}/invitations/decline`,
      headers: annaAuth,
    })
    assert.equal(declined.statusCode, 200, declined.body)
    const attendee = await pool.query(
      'SELECT response FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',
      [meetingId, testUsers.anna!.id],
    )
    assert.equal(attendee.rows[0]?.response, 'declined')
  } finally {
    if (meetingId) await pool.query('DELETE FROM meetings WHERE id=$1', [meetingId])
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

test('loads AD users into contacts for department users', async () => {
  const app = await createTestApp()
  const originalFetch = globalThis.fetch
  const originalConfig = {
    idpBaseUrl: config.idpBaseUrl,
    idpAccessKey: config.idpAccessKey,
    idpEncodeKey: config.idpEncodeKey,
    idpDecodeKey: config.idpDecodeKey,
    adControlSecret: config.adControlSecret,
  }
  const originalDepartment = testUsers.dmitry!.department
  const adUserId = '90000000-0000-4000-8000-000000000010'
  const newAdUserId = '90000000-0000-4000-8000-000000000011'
  let fetchCount = 0

  Object.assign(config, {
    idpBaseUrl: 'https://api.alephtrade.com/id',
    idpAccessKey: 'idp-test-token',
    idpEncodeKey: 'idp-test-service-key',
    idpDecodeKey: 'idp-test-response-key',
    adControlSecret: 'ad-test-control-secret',
  })
  testUsers.dmitry!.department = 'Product'
  await pool.query(
    `INSERT INTO users (id, phone, email, display_name, timezone, locale)
     VALUES ($1,$2,$3,$4,'Europe/Moscow','ru-RU')
     ON CONFLICT (id) DO UPDATE SET
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name`,
    [adUserId, '79990000010', 'directory-contact@alephtrade.com', 'Old Directory Contact'],
  )
  globalThis.fetch = async (input, init) => {
    fetchCount += 1
    assert.equal(String(input), 'https://api.alephtrade.com/id/service/ad/users')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer idp-test-token')
    const body = JSON.parse(String(init?.body)) as { string: string }
    const payload = decryptIdpPayload<{ control_string: string }>(body.string, config.idpEncodeKey)
    assert.match(payload.control_string, /^[0-9a-f]{128}$/)
    return new Response(JSON.stringify({
      status: true,
      count: 2,
      users: [
        {
          dn: 'CN=Directory Contact,DC=alephtrade,DC=com',
          properties: {
            objectguid: [{ encoding: 'base64', value: 'LdaiDTZnSE+KG8/KoskhPg==' }],
            mail: ['directory-contact@alephtrade.com'],
            displayname: ['Directory Contact'],
            givenname: ['Directory'],
            sn: ['Contact'],
            department: ['Trading'],
            title: ['Senior trader'],
          },
        },
        {
          id: newAdUserId,
          email: 'new-contact@alephtrade.com',
          display_name: 'New Contact',
          department: 'Sales',
          position: 'Sales manager',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  try {
    const response = await app.inject({ method: 'GET', url: '/api/contacts', headers: dmitryAuth })
    assert.equal(response.statusCode, 200, response.body)
    const contact = response.json().contacts.find((item: { id: string }) => item.id === adUserId)
    assert.equal(contact?.department, 'Trading')
    assert.equal(contact?.position, 'Senior trader')
    assert.equal(contact?.email, 'directory-contact@alephtrade.com')
    const newContact = response.json().contacts.find((item: { id: string }) => item.id === newAdUserId)
    assert.equal(newContact?.department, 'Sales')
    assert.equal(newContact?.position, 'Sales manager')
    assert.equal(newContact?.email, 'new-contact@alephtrade.com')
    const created = await pool.query(
      'SELECT display_name, department, position FROM users WHERE id = $1',
      [newAdUserId],
    )
    assert.deepEqual(created.rows[0], { display_name: 'New Contact', department: 'Sales', position: 'Sales manager' })
    const cachedResponse = await app.inject({ method: 'GET', url: '/api/contacts', headers: dmitryAuth })
    assert.equal(cachedResponse.statusCode, 200, cachedResponse.body)
    assert.equal(fetchCount, 1)
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(config, originalConfig)
    testUsers.dmitry!.department = originalDepartment
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[adUserId, newAdUserId]])
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

    const whileActive = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: annaAuth,
    })
    assert.equal(whileActive.statusCode, 200, whileActive.body)
    assert.equal(
      whileActive.json().messages.some((message: { id: string }) => message.id === messageId),
      false,
      'active call must not appear in conversation history',
    )

    const finished = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}/calls/${messageId}`,
      headers: annaAuth,
      payload: { status: 'ended', durationMs: 65_000 },
    })
    assert.equal(finished.statusCode, 200, finished.body)
    assert.equal(finished.json().message.metadata.status, 'ended')
    assert.match(finished.json().message.body, /1:05/)

    const duplicateFinish = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}/calls/${messageId}`,
      headers: dmitryAuth,
      payload: { status: 'missed', durationMs: 0 },
    })
    assert.equal(duplicateFinish.statusCode, 200, duplicateFinish.body)
    assert.equal(duplicateFinish.json().message.metadata.status, 'ended')

    const afterFinish = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: annaAuth,
    })
    assert.equal(afterFinish.statusCode, 200, afterFinish.body)
    assert.equal(
      afterFinish.json().messages.filter((message: { id: string }) => message.id === messageId).length,
      1,
      'completed call must appear in conversation history',
    )
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
