import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import { nanoid } from 'nanoid'
import { Server as SocketServer } from 'socket.io'
import { ZodError } from 'zod'
import {
  config,
  type CurrentUser,
  enterCurrentUserContext,
  currentUser,
} from './config.js'
import { decryptCredential, encryptCredential } from './credentials.js'
import { inTransaction, pool } from './db.js'
import { getOutlookStatus, listOutlookEvents, upsertOutlookEvent } from './outlook.js'
import {
  createExchangeEvent,
  type ExchangeCredentials,
  listExchangeEvents,
  normalizeEwsUrl,
  testExchangeConnection,
} from './exchange.js'
import {
  callLogFinishSchema,
  callLogStartSchema,
  contactInputSchema,
  conversationInputSchema,
  conversationMembersSchema,
  conversationTitleSchema,
  exchangeSettingsSchema,
  meetingInputSchema,
  messageInputSchema,
} from './schemas.js'
import { camelizeRow, camelizeRows } from './serializers.js'
import {
  authenticateAccessToken,
  findIdpContact,
  type IdpTokens,
  logoutSession,
  refreshSession,
  requestSms,
  verifySms,
} from './idp.js'

interface IdParams {
  id: string
}

interface AppDependencies {
  authenticate?: (accessToken: string) => Promise<CurrentUser>
}

interface ExchangeAccountRow {
  id: string
  server_url: string
  email: string
  username: string
  domain: string | null
  auth_method: 'basic' | 'ntlm'
  encrypted_secret: string
  verify_tls: boolean
}

function exchangeCredentials(account: ExchangeAccountRow): ExchangeCredentials {
  return {
    serverUrl: account.server_url,
    email: account.email,
    username: account.username,
    password: decryptCredential(account.encrypted_secret),
    domain: account.domain ?? '',
    authMethod: account.auth_method,
    verifyTls: account.verify_tls,
  }
}

function publicUser(row: Record<string, unknown>): Record<string, unknown> {
  return camelizeRow(row)
}

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? ''
}

function callSummary(status: 'ended' | 'declined' | 'missed', durationMs: number): string {
  if (status === 'declined') return 'Отклоненный звонок'
  if (status === 'missed') return 'Пропущенный звонок'
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `Звонок завершен · ${minutes}:${seconds}`
}

export async function createApp(dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const authenticate = dependencies.authenticate ?? authenticateAccessToken
  const app = Fastify({ logger: true, bodyLimit: config.maxUploadBytes })
  const io = new SocketServer(app.server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
  })
  const presenceDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const setPresence = async (userId: string, status: 'online' | 'offline'): Promise<void> => {
    await pool.query(
      'UPDATE users SET presence = $2, last_seen_at = now() WHERE id = $1',
      [userId, status],
    )
    io.emit('presence:changed', { userId, status })
  }

  const emitMessageToMembers = async (
    conversationId: string,
    message: Record<string, unknown>,
  ): Promise<void> => {
    await emitToConversationMembers(conversationId, 'message:new', message)
  }

  const emitToConversationMembers = async (
    conversationId: string,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const members = await pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [conversationId],
    )
    for (const member of members.rows) {
      io.to(`user:${String(member.user_id)}`).emit(event, payload)
    }
  }

  const emitConversationUpdated = async (
    conversationId: string,
    additionalUserIds: string[] = [],
  ): Promise<void> => {
    const members = await pool.query(
      'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
      [conversationId],
    )
    const userIds = new Set([
      ...members.rows.map((member) => String(member.user_id)),
      ...additionalUserIds,
    ])
    for (const userId of userIds) {
      io.to(`user:${userId}`).emit('conversation:updated', { conversationId })
    }
  }

  app.addHook('onRequest', (request, _reply, done) => {
    const path = request.url.split('?')[0] ?? request.url
    const isPublic = request.method === 'OPTIONS'
      || path === '/health'
      || path.startsWith('/api/auth/')
      || (request.method === 'GET' && path.startsWith('/uploads/'))
    if (isPublic) {
      done()
      return
    }
    const token = bearerToken(request.headers.authorization)
    if (!token) {
      done(Object.assign(new Error('Authentication required'), { statusCode: 401 }))
      return
    }
    void authenticate(token)
      .then((user) => {
        enterCurrentUserContext(user)
        done()
      })
      .catch(done)
  })

  if (!existsSync(config.uploadDir)) mkdirSync(config.uploadDir, { recursive: true })

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } })
  await app.register(fastifyStatic, {
    root: config.uploadDir,
    prefix: '/uploads/',
    decorateReply: false,
  })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: error.issues })
    }
    const normalized = error instanceof Error ? error : new Error(String(error))
    app.log.error(normalized)
    return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({
      error: 'request_failed',
      message: normalized.message,
    })
  })

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : ''
    void authenticate(token)
      .then((user) => {
        socket.data.user = user
        next()
      })
      .catch(() => next(new Error('Authentication required')))
  })

  io.on('connection', (socket) => {
    const socketUser = socket.data.user as CurrentUser
    socket.data.userId = socketUser.id
    socket.join(`user:${socketUser.id}`)
    const disconnectTimer = presenceDisconnectTimers.get(socketUser.id)
    if (disconnectTimer) clearTimeout(disconnectTimer)
    presenceDisconnectTimers.delete(socketUser.id)
    void setPresence(socketUser.id, 'online')
    socket.on('presence:heartbeat', () => {
      void pool.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [socketUser.id])
    })
    socket.on('conversation:join', async (conversationId: string) => {
      const membership = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, socketUser.id],
      )
      if (membership.rowCount) socket.join(`conversation:${conversationId}`)
    })
    socket.on('conversation:leave', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`)
    })
    socket.on('call:invite', async (payload: {
      targetUserId?: string
      meeting?: Record<string, unknown>
      callContext?: Record<string, unknown>
    }) => {
      const targetUserId = payload.targetUserId
      const meetingId = typeof payload.meeting?.id === 'string' ? payload.meeting.id : undefined
      if (!targetUserId || !meetingId || targetUserId === socketUser.id) return
      const allowed = await pool.query(
        `SELECT 1 FROM meetings m
         JOIN meeting_attendees attendee ON attendee.meeting_id = m.id
         WHERE m.id::text = $1 AND m.host_id = $2 AND attendee.user_id::text = $3`,
        [meetingId, socketUser.id, targetUserId],
      )
      if (!allowed.rowCount) return
      io.to(`user:${targetUserId}`).emit('call:incoming', {
        meeting: payload.meeting,
        caller: socketUser,
        callContext: payload.callContext,
      })
    })
    socket.on('disconnect', () => {
      const timer = setTimeout(() => {
        presenceDisconnectTimers.delete(socketUser.id)
        const activeSockets = io.sockets.adapter.rooms.get(`user:${socketUser.id}`)?.size ?? 0
        if (activeSockets === 0) void setPresence(socketUser.id, 'offline')
      }, 5_000)
      presenceDisconnectTimers.set(socketUser.id, timer)
    })
  })

  app.addHook('onClose', (_instance, done) => {
    for (const timer of presenceDisconnectTimers.values()) clearTimeout(timer)
    presenceDisconnectTimers.clear()
    done()
  })

  app.get('/health', async () => {
    const database = await pool.query('SELECT now() AS now')
    return { status: 'ok', database: database.rows[0]?.now, livekitUrl: config.livekitUrl }
  })

  app.post('/api/auth/sms/request', async (request) => {
    const body = request.body as { phone?: string }
    await requestSms(body.phone ?? '')
    return { success: true }
  })

  app.post('/api/auth/sms/verify', async (request) => {
    const body = request.body as { phone?: string; code?: string }
    return verifySms(body.phone ?? '', body.code ?? '')
  })

  app.post('/api/auth/refresh', async (request) => {
    const body = request.body as { refreshToken?: string }
    const tokens: IdpTokens = await refreshSession(body.refreshToken ?? '')
    return { tokens }
  })

  app.post('/api/auth/logout', async (request) => {
    const token = bearerToken(request.headers.authorization)
    if (token) await logoutSession(token)
    return { success: true }
  })

  app.get('/api/session', async () => {
    const result = await pool.query(
      `SELECT id, phone, email, display_name, first_name, last_name, avatar_url, timezone, locale,
              CASE WHEN presence = 'online' AND last_seen_at >= now() - interval '90 seconds'
                THEN 'online'::user_presence ELSE 'offline'::user_presence END AS status
       FROM users WHERE id = $1`,
      [currentUser.id],
    )
    return { user: result.rows[0] ? publicUser(result.rows[0]) : currentUser, authMode: 'idp-sms' }
  })

  app.get('/api/meetings', async () => {
    const result = await pool.query(
      `SELECT m.*,
         COALESCE(json_agg(json_build_object(
           'email', ma.email, 'userId', ma.user_id, 'response', ma.response
         )) FILTER (WHERE ma.email IS NOT NULL OR ma.user_id IS NOT NULL), '[]') AS attendees
       FROM meetings m
       LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
       WHERE m.host_id = $1 OR EXISTS (
         SELECT 1 FROM meeting_attendees x WHERE x.meeting_id = m.id AND x.user_id = $1
       )
       GROUP BY m.id
       ORDER BY m.starts_at`,
      [currentUser.id],
    )
    return { meetings: camelizeRows(result.rows) }
  })

  app.get<{ Params: { code: string } }>('/api/meetings/join/:code', async (request, reply) => {
    const result = await pool.query(
      `SELECT m.*,
         COALESCE(json_agg(json_build_object(
           'email', ma.email, 'userId', ma.user_id, 'response', ma.response
         )) FILTER (WHERE ma.email IS NOT NULL OR ma.user_id IS NOT NULL), '[]') AS attendees
       FROM meetings m
       LEFT JOIN meeting_attendees ma ON ma.meeting_id=m.id
       WHERE m.id::text=$1 OR lower(m.room_name)=lower($1)
       GROUP BY m.id LIMIT 1`,
      [request.params.code.trim()],
    )
    if (!result.rowCount) return reply.code(404).send({ message: 'Встреча с таким кодом не найдена.' })
    return { meeting: camelizeRow(result.rows[0] as Record<string, unknown>) }
  })

  app.post('/api/meetings', async (request, reply) => {
    const input = meetingInputSchema.parse(request.body)
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      return reply.code(400).send({ error: 'ends_before_start' })
    }

    const meeting = await inTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO meetings (
          host_id, title, description, room_name, starts_at, ends_at, timezone,
          waiting_room, mute_on_entry, allow_join_before_host
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          currentUser.id,
          input.title,
          input.description,
          `aleph-${nanoid(12)}`,
          input.startsAt,
          input.endsAt,
          input.timezone,
          input.waitingRoom,
          input.muteOnEntry,
          input.allowJoinBeforeHost,
        ],
      )
      const row = result.rows[0] as Record<string, unknown>
      for (const email of new Set(input.attendees.map((value) => value.toLowerCase()))) {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, user_id, email)
           SELECT $1::uuid, id, $2 FROM users WHERE lower(email) = $2
           UNION ALL SELECT $1::uuid, NULL, $2 WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = $2)
           ON CONFLICT DO NOTHING`,
          [row.id, email],
        )
      }
      for (const userId of new Set(input.attendeeUserIds)) {
        await client.query(
          `INSERT INTO meeting_attendees (meeting_id, user_id, email)
           SELECT $1::uuid, id, email FROM users WHERE id = $2
           ON CONFLICT DO NOTHING`,
          [row.id, userId],
        )
      }
      return camelizeRow(row)
    })
    return reply.code(201).send({ meeting })
  })

  app.patch<{ Params: IdParams }>('/api/meetings/:id/status', async (request, reply) => {
    const body = request.body as { status?: string }
    if (!body.status || !['scheduled', 'live', 'ended', 'cancelled'].includes(body.status)) {
      return reply.code(400).send({ error: 'invalid_status' })
    }
    const result = await pool.query(
      `UPDATE meetings SET status = $1 WHERE id = $2 AND host_id = $3 RETURNING *`,
      [body.status, request.params.id, currentUser.id],
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'meeting_not_found' })
    return { meeting: camelizeRow(result.rows[0] as Record<string, unknown>) }
  })

  app.post<{ Params: IdParams }>('/api/meetings/:id/token', async (request, reply) => {
    const result = await pool.query('SELECT * FROM meetings WHERE id = $1', [request.params.id])
    const meeting = result.rows[0] as Record<string, unknown> | undefined
    if (!meeting) return reply.code(404).send({ error: 'meeting_not_found' })

    const isHost = meeting.host_id === currentUser.id
    const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
      identity: currentUser.id,
      name: currentUser.displayName,
      metadata: JSON.stringify({ isHost, email: currentUser.email }),
      ttl: '6h',
    })
    token.addGrant({
      room: meeting.room_name as string,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: isHost,
    })
    return {
      token: await token.toJwt(),
      serverUrl: config.livekitUrl,
      roomName: meeting.room_name,
      isHost,
    }
  })

  app.get('/api/contacts', async () => {
    const result = await pool.query(
      `SELECT u.id, u.phone, u.email, u.display_name, u.first_name, u.last_name, u.avatar_url,
              CASE WHEN u.presence = 'online' AND u.last_seen_at >= now() - interval '90 seconds'
                THEN 'online'::user_presence ELSE 'offline'::user_presence END AS status,
              c.alias, c.created_at
       FROM contacts c JOIN users u ON u.id = c.contact_user_id
       WHERE c.owner_id = $1 ORDER BY u.display_name`,
      [currentUser.id],
    )
    return { contacts: camelizeRows(result.rows) }
  })

  app.post('/api/contacts', async (request, reply) => {
    const input = contactInputSchema.parse(request.body)
    const contactUser = await findIdpContact(input.email)
    if (contactUser.id === currentUser.id) {
      return reply.code(400).send({ error: 'cannot_add_self', message: 'Нельзя добавить себя в контакты.' })
    }
    const result = await pool.query(
      `INSERT INTO contacts (owner_id, contact_user_id, alias)
       VALUES ($1,$2,$3)
       ON CONFLICT (owner_id, contact_user_id)
       DO UPDATE SET alias = EXCLUDED.alias
       RETURNING *`,
      [currentUser.id, contactUser.id, input.alias ?? null],
    )
    return reply.code(201).send({ contact: camelizeRow(result.rows[0] as Record<string, unknown>) })
  })

  app.get('/api/conversations', async () => {
    const result = await pool.query(
      `SELECT c.id, c.kind,
          COALESCE(c.title, max(u.display_name) FILTER (WHERE u.id <> $1)) AS title,
          c.avatar_url, c.updated_at, self_member.role AS current_user_role,
          COALESCE(json_agg(json_build_object(
            'id', u.id, 'displayName', u.display_name, 'email', u.email, 'phone', u.phone,
            'avatarUrl', u.avatar_url,
            'status', CASE WHEN u.presence = 'online' AND u.last_seen_at >= now() - interval '90 seconds'
              THEN 'online' ELSE 'offline' END,
            'role', member.role
          ) ORDER BY u.display_name), '[]') AS members,
          (SELECT json_build_object(
            'id', m.id, 'body', m.body, 'kind', m.kind, 'createdAt', m.created_at,
            'senderId', m.sender_id
           ) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
             ORDER BY m.created_at DESC LIMIT 1) AS last_message,
          (SELECT count(*)::int FROM messages unread
           WHERE unread.conversation_id = c.id
             AND unread.sender_id IS DISTINCT FROM $1
             AND unread.created_at > COALESCE(self_member.last_read_at, 'epoch')) AS unread_count
       FROM conversations c
       JOIN conversation_members self_member ON self_member.conversation_id = c.id AND self_member.user_id = $1
       JOIN conversation_members member ON member.conversation_id = c.id
       JOIN users u ON u.id = member.user_id
       GROUP BY c.id, self_member.last_read_at, self_member.role
       ORDER BY c.updated_at DESC`,
      [currentUser.id],
    )
    return { conversations: camelizeRows(result.rows) }
  })

  app.post('/api/conversations', async (request, reply) => {
    const input = conversationInputSchema.parse(request.body)
    const memberIds = [...new Set([currentUser.id, ...input.memberIds])]
    const kind = memberIds.length === 2 && !input.title ? 'direct' : 'group'
    if (kind === 'direct') {
      const otherUserId = memberIds.find((id) => id !== currentUser.id)
      const existing = await pool.query(
        `SELECT conversation.* FROM conversations conversation
         WHERE conversation.kind = 'direct'
           AND EXISTS (
             SELECT 1 FROM conversation_members member
             WHERE member.conversation_id = conversation.id AND member.user_id = $1
           )
           AND EXISTS (
             SELECT 1 FROM conversation_members member
             WHERE member.conversation_id = conversation.id AND member.user_id = $2
           )
           AND (SELECT count(*) FROM conversation_members member
                WHERE member.conversation_id = conversation.id) = 2
         LIMIT 1`,
        [currentUser.id, otherUserId],
      )
      if (existing.rowCount) {
        return { conversation: camelizeRow(existing.rows[0] as Record<string, unknown>) }
      }
    }
    const conversation = await inTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO conversations (kind, title, created_by) VALUES ($1,$2,$3) RETURNING *`,
        [kind, input.title ?? null, currentUser.id],
      )
      const row = created.rows[0] as Record<string, unknown>
      for (const memberId of memberIds) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1,$2,$3)`,
          [row.id, memberId, memberId === currentUser.id ? 'owner' : 'member'],
        )
      }
      return camelizeRow(row)
    })
    await emitConversationUpdated(String(conversation.id))
    return reply.code(201).send({ conversation })
  })

  app.patch<{ Params: IdParams }>('/api/conversations/:id', async (request, reply) => {
    const input = conversationTitleSchema.parse(request.body)
    const result = await pool.query(
      `UPDATE conversations conversation SET title = $1
       WHERE conversation.id = $2 AND conversation.kind = 'group'
         AND EXISTS (
           SELECT 1 FROM conversation_members owner
           WHERE owner.conversation_id = conversation.id
             AND owner.user_id = $3 AND owner.role = 'owner'
         )
       RETURNING *`,
      [input.title, request.params.id, currentUser.id],
    )
    if (!result.rowCount) return reply.code(403).send({ error: 'group_owner_required' })
    await emitConversationUpdated(request.params.id)
    return { conversation: camelizeRow(result.rows[0] as Record<string, unknown>) }
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/members', async (request, reply) => {
    const input = conversationMembersSchema.parse(request.body)
    const owner = await pool.query(
      `SELECT 1 FROM conversation_members member
       JOIN conversations conversation ON conversation.id = member.conversation_id
       WHERE member.conversation_id = $1 AND member.user_id = $2
         AND member.role = 'owner' AND conversation.kind = 'group'`,
      [request.params.id, currentUser.id],
    )
    if (!owner.rowCount) return reply.code(403).send({ error: 'group_owner_required' })
    let added = 0
    for (const memberId of new Set(input.memberIds)) {
      const result = await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         SELECT $1, id, 'member' FROM users WHERE id = $2
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [request.params.id, memberId],
      )
      added += result.rowCount ?? 0
    }
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
    await emitConversationUpdated(request.params.id)
    return { success: true, added }
  })

  app.delete<{ Params: { id: string; userId: string } }>('/api/conversations/:id/members/:userId', async (request, reply) => {
    const owner = await pool.query(
      `SELECT 1 FROM conversation_members member
       JOIN conversations conversation ON conversation.id = member.conversation_id
       WHERE member.conversation_id = $1 AND member.user_id = $2
         AND member.role = 'owner' AND conversation.kind = 'group'`,
      [request.params.id, currentUser.id],
    )
    if (!owner.rowCount) return reply.code(403).send({ error: 'group_owner_required' })
    const removed = await pool.query(
      `DELETE FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING user_id`,
      [request.params.id, request.params.userId],
    )
    if (!removed.rowCount) return reply.code(404).send({ error: 'member_not_found' })
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
    await emitConversationUpdated(request.params.id, [request.params.userId])
    return { success: true }
  })

  app.get<{ Params: IdParams }>('/api/conversations/:id/messages', async (request, reply) => {
    const membership = await pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [request.params.id, currentUser.id],
    )
    if (!membership.rowCount) return reply.code(404).send({ error: 'conversation_not_found' })
    const result = await pool.query(
      `SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar_url,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM conversation_members recipient
          WHERE recipient.conversation_id = m.conversation_id
            AND recipient.user_id IS DISTINCT FROM m.sender_id
            AND COALESCE(recipient.last_read_at, 'epoch') < m.created_at
        ) THEN 'read' ELSE 'delivered' END AS delivery_status,
        COALESCE(json_agg(json_build_object(
          'id', a.id, 'originalName', a.original_name, 'mimeType', a.mime_type,
          'byteSize', a.byte_size, 'durationMs', a.duration_ms,
          'url', $2 || '/uploads/' || a.storage_name
        )) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN attachments a ON a.message_id = m.id
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
       GROUP BY m.id, u.display_name, u.avatar_url
       ORDER BY m.created_at`,
      [request.params.id, config.apiUrl],
    )
    const read = await pool.query(
      `UPDATE conversation_members member SET last_read_at = latest.created_at
       FROM (
         SELECT max(created_at) AS created_at FROM messages
         WHERE conversation_id = $1 AND sender_id IS DISTINCT FROM $2 AND deleted_at IS NULL
       ) latest
       WHERE member.conversation_id = $1 AND member.user_id = $2
         AND latest.created_at IS NOT NULL
         AND COALESCE(member.last_read_at, 'epoch') < latest.created_at
       RETURNING member.last_read_at`,
      [request.params.id, currentUser.id],
    )
    if (read.rows[0]) {
      await emitToConversationMembers(request.params.id, 'conversation:read', {
        conversationId: request.params.id,
        userId: currentUser.id,
        readAt: read.rows[0].last_read_at,
      })
    }
    return { messages: camelizeRows(result.rows) }
  })

  app.patch<{ Params: IdParams }>('/api/conversations/:id/read', async (request, reply) => {
    const result = await pool.query(
      `UPDATE conversation_members member SET last_read_at = latest.created_at
       FROM (
         SELECT max(created_at) AS created_at FROM messages
         WHERE conversation_id = $1 AND sender_id IS DISTINCT FROM $2 AND deleted_at IS NULL
       ) latest
       WHERE member.conversation_id = $1 AND member.user_id = $2
         AND latest.created_at IS NOT NULL
         AND COALESCE(member.last_read_at, 'epoch') < latest.created_at
       RETURNING member.conversation_id, member.last_read_at`,
      [request.params.id, currentUser.id],
    )
    if (result.rows[0]) {
      await emitToConversationMembers(request.params.id, 'conversation:read', {
        conversationId: request.params.id,
        userId: currentUser.id,
        readAt: result.rows[0].last_read_at,
      })
    } else {
      const membership = await pool.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [request.params.id, currentUser.id],
      )
      if (!membership.rowCount) return reply.code(404).send({ error: 'conversation_not_found' })
    }
    return { success: true }
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/messages', async (request, reply) => {
    const input = messageInputSchema.parse(request.body)
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body, reply_to_id)
       SELECT $1,$2,$3,$4 WHERE EXISTS (
         SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2
       ) RETURNING *`,
      [request.params.id, currentUser.id, input.body, input.replyToId ?? null],
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'conversation_not_found' })
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
    const message = {
      ...camelizeRow(result.rows[0] as Record<string, unknown>),
      senderName: currentUser.displayName,
      senderAvatarUrl: currentUser.avatarUrl,
      deliveryStatus: 'delivered',
      attachments: [],
    }
    await emitMessageToMembers(request.params.id, message)
    return reply.code(201).send({ message })
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/calls', async (request, reply) => {
    const input = callLogStartSchema.parse(request.body)
    const allowed = await pool.query(
      `SELECT 1 FROM conversations conversation
       JOIN conversation_members caller
         ON caller.conversation_id = conversation.id AND caller.user_id = $2
       JOIN conversation_members recipient
         ON recipient.conversation_id = conversation.id AND recipient.user_id <> $2
       JOIN meetings meeting ON meeting.id = $3 AND meeting.host_id = $2
       JOIN meeting_attendees attendee
         ON attendee.meeting_id = meeting.id AND attendee.user_id = recipient.user_id
       WHERE conversation.id = $1 AND conversation.kind = 'direct'`,
      [request.params.id, currentUser.id, input.meetingId],
    )
    if (!allowed.rowCount) return reply.code(403).send({ error: 'call_log_not_allowed' })
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, kind, body, metadata)
       VALUES ($1,$2,'system','Звонок',jsonb_build_object(
         'type','call','meetingId',$3::text,'status','started','startedAt',now()
       )) RETURNING *`,
      [request.params.id, currentUser.id, input.meetingId],
    )
    await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
    const message = {
      ...camelizeRow(result.rows[0] as Record<string, unknown>),
      senderName: currentUser.displayName,
      senderAvatarUrl: currentUser.avatarUrl,
      deliveryStatus: 'delivered',
      attachments: [],
    }
    await emitMessageToMembers(request.params.id, message)
    return reply.code(201).send({ message })
  })

  app.patch<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId', async (request, reply) => {
    const input = callLogFinishSchema.parse(request.body)
    const body = callSummary(input.status, input.durationMs)
    const result = await pool.query(
      `UPDATE messages message SET
         body = $4,
         metadata = message.metadata || jsonb_build_object(
           'status',$3::text,'durationMs',$5::int,'endedAt',now()
         ),
         edited_at = now()
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $6
         )
       RETURNING *`,
      [request.params.id, request.params.messageId, input.status, body, input.durationMs, currentUser.id],
    )
    if (!result.rowCount) return reply.code(404).send({ error: 'call_log_not_found' })
    const message = {
      ...camelizeRow(result.rows[0] as Record<string, unknown>),
      deliveryStatus: 'delivered',
      attachments: [],
    }
    await emitToConversationMembers(request.params.id, 'message:updated', message)
    return { message }
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/attachments', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'file_required' })
    const query = request.query as { kind?: string; durationMs?: string }
    const kind = query.kind === 'audio' ? 'audio' : 'file'
    const safeExtension = extname(data.filename).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12)
    const storageName = `${randomUUID()}${safeExtension}`
    const filePath = join(config.uploadDir, storageName)
    await pipeline(data.file, createWriteStream(filePath))

    const message = await inTransaction(async (client) => {
      const membership = await client.query(
        'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [request.params.id, currentUser.id],
      )
      if (!membership.rowCount) throw Object.assign(new Error('Conversation not found'), { statusCode: 404 })
      const created = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, kind) VALUES ($1,$2,$3) RETURNING *`,
        [request.params.id, currentUser.id, kind],
      )
      const row = created.rows[0] as Record<string, unknown>
      const attachment = await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms
        ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          row.id,
          currentUser.id,
          data.filename,
          storageName,
          data.mimetype,
          data.file.bytesRead,
          query.durationMs ? Number(query.durationMs) : null,
        ],
      )
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      return {
        ...camelizeRow(row),
        senderName: currentUser.displayName,
        senderAvatarUrl: currentUser.avatarUrl,
        deliveryStatus: 'delivered',
        attachments: [
          {
            ...camelizeRow(attachment.rows[0] as Record<string, unknown>),
            url: `${config.apiUrl}/uploads/${storageName}`,
          },
        ],
      }
    })
    await emitMessageToMembers(request.params.id, message)
    return reply.code(201).send({ message })
  })

  app.get('/api/calendar/outlook/status', async (_request, reply) => {
    return reply.code(410).send({
      provider: 'exchange_ews',
      available: false,
      message: 'Локальная Outlook COM-интеграция отключена. Настройте удаленный Exchange / OWA.',
    })
  })

  app.post('/api/calendar/outlook/sync', async (_request, reply) => {
    return reply.code(410).send({
      error: 'exchange_settings_required',
      message: 'Локальная Outlook COM-интеграция отключена. Настройте удаленный Exchange / OWA.',
    })
    /* c8 ignore start -- legacy implementation retained until the next schema cleanup */
    const from = new Date()
    from.setMonth(from.getMonth() - 1)
    const to = new Date()
    to.setFullYear(to.getFullYear() + 1)

    const accountResult = await pool.query(
      `INSERT INTO calendar_accounts (user_id, provider, external_account_id, display_name)
       SELECT $1, 'outlook_com', 'default', 'Outlook 2016'
       WHERE NOT EXISTS (
         SELECT 1 FROM calendar_accounts WHERE user_id = $1 AND provider = 'outlook_com'
       ) RETURNING id`,
      [currentUser.id],
    )
    const account = accountResult.rows[0] ?? (
      await pool.query(
        `SELECT id FROM calendar_accounts WHERE user_id = $1 AND provider = 'outlook_com' LIMIT 1`,
        [currentUser.id],
      )
    ).rows[0]
    const accountId = account.id as string
    const outlookEvents = await listOutlookEvents(from, to)
    let imported = 0
    let exported = 0

    for (const event of outlookEvents) {
      const linked = await pool.query(
        `SELECT meeting_id FROM calendar_event_links
         WHERE account_id = $1 AND external_event_id = $2`,
        [accountId, event.externalEventId],
      )
      if (linked.rowCount) {
        await pool.query(
          `UPDATE meetings SET title=$1, description=$2, starts_at=$3, ends_at=$4
           WHERE id=$5 AND host_id=$6`,
          [event.subject, event.body, event.startsAt, event.endsAt, linked.rows[0].meeting_id, currentUser.id],
        )
      } else {
        const created = await pool.query(
          `INSERT INTO meetings (
            host_id, title, description, room_name, starts_at, ends_at, timezone
           ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [
            currentUser.id,
            event.subject || 'Встреча Outlook',
            event.body,
            `outlook-${nanoid(12)}`,
            event.startsAt,
            event.endsAt,
            currentUser.timezone,
          ],
        )
        await pool.query(
          `INSERT INTO calendar_event_links (account_id, meeting_id, external_event_id)
           VALUES ($1,$2,$3)`,
          [accountId, created.rows[0].id, event.externalEventId],
        )
        imported += 1
      }
    }

    const localMeetings = await pool.query(
      `SELECT m.*,
        (SELECT external_event_id FROM calendar_event_links l
         WHERE l.account_id=$2 AND l.meeting_id=m.id) AS external_event_id,
        COALESCE((SELECT json_agg(email) FROM meeting_attendees a WHERE a.meeting_id=m.id), '[]') AS attendees
       FROM meetings m
       WHERE m.host_id=$1 AND m.starts_at >= $3 AND m.starts_at < $4 AND m.status <> 'cancelled'`,
      [currentUser.id, accountId, from, to],
    )
    for (const meeting of localMeetings.rows) {
      const event = await upsertOutlookEvent({
        externalEventId: meeting.external_event_id ?? undefined,
        subject: meeting.title,
        body: meeting.description ?? '',
        location: `AlephMeets: ${meeting.room_name}`,
        startsAt: new Date(meeting.starts_at).toISOString(),
        endsAt: new Date(meeting.ends_at).toISOString(),
        attendees: meeting.attendees,
      })
      await pool.query(
        `INSERT INTO calendar_event_links (account_id, meeting_id, external_event_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (account_id, meeting_id)
         DO UPDATE SET external_event_id=EXCLUDED.external_event_id, last_synced_at=now()`,
        [accountId, meeting.id, event.externalEventId],
      )
      if (!meeting.external_event_id) exported += 1
    }
    await pool.query('UPDATE calendar_accounts SET last_synced_at=now() WHERE id=$1', [accountId])
    return { imported, exported, total: localMeetings.rowCount, syncedAt: new Date().toISOString() }
    /* c8 ignore stop */
  })

  app.get('/api/calendar/exchange/settings', async () => {
    const result = await pool.query(
      `SELECT id, server_url, email, username, domain, auth_method, verify_tls,
              sync_enabled, last_synced_at, last_sync_error
       FROM calendar_accounts
       WHERE user_id=$1 AND provider='exchange_ews'
       ORDER BY created_at DESC LIMIT 1`,
      [currentUser.id],
    )
    const account = result.rows[0] as Record<string, unknown> | undefined
    return account
      ? { configured: true, settings: camelizeRow(account) }
      : { configured: false, settings: null }
  })

  app.post('/api/calendar/exchange/settings', async (request) => {
    const input = exchangeSettingsSchema.parse(request.body)
    const existing = await pool.query(
      `SELECT encrypted_secret, email FROM calendar_accounts
       WHERE user_id=$1 AND provider='exchange_ews' ORDER BY created_at DESC LIMIT 1`,
      [currentUser.id],
    )
    const existingRow = existing.rows[0] as { encrypted_secret: string; email: string } | undefined
    const encryptedSecret = input.password
      ? encryptCredential(input.password)
      : existingRow?.email.toLowerCase() === input.email.toLowerCase()
        ? existingRow.encrypted_secret
        : null
    if (!encryptedSecret) {
      throw Object.assign(new Error('Введите пароль Exchange.'), { statusCode: 400 })
    }
    const serverUrl = normalizeEwsUrl(input.serverUrl)
    const credentials: ExchangeCredentials = {
      serverUrl,
      email: input.email,
      username: input.username,
      password: input.password ?? decryptCredential(encryptedSecret),
      domain: input.domain,
      authMethod: input.authMethod,
      verifyTls: input.verifyTls,
    }
    await testExchangeConnection(credentials)
    const result = await pool.query(
      `INSERT INTO calendar_accounts (
         user_id, provider, external_account_id, display_name, server_url, email,
         username, domain, auth_method, encrypted_secret, verify_tls, sync_enabled,
         last_sync_error
       ) VALUES ($1,'exchange_ews',$2,$3,$4,$2,$5,$6,$7,$8,$9,true,NULL)
       ON CONFLICT (user_id, provider, external_account_id)
       DO UPDATE SET display_name=EXCLUDED.display_name, server_url=EXCLUDED.server_url,
         username=EXCLUDED.username, domain=EXCLUDED.domain,
         auth_method=EXCLUDED.auth_method, encrypted_secret=EXCLUDED.encrypted_secret,
         verify_tls=EXCLUDED.verify_tls, sync_enabled=true, last_sync_error=NULL
       RETURNING id, server_url, email, username, domain, auth_method, verify_tls,
                 sync_enabled, last_synced_at, last_sync_error`,
      [
        currentUser.id,
        input.email.toLowerCase(),
        `Exchange · ${input.email}`,
        serverUrl,
        input.username,
        input.domain || null,
        input.authMethod,
        encryptedSecret,
        input.verifyTls,
      ],
    )
    return { configured: true, settings: camelizeRow(result.rows[0] as Record<string, unknown>) }
  })

  app.post('/api/calendar/exchange/test', async (request) => {
    const input = exchangeSettingsSchema.parse(request.body)
    if (!input.password) {
      throw Object.assign(new Error('Введите пароль Exchange.'), { statusCode: 400 })
    }
    const ewsUrl = normalizeEwsUrl(input.serverUrl)
    await testExchangeConnection({ ...input, serverUrl: ewsUrl, password: input.password })
    return { success: true, ewsUrl }
  })

  app.post('/api/calendar/exchange/sync', async () => {
    const accountResult = await pool.query(
      `SELECT * FROM calendar_accounts
       WHERE user_id=$1 AND provider='exchange_ews' AND sync_enabled=true
       ORDER BY created_at DESC LIMIT 1`,
      [currentUser.id],
    )
    const account = accountResult.rows[0] as ExchangeAccountRow | undefined
    if (!account) {
      throw Object.assign(
        new Error('Сначала настройте подключение Exchange в настройках календаря.'),
        { statusCode: 409 },
      )
    }
    const credentials = exchangeCredentials(account)
    const from = new Date()
    from.setMonth(from.getMonth() - 1)
    const to = new Date()
    to.setFullYear(to.getFullYear() + 1)
    let imported = 0
    let exported = 0
    try {
      const remoteEvents = await listExchangeEvents(credentials, from, to)
      for (const event of remoteEvents) {
        const linked = await pool.query(
          `SELECT meeting_id FROM calendar_event_links
           WHERE account_id=$1 AND external_event_id=$2`,
          [account.id, event.externalEventId],
        )
        if (linked.rowCount) {
          await pool.query(
            `UPDATE meetings SET title=$1, description=$2, starts_at=$3, ends_at=$4
             WHERE id=$5 AND host_id=$6`,
            [event.subject, event.body, event.startsAt, event.endsAt, linked.rows[0].meeting_id, currentUser.id],
          )
        } else {
          const created = await pool.query(
            `INSERT INTO meetings (
               host_id, title, description, room_name, starts_at, ends_at, timezone, status
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled') RETURNING id`,
            [
              currentUser.id,
              event.subject || 'Встреча Exchange',
              event.body,
              `exchange-${nanoid(12)}`,
              event.startsAt,
              event.endsAt,
              currentUser.timezone,
            ],
          )
          await pool.query(
            `INSERT INTO calendar_event_links (
               account_id, meeting_id, external_event_id, external_change_key
             ) VALUES ($1,$2,$3,$4)`,
            [account.id, created.rows[0].id, event.externalEventId, event.changeKey ?? null],
          )
          imported += 1
        }
      }

      const localMeetings = await pool.query(
        `SELECT m.*,
          (SELECT external_event_id FROM calendar_event_links l
           WHERE l.account_id=$2 AND l.meeting_id=m.id) AS external_event_id,
          COALESCE((SELECT json_agg(email) FROM meeting_attendees a WHERE a.meeting_id=m.id), '[]') AS attendees
         FROM meetings m
         WHERE m.host_id=$1 AND m.starts_at >= $3 AND m.starts_at < $4
           AND m.status='scheduled'`,
        [currentUser.id, account.id, from, to],
      )
      for (const meeting of localMeetings.rows) {
        if (meeting.external_event_id) continue
        const event = await createExchangeEvent(credentials, {
          subject: meeting.title,
          body: meeting.description ?? '',
          location: `AlephMeets: ${meeting.room_name}`,
          startsAt: new Date(meeting.starts_at).toISOString(),
          endsAt: new Date(meeting.ends_at).toISOString(),
          attendees: meeting.attendees,
        })
        await pool.query(
          `INSERT INTO calendar_event_links (
             account_id, meeting_id, external_event_id, external_change_key
           ) VALUES ($1,$2,$3,$4)`,
          [account.id, meeting.id, event.externalEventId, event.changeKey ?? null],
        )
        exported += 1
      }
      await pool.query(
        'UPDATE calendar_accounts SET last_synced_at=now(), last_sync_error=NULL WHERE id=$1',
        [account.id],
      )
      return { imported, exported, total: localMeetings.rowCount, syncedAt: new Date().toISOString() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await pool.query('UPDATE calendar_accounts SET last_sync_error=$1 WHERE id=$2', [message, account.id])
      throw error
    }
  })

  return app
}
