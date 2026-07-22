import { existsSync, mkdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk'
import { nanoid } from 'nanoid'
import type { PoolClient } from 'pg'
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
  deleteExchangeEvent,
  type ExchangeEvent,
  type ExchangeEventInput,
  type ExchangeCredentials,
  listExchangeEvents,
  normalizeEwsUrl,
  testExchangeConnection,
  updateExchangeEvent,
} from './exchange.js'
import {
  callLogFinishSchema,
  callLogStartSchema,
  contactInputSchema,
  conversationInputSchema,
  conversationMembersSchema,
  conversationTitleSchema,
  exchangeSettingsSchema,
  meetingHostTransferSchema,
  meetingInvitationSchema,
  meetingInputSchema,
  messageInputSchema,
} from './schemas.js'
import { camelizeRow, camelizeRows } from './serializers.js'
import { createAlephaConspect } from './alepha.js'
import {
  attachmentStorageName,
  buildStorageScope,
  recordingStorageName,
  uploadStreamToS3,
} from './storage.js'
import {
  authenticateAccessToken,
  findIdpContact,
  type IdpTokens,
  logoutSession,
  refreshSession,
  requestSms,
  syncAdContactsForUser,
  verifySms,
} from './idp.js'
import { sendMeetingMaterialsEmail, type MeetingMaterialLink } from './mail.js'

interface IdParams {
  id: string
}

interface AppDependencies {
  authenticate?: (accessToken: string) => Promise<CurrentUser>
  roomService?: Pick<RoomServiceClient, 'deleteRoom' | 'listParticipants' | 'listRooms'>
}

interface ExchangeAccountRow {
  id: string
  user_id: string
  server_url: string
  email: string
  username: string
  domain: string | null
  auth_method: 'basic' | 'ntlm'
  encrypted_secret: string
  verify_tls: boolean
}

interface ExchangeSyncResult {
  imported: number
  exported: number
  total: number
  syncedAt: string
}

interface ScheduledExchangeAccountRow extends ExchangeAccountRow {
  timezone: string
}

type RecurrenceRule = 'none' | 'daily' | 'weekly' | 'monthly'

export const EXCHANGE_SYNC_INTERVAL_MS = 5 * 60 * 1000

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

function normalizeEmailList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((email) => String(email ?? '').trim().toLowerCase()).filter(Boolean))]
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      return normalizeEmailList(JSON.parse(trimmed))
    } catch {
      return [trimmed.toLowerCase()]
    }
  }
  return []
}

function exchangeEventAttendeesForAccount(account: ExchangeAccountRow, event: ExchangeEvent): string[] {
  const accountEmail = account.email.trim().toLowerCase()
  const organizerEmail = event.organizer?.trim().toLowerCase()
  return [...new Set([
    ...event.attendees.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ...(organizerEmail && organizerEmail !== accountEmail ? [accountEmail] : []),
  ])]
}

function shiftRecurrenceDate(date: Date, rule: Exclude<RecurrenceRule, 'none'>, index: number): Date {
  const shifted = new Date(date)
  if (rule === 'daily') shifted.setDate(shifted.getDate() + index)
  if (rule === 'weekly') shifted.setDate(shifted.getDate() + index * 7)
  if (rule === 'monthly') shifted.setMonth(shifted.getMonth() + index)
  return shifted
}

function buildMeetingOccurrences(
  startsAt: string,
  endsAt: string,
  recurrenceRule: RecurrenceRule,
  recurrenceCount: number,
): Array<{ startsAt: string; endsAt: string; recurrenceRule: Exclude<RecurrenceRule, 'none'> | null }> {
  if (recurrenceRule === 'none') {
    return [{ startsAt, endsAt, recurrenceRule: null }]
  }
  const start = new Date(startsAt)
  const end = new Date(endsAt)
  return Array.from({ length: recurrenceCount }, (_unused, index) => ({
    startsAt: shiftRecurrenceDate(start, recurrenceRule, index).toISOString(),
    endsAt: shiftRecurrenceDate(end, recurrenceRule, index).toISOString(),
    recurrenceRule,
  }))
}

async function insertMeetingAttendees(
  client: PoolClient,
  meetingId: string,
  attendees: string[],
  attendeeUserIds: string[],
): Promise<void> {
  for (const email of new Set(attendees.map((value) => value.toLowerCase()))) {
    await client.query(
      `INSERT INTO meeting_attendees (meeting_id, user_id, email)
       SELECT $1::uuid, id, $2 FROM users WHERE lower(email) = $2
       UNION ALL SELECT $1::uuid, NULL, $2 WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = $2)
       ON CONFLICT DO NOTHING`,
      [meetingId, email],
    )
  }
  for (const userId of new Set(attendeeUserIds)) {
    await client.query(
      `INSERT INTO meeting_attendees (meeting_id, user_id, email)
       SELECT $1::uuid, id, email FROM users WHERE id = $2
       ON CONFLICT DO NOTHING`,
      [meetingId, userId],
    )
  }
}

async function syncMeetingAttendeesFromEmails(meetingId: string, attendees: readonly string[]): Promise<void> {
  const emails = [...new Set(attendees.map((email) => email.trim().toLowerCase()).filter(Boolean))]
  await pool.query(
    `DELETE FROM meeting_attendees ma
     WHERE ma.meeting_id=$1
       AND NOT (
         (ma.email IS NOT NULL AND lower(ma.email) = ANY($2::text[]))
         OR EXISTS (
           SELECT 1 FROM users u
           WHERE u.id=ma.user_id AND u.email IS NOT NULL AND lower(u.email) = ANY($2::text[])
         )
       )`,
    [meetingId, emails],
  )
  if (!emails.length) return
  await pool.query(
    `UPDATE meeting_attendees ma
     SET user_id=u.id, email=u.email
     FROM users u
     WHERE ma.meeting_id=$1
       AND ma.user_id IS NULL
       AND ma.email IS NOT NULL
       AND u.email IS NOT NULL
       AND lower(ma.email)=lower(u.email)
       AND lower(u.email) = ANY($2::text[])
       AND NOT EXISTS (
         SELECT 1 FROM meeting_attendees linked
         WHERE linked.meeting_id=ma.meeting_id AND linked.user_id=u.id
       )`,
    [meetingId, emails],
  )
  await pool.query(
    `INSERT INTO meeting_attendees (meeting_id, user_id, email, response)
     SELECT $1::uuid, u.id, u.email, 'invited'
     FROM users u
     WHERE u.email IS NOT NULL AND lower(u.email) = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [meetingId, emails],
  )
  await pool.query(
    `DELETE FROM meeting_attendees ma
     USING users u
     WHERE ma.meeting_id=$1
       AND ma.user_id IS NULL
       AND ma.email IS NOT NULL
       AND u.email IS NOT NULL
       AND lower(ma.email)=lower(u.email)
       AND EXISTS (
         SELECT 1 FROM meeting_attendees linked
         WHERE linked.meeting_id=ma.meeting_id AND linked.user_id=u.id
       )`,
    [meetingId],
  )
  for (const email of emails) {
    await pool.query(
      `INSERT INTO meeting_attendees (meeting_id, user_id, email, response)
       SELECT $1::uuid, NULL, $2, 'invited'
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE email IS NOT NULL AND lower(email)=$2)
       ON CONFLICT DO NOTHING`,
      [meetingId, email],
    )
  }
}

function isExchangeError(error: unknown, code: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(code)
}

async function createExchangeEventWithFallback(
  credentials: ExchangeCredentials,
  event: ExchangeEventInput,
): Promise<{ externalEventId: string; changeKey?: string }> {
  try {
    return await createExchangeEvent(credentials, event)
  } catch (error) {
    if (!isExchangeError(error, 'ErrorInvalidPropertySet')) throw error
    return createExchangeEvent(credentials, { ...event, attendees: [] })
  }
}

async function updateExchangeEventWithFallback(
  credentials: ExchangeCredentials,
  externalEventId: string,
  changeKey: string | undefined,
  event: ExchangeEventInput,
): Promise<{ externalEventId: string; changeKey?: string }> {
  try {
    return await updateExchangeEvent(credentials, externalEventId, changeKey, event)
  } catch (error) {
    if (!isExchangeError(error, 'ErrorInvalidPropertySet')) throw error
    const eventWithoutAttendees = { ...event }
    delete eventWithoutAttendees.attendees
    return updateExchangeEvent(credentials, externalEventId, changeKey, eventWithoutAttendees)
  }
}

async function applyExchangeEventToMeeting(
  account: ExchangeAccountRow,
  user: Pick<CurrentUser, 'id'>,
  meetingId: string,
  event: ExchangeEvent,
): Promise<void> {
  const organizerEmail = event.organizer?.trim().toLowerCase() || account.email.trim().toLowerCase()
  await pool.query(
    `UPDATE meetings
     SET title=$1, description=$2, starts_at=$3, ends_at=$4,
         owner_email=$5, owner_display_name=$6
     WHERE id=$7 AND host_id=$8`,
    [event.subject, event.body, event.startsAt, event.endsAt, organizerEmail, organizerEmail, meetingId, user.id],
  )
  await syncMeetingAttendeesFromEmails(meetingId, exchangeEventAttendeesForAccount(account, event))
  await pool.query(
    `UPDATE calendar_event_links
     SET external_change_key=$1, last_synced_at=now()
     WHERE account_id=$2 AND meeting_id=$3`,
    [event.changeKey ?? null, account.id, meetingId],
  )
}

async function syncExchangeCalendar(
  account: ExchangeAccountRow,
  user: Pick<CurrentUser, 'id' | 'timezone'>,
): Promise<ExchangeSyncResult> {
  const credentials = exchangeCredentials(account)
  const from = new Date()
  from.setMonth(from.getMonth() - 1)
  const to = new Date()
  to.setFullYear(to.getFullYear() + 1)
  let imported = 0
  let exported = 0

  try {
    const remoteEvents = await listExchangeEvents(credentials, from, to)
    const remoteEventById = new Map(remoteEvents.map((event) => [event.externalEventId, event]))
    const accountEmail = account.email.trim().toLowerCase()
    for (const event of remoteEvents) {
      const linked = await pool.query(
        `SELECT l.meeting_id, l.last_synced_at, m.updated_at
         FROM calendar_event_links l
         JOIN meetings m ON m.id=l.meeting_id
         WHERE account_id=$1 AND external_event_id=$2`,
        [account.id, event.externalEventId],
      )
      if (linked.rowCount) {
        const linkedMeeting = linked.rows[0] as { meeting_id: string; last_synced_at: Date | string; updated_at: Date | string }
        const organizerEmail = event.organizer?.trim().toLowerCase()
        const externalOrganizer = Boolean(organizerEmail && organizerEmail !== accountEmail)
        if (new Date(linkedMeeting.updated_at) > new Date(linkedMeeting.last_synced_at) && !externalOrganizer) continue
        await applyExchangeEventToMeeting(account, user, linkedMeeting.meeting_id, event)
      } else {
        const organizerEmail = event.organizer?.trim().toLowerCase() || accountEmail
        const created = await pool.query(
          `INSERT INTO meetings (
             host_id, title, description, room_name, starts_at, ends_at, timezone,
             status, owner_email, owner_display_name
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,$9) RETURNING id`,
          [
            user.id,
            event.subject || 'Exchange meeting',
            event.body,
            `exchange-${nanoid(12)}`,
            event.startsAt,
            event.endsAt,
            user.timezone,
            organizerEmail,
            organizerEmail,
          ],
        )
        await pool.query(
          `INSERT INTO calendar_event_links (
             account_id, meeting_id, external_event_id, external_change_key
          ) VALUES ($1,$2,$3,$4)`,
          [account.id, created.rows[0].id, event.externalEventId, event.changeKey ?? null],
        )
        await syncMeetingAttendeesFromEmails(created.rows[0].id, exchangeEventAttendeesForAccount(account, event))
        imported += 1
      }
    }

    const localMeetings = await pool.query(
      `SELECT m.*,
        l.external_event_id,
        l.external_change_key,
        COALESCE((
          SELECT json_agg(DISTINCT lower(COALESCE(a.email, attendee.email)))
            FILTER (WHERE COALESCE(a.email, attendee.email) IS NOT NULL)
          FROM meeting_attendees a
          LEFT JOIN users attendee ON attendee.id=a.user_id
          WHERE a.meeting_id=m.id
        ), '[]'::json) AS attendees
       FROM meetings m
       LEFT JOIN calendar_event_links l ON l.account_id=$2 AND l.meeting_id=m.id
       WHERE m.host_id=$1 AND m.starts_at >= $3 AND m.starts_at < $4
         AND m.status='scheduled'`,
      [user.id, account.id, from, to],
    )
    for (const meeting of localMeetings.rows) {
      const linkedRemoteEvent = meeting.external_event_id
        ? remoteEventById.get(meeting.external_event_id)
        : undefined
      if (meeting.external_event_id && !linkedRemoteEvent) {
        await pool.query('DELETE FROM meetings WHERE id=$1 AND host_id=$2', [meeting.id, user.id])
        continue
      }
      const organizerEmail = linkedRemoteEvent?.organizer?.trim().toLowerCase()
      if (organizerEmail && organizerEmail !== accountEmail) continue
      const exchangeInput = {
        subject: meeting.title,
        body: meeting.description ?? '',
        location: `AlephMeets: ${meeting.room_name}`,
        startsAt: new Date(meeting.starts_at).toISOString(),
        endsAt: new Date(meeting.ends_at).toISOString(),
        attendees: normalizeEmailList(meeting.attendees),
      }
      let event: { externalEventId: string; changeKey?: string }
      if (meeting.external_event_id) {
        try {
          event = await updateExchangeEventWithFallback(
            credentials,
            meeting.external_event_id,
            meeting.external_change_key ?? undefined,
            exchangeInput,
          )
        } catch (error) {
          if (isExchangeError(error, 'ErrorIrresolvableConflict')) {
            if (!linkedRemoteEvent) throw error
            await applyExchangeEventToMeeting(account, user, meeting.id, linkedRemoteEvent)
            imported += 1
            continue
          }
          if (!isExchangeError(error, 'ErrorItemNotFound')) throw error
          await pool.query('DELETE FROM meetings WHERE id=$1 AND host_id=$2', [meeting.id, user.id])
          continue
        }
      } else {
        event = await createExchangeEventWithFallback(credentials, exchangeInput)
      }
      await pool.query(
        `INSERT INTO calendar_event_links (
           account_id, meeting_id, external_event_id, external_change_key, last_synced_at
         ) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (account_id, meeting_id)
         DO UPDATE SET external_event_id=EXCLUDED.external_event_id,
                       external_change_key=EXCLUDED.external_change_key,
                       last_synced_at=now()`,
        [account.id, meeting.id, event.externalEventId, event.changeKey ?? null],
      )
      exported += 1
    }
    const syncedAt = new Date().toISOString()
    await pool.query(
      'UPDATE calendar_accounts SET last_synced_at=$1, last_sync_error=NULL WHERE id=$2',
      [syncedAt, account.id],
    )
    return { imported, exported, total: localMeetings.rowCount ?? 0, syncedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await pool.query('UPDATE calendar_accounts SET last_sync_error=$1 WHERE id=$2', [message, account.id])
    throw error
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

function publicAttachment(row: Record<string, unknown>): Record<string, unknown> {
  const attachment = camelizeRow(row)
  const storageUrl = typeof attachment.storageUrl === 'string' ? attachment.storageUrl : ''
  const storageName = typeof attachment.storageName === 'string' ? attachment.storageName : ''
  const byteSize = Number(attachment.byteSize)
  const durationMs = attachment.durationMs === null || attachment.durationMs === undefined
    ? null
    : Number(attachment.durationMs)
  return {
    ...attachment,
    byteSize: Number.isFinite(byteSize) ? byteSize : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    url: storageUrl || `${config.apiUrl}/uploads/${storageName}`,
  }
}

export async function createApp(dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const authenticate = dependencies.authenticate ?? authenticateAccessToken
  const roomService = dependencies.roomService ?? new RoomServiceClient(
    config.livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'),
    config.livekitApiKey,
    config.livekitApiSecret,
  )
  const app = Fastify({ logger: true, bodyLimit: config.maxUploadBytes })
  const io = new SocketServer(app.server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
  })
  const presenceDisconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const meetingInvitationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const activeExchangeSyncs = new Map<string, Promise<ExchangeSyncResult>>()

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  const syncExchangeAccount = (
    account: ExchangeAccountRow,
    user: Pick<CurrentUser, 'id' | 'timezone'>,
  ): Promise<ExchangeSyncResult> => {
    const activeSync = activeExchangeSyncs.get(account.id)
    if (activeSync) return activeSync

    const sync = syncExchangeCalendar(account, user)
      .then((result) => {
        io.to(`user:${user.id}`).emit('calendar:synced', result)
        return result
      })
      .finally(() => {
        activeExchangeSyncs.delete(account.id)
      })
    activeExchangeSyncs.set(account.id, sync)
    return sync
  }

  const loadCurrentExchangeAccount = async (): Promise<ExchangeAccountRow | undefined> => {
    const accountResult = await pool.query(
      `SELECT * FROM calendar_accounts
       WHERE user_id=$1 AND provider='exchange_ews' AND sync_enabled=true
       ORDER BY created_at DESC LIMIT 1`,
      [currentUser.id],
    )
    return accountResult.rows[0] as ExchangeAccountRow | undefined
  }

  const syncCurrentExchangeAccount = async (reason: string): Promise<void> => {
    const account = await loadCurrentExchangeAccount()
    if (!account) return
    try {
      await syncExchangeAccount(account, {
        id: currentUser.id,
        timezone: currentUser.timezone,
      })
    } catch (error) {
      app.log.warn(
        { err: error, accountId: account.id, userId: currentUser.id, reason },
        'Exchange calendar sync failed',
      )
    }
  }

  const syncConfiguredExchangeAccounts = async (): Promise<void> => {
    let accounts: ScheduledExchangeAccountRow[]
    try {
      const result = await pool.query(
        `SELECT ca.*, u.timezone
         FROM calendar_accounts ca
         JOIN users u ON u.id=ca.user_id
         WHERE ca.provider='exchange_ews' AND ca.sync_enabled=true`,
      )
      accounts = result.rows as ScheduledExchangeAccountRow[]
    } catch (error) {
      app.log.error({ err: error }, 'Failed to load Exchange accounts for scheduled sync')
      return
    }

    await Promise.all(accounts.map(async (account) => {
      try {
        await syncExchangeAccount(account, { id: account.user_id, timezone: account.timezone })
      } catch (error) {
        app.log.error(
          { err: error, accountId: account.id, userId: account.user_id },
          'Scheduled Exchange calendar sync failed',
        )
      }
    }))
  }

  const exchangeSyncTimer = setInterval(() => {
    void syncConfiguredExchangeAccounts()
  }, EXCHANGE_SYNC_INTERVAL_MS)
  exchangeSyncTimer.unref()

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

  const sendCallMaterialsEmail = async (
    conversationId: string,
    messageId: string,
    meeting: { id: string; title: string; room_name: string },
  ): Promise<void> => {
    const recipientsResult = await pool.query<{ email: string }>(
      `SELECT DISTINCT lower(email) AS email FROM (
         SELECT u.email
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = $1 AND u.email IS NOT NULL
         UNION
         SELECT host.email
         FROM meetings m
         JOIN users host ON host.id = m.host_id
         WHERE m.id = $2 AND host.email IS NOT NULL
         UNION
         SELECT COALESCE(attendee_user.email, attendee.email) AS email
         FROM meeting_attendees attendee
         LEFT JOIN users attendee_user ON attendee_user.id = attendee.user_id
         WHERE attendee.meeting_id = $2
       ) recipients
       WHERE email IS NOT NULL AND email <> ''`,
      [conversationId, meeting.id],
    )
    const attachments = await pool.query(
      `SELECT original_name, mime_type, storage_url, storage_name
       FROM attachments
       WHERE message_id = $1
       ORDER BY created_at`,
      [messageId],
    )
    const materials: MeetingMaterialLink[] = attachments.rows
      .map((row) => {
        const attachment = publicAttachment(row as Record<string, unknown>)
        return {
          name: String(attachment.originalName ?? attachment.storageName ?? 'material'),
          url: String(attachment.url ?? ''),
          mimeType: typeof attachment.mimeType === 'string' ? attachment.mimeType : null,
        }
      })
      .filter((material) => material.url)

    try {
      await sendMeetingMaterialsEmail({
        recipients: recipientsResult.rows.map((row) => row.email),
        meetingTitle: meeting.title,
        meetingRoomName: meeting.room_name,
        materials,
      })
    } catch (error) {
      app.log.error({ err: error, meetingId: meeting.id, messageId }, 'Failed to send meeting materials email')
    }
  }

  const emitMeetingUpdated = async (
    meetingId: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const recipients = await pool.query(
      `SELECT host_id AS user_id FROM meetings WHERE id=$1
       UNION
       SELECT user_id FROM meeting_attendees WHERE meeting_id=$1 AND user_id IS NOT NULL`,
      [meetingId],
    )
    for (const recipient of recipients.rows) {
      io.to(`user:${String(recipient.user_id)}`).emit('meeting:updated', payload)
    }
  }

  const invitationKey = (meetingId: string, userId: string): string => `${meetingId}:${userId}`
  const clearMeetingInvitationTimer = (meetingId: string, userId: string): void => {
    const key = invitationKey(meetingId, userId)
    const timer = meetingInvitationTimers.get(key)
    if (timer) clearTimeout(timer)
    meetingInvitationTimers.delete(key)
  }
  const scheduleMeetingInvitationTimeout = (meetingId: string, userId: string): void => {
    clearMeetingInvitationTimer(meetingId, userId)
    const key = invitationKey(meetingId, userId)
    meetingInvitationTimers.set(key, setTimeout(() => {
      meetingInvitationTimers.delete(key)
      void pool.query(
        `UPDATE meeting_attendees SET response='declined'
         WHERE meeting_id=$1 AND user_id=$2 AND response='invited' RETURNING id`,
        [meetingId, userId],
      ).then(async (result) => {
        if (!result.rowCount) return
        io.to(`user:${userId}`).emit('call:cancelled', { meetingId })
        await emitMeetingUpdated(meetingId, { meetingId, invitationUserId: userId })
      }).catch((error) => app.log.error(error))
    }, 45_000))
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
      scheduleMeetingInvitationTimeout(meetingId, targetUserId)
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
    clearInterval(exchangeSyncTimer)
    for (const timer of presenceDisconnectTimers.values()) clearTimeout(timer)
    presenceDisconnectTimers.clear()
    for (const timer of meetingInvitationTimers.values()) clearTimeout(timer)
    meetingInvitationTimers.clear()
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
      `SELECT id, phone, email, display_name, first_name, last_name, department, position,
              avatar_url, timezone, locale,
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
         host.display_name AS host_display_name, host.avatar_url AS host_avatar_url,
         COALESCE(json_agg(json_build_object(
           'email', ma.email, 'userId', ma.user_id, 'response', ma.response,
           'displayName', attendee.display_name, 'department', attendee.department,
           'position', attendee.position,
           'avatarUrl', attendee.avatar_url
         )) FILTER (WHERE ma.email IS NOT NULL OR ma.user_id IS NOT NULL), '[]') AS attendees
       FROM meetings m
       JOIN users host ON host.id = m.host_id
       LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
       LEFT JOIN users attendee ON attendee.id = ma.user_id
       WHERE m.host_id = $1 OR EXISTS (
         SELECT 1 FROM meeting_attendees x WHERE x.meeting_id = m.id AND x.user_id = $1
       )
       GROUP BY m.id, host.id
       ORDER BY m.starts_at`,
      [currentUser.id],
    )
    return { meetings: camelizeRows(result.rows) }
  })

  app.get<{ Params: { code: string } }>('/api/meetings/join/:code', async (request, reply) => {
    const result = await pool.query(
      `SELECT m.*,
         host.display_name AS host_display_name, host.avatar_url AS host_avatar_url,
         COALESCE(json_agg(json_build_object(
           'email', ma.email, 'userId', ma.user_id, 'response', ma.response,
           'displayName', attendee.display_name, 'department', attendee.department,
           'position', attendee.position,
           'avatarUrl', attendee.avatar_url
         )) FILTER (WHERE ma.email IS NOT NULL OR ma.user_id IS NOT NULL), '[]') AS attendees
       FROM meetings m
       JOIN users host ON host.id = m.host_id
       LEFT JOIN meeting_attendees ma ON ma.meeting_id=m.id
       LEFT JOIN users attendee ON attendee.id = ma.user_id
       WHERE m.id::text=$1 OR lower(m.room_name)=lower($1)
       GROUP BY m.id, host.id LIMIT 1`,
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

    const recurrenceRule = input.recurrenceRule ?? 'none'
    const recurrenceCount = recurrenceRule === 'none' ? 1 : input.recurrenceCount
    const occurrences = buildMeetingOccurrences(input.startsAt, input.endsAt, recurrenceRule, recurrenceCount)
    const meetings = await inTransaction(async (client) => {
      const created: Record<string, unknown>[] = []
      for (const occurrence of occurrences) {
        const result = await client.query(
          `INSERT INTO meetings (
            host_id, title, description, room_name, starts_at, ends_at, timezone,
            waiting_room, mute_on_entry, allow_join_before_host, recurrence_rule,
            owner_email, owner_display_name
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            currentUser.id,
            input.title,
            input.description,
            `aleph-${nanoid(12)}`,
            occurrence.startsAt,
            occurrence.endsAt,
            input.timezone,
            input.waitingRoom,
            input.muteOnEntry,
            input.allowJoinBeforeHost,
            occurrence.recurrenceRule,
            currentUser.email?.trim().toLowerCase() ?? null,
            currentUser.displayName,
          ],
        )
        const row = result.rows[0] as Record<string, unknown>
        await insertMeetingAttendees(client, String(row.id), input.attendees, input.attendeeUserIds)
        created.push(camelizeRow(row))
      }
      return created
    })
    if (input.syncCalendar) await syncCurrentExchangeAccount('meeting_created')
    return reply.code(201).send({ meeting: meetings[0], meetings })
  })

  app.delete<{ Params: IdParams }>('/api/meetings/:id', async (request, reply) => {
    const meetingResult = await pool.query(
      `SELECT m.*, l.account_id, l.external_event_id, l.external_change_key
       FROM meetings m
       LEFT JOIN calendar_event_links l ON l.meeting_id=m.id
       WHERE m.id=$1 AND m.host_id=$2
       LIMIT 1`,
      [request.params.id, currentUser.id],
    )
    const meeting = meetingResult.rows[0] as {
      id: string
      status: string
      room_name: string
      account_id: string | null
      external_event_id: string | null
      external_change_key: string | null
      ends_at: Date | string
    } | undefined
    if (!meeting) return reply.code(404).send({ error: 'meeting_not_found', message: 'Встреча не найдена.' })
    if (meeting.status !== 'scheduled' || new Date(meeting.ends_at) <= new Date()) {
      return reply.code(409).send({
        error: 'meeting_not_scheduled',
        message: 'Удалять можно только запланированные встречи.',
      })
    }

    if (meeting.account_id && meeting.external_event_id) {
      const accountResult = await pool.query(
        `SELECT * FROM calendar_accounts
         WHERE id=$1 AND user_id=$2 AND provider='exchange_ews'
         LIMIT 1`,
        [meeting.account_id, currentUser.id],
      )
      const account = accountResult.rows[0] as ExchangeAccountRow | undefined
      if (account) {
        try {
          await deleteExchangeEvent(
            exchangeCredentials(account),
            meeting.external_event_id,
            meeting.external_change_key ?? undefined,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('ErrorItemNotFound')) throw error
        }
      }
    }

    const recipients = await pool.query(
      `SELECT host_id AS user_id FROM meetings WHERE id=$1
       UNION
       SELECT user_id FROM meeting_attendees WHERE meeting_id=$1 AND user_id IS NOT NULL`,
      [request.params.id],
    )
    await pool.query('DELETE FROM meetings WHERE id=$1 AND host_id=$2', [request.params.id, currentUser.id])
    for (const recipient of recipients.rows) {
      io.to(`user:${String(recipient.user_id)}`).emit('meeting:updated', {
        meetingId: request.params.id,
        status: 'cancelled',
        deleted: true,
      })
    }
    await syncCurrentExchangeAccount('meeting_deleted')
    return { success: true }
  })

  app.patch<{ Params: IdParams }>('/api/meetings/:id', async (request, reply) => {
    const input = meetingInputSchema.parse(request.body)
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      return reply.code(400).send({ error: 'ends_before_start' })
    }

    const meeting = await inTransaction(async (client) => {
      const existing = await client.query(
        'SELECT id, status, ends_at FROM meetings WHERE id=$1 AND host_id=$2 FOR UPDATE',
        [request.params.id, currentUser.id],
      )
      const existingMeeting = existing.rows[0] as { id: string; status: string; ends_at: Date | string } | undefined
      if (!existingMeeting) {
        throw Object.assign(new Error('Встреча не найдена.'), { statusCode: 404 })
      }
      if (existingMeeting.status !== 'scheduled' || new Date(existingMeeting.ends_at) <= new Date()) {
        throw Object.assign(new Error('Изменять можно только запланированные встречи.'), { statusCode: 409 })
      }

      const shouldUpdateRecurrence = input.recurrenceRule !== undefined
      const recurrenceRule = input.recurrenceRule && input.recurrenceRule !== 'none'
        ? input.recurrenceRule
        : null
      const result = await client.query(
        `UPDATE meetings
         SET title=$1, description=$2, starts_at=$3, ends_at=$4, timezone=$5,
             waiting_room=$6, mute_on_entry=$7, allow_join_before_host=$8,
             recurrence_rule=CASE WHEN $9::boolean THEN $10::text ELSE recurrence_rule END,
             updated_at=now()
         WHERE id=$11 AND host_id=$12
         RETURNING *`,
        [
          input.title,
          input.description,
          input.startsAt,
          input.endsAt,
          input.timezone,
          input.waitingRoom,
          input.muteOnEntry,
          input.allowJoinBeforeHost,
          shouldUpdateRecurrence,
          recurrenceRule,
          request.params.id,
          currentUser.id,
        ],
      )
      await client.query('DELETE FROM meeting_attendees WHERE meeting_id=$1', [request.params.id])
      await insertMeetingAttendees(client, request.params.id, input.attendees, input.attendeeUserIds)
      return camelizeRow(result.rows[0] as Record<string, unknown>)
    })
    if (input.syncCalendar) await syncCurrentExchangeAccount('meeting_updated')
    await emitMeetingUpdated(request.params.id, { meetingId: request.params.id })
    return { meeting }
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

  app.post<{ Params: IdParams }>('/api/meetings/:id/host', async (request, reply) => {
    const { newHostId } = meetingHostTransferSchema.parse(request.body)
    const meetingResult = await pool.query(
      'SELECT id, host_id, room_name, status FROM meetings WHERE id=$1',
      [request.params.id],
    )
    const meeting = meetingResult.rows[0] as {
      id: string
      host_id: string
      room_name: string
      status: string
    } | undefined
    if (!meeting) return reply.code(404).send({ error: 'meeting_not_found', message: 'Встреча не найдена.' })
    if (meeting.host_id !== currentUser.id) {
      return reply.code(403).send({ error: 'organizer_required', message: 'Передать роль может только организатор.' })
    }
    if (meeting.status !== 'live') {
      return reply.code(409).send({ error: 'meeting_not_live', message: 'Встреча сейчас не активна.' })
    }
    if (newHostId === currentUser.id) {
      return reply.code(400).send({ error: 'already_organizer', message: 'Вы уже являетесь организатором.' })
    }

    const participants = await roomService.listParticipants(meeting.room_name)
    if (!participants.some((participant) => participant.identity === newHostId)) {
      return reply.code(409).send({
        error: 'participant_not_connected',
        message: 'Выбранный участник уже вышел из конференции.',
      })
    }

    const updated = await inTransaction(async (client) => {
      const locked = await client.query(
        'SELECT host_id, status FROM meetings WHERE id=$1 FOR UPDATE',
        [meeting.id],
      )
      if (locked.rows[0]?.host_id !== currentUser.id) {
        throw Object.assign(new Error('Организатор встречи уже изменился.'), { statusCode: 409 })
      }
      if (locked.rows[0]?.status !== 'live') {
        throw Object.assign(new Error('Встреча уже завершена.'), { statusCode: 409 })
      }
      const newHost = await client.query('SELECT id FROM users WHERE id=$1', [newHostId])
      if (!newHost.rowCount) {
        throw Object.assign(new Error('Участник не найден.'), { statusCode: 404 })
      }
      await client.query(
        `INSERT INTO meeting_attendees (meeting_id, user_id, email, response, joined_at, left_at)
         SELECT $1, id, email, 'accepted', now(), now() FROM users WHERE id=$2
         ON CONFLICT (meeting_id, user_id) WHERE user_id IS NOT NULL
         DO UPDATE SET response='accepted',
                       joined_at=COALESCE(meeting_attendees.joined_at, now()),
                       left_at=now()`,
        [meeting.id, currentUser.id],
      )
      await client.query(
        'DELETE FROM meeting_attendees WHERE meeting_id=$1 AND user_id=$2',
        [meeting.id, newHostId],
      )
      const result = await client.query(
        'UPDATE meetings SET host_id=$1, updated_at=now() WHERE id=$2 RETURNING *',
        [newHostId, meeting.id],
      )
      return camelizeRow(result.rows[0] as Record<string, unknown>)
    })
    await emitMeetingUpdated(meeting.id, {
      meetingId: meeting.id,
      hostId: newHostId,
      status: 'live',
    })
    return { meeting: updated }
  })

  app.post<{ Params: IdParams }>('/api/meetings/:id/end', async (request, reply) => {
    const updated = await inTransaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM meetings WHERE id=$1 FOR UPDATE',
        [request.params.id],
      )
      const meeting = result.rows[0] as Record<string, unknown> | undefined
      if (!meeting) {
        throw Object.assign(new Error('Встреча не найдена.'), { statusCode: 404 })
      }
      if (meeting.host_id !== currentUser.id) {
        throw Object.assign(new Error('Завершить встречу может только организатор.'), { statusCode: 403 })
      }
      if (meeting.status === 'ended' || meeting.status === 'cancelled') {
        throw Object.assign(new Error('Встреча уже завершена.'), { statusCode: 409 })
      }
      const roomName = String(meeting.room_name)
      const activeRooms = await roomService.listRooms([roomName])
      if (activeRooms.length) await roomService.deleteRoom(roomName)
      const ended = await client.query(
        `UPDATE meetings SET status='ended', updated_at=now() WHERE id=$1 RETURNING *`,
        [request.params.id],
      )
      return camelizeRow(ended.rows[0] as Record<string, unknown>)
    })
    await emitMeetingUpdated(request.params.id, {
      meetingId: request.params.id,
      status: 'ended',
    })
    return { meeting: updated }
  })

  app.post<{ Params: IdParams }>('/api/meetings/:id/invitations', async (request, reply) => {
    const { userIds } = meetingInvitationSchema.parse(request.body)
    const meetingResult = await pool.query(
      `SELECT m.*, host.display_name AS host_display_name, host.avatar_url AS host_avatar_url
       FROM meetings m JOIN users host ON host.id=m.host_id WHERE m.id=$1`,
      [request.params.id],
    )
    const meeting = meetingResult.rows[0] as Record<string, unknown> | undefined
    if (!meeting) return reply.code(404).send({ error: 'meeting_not_found', message: 'Встреча не найдена.' })
    if (meeting.host_id !== currentUser.id) {
      return reply.code(403).send({ error: 'organizer_required', message: 'Приглашать участников может только организатор.' })
    }
    if (meeting.status !== 'live') {
      return reply.code(409).send({ error: 'meeting_not_live', message: 'Встреча сейчас не активна.' })
    }

    const contacts = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.avatar_url
       FROM contacts c JOIN users u ON u.id=c.contact_user_id
       WHERE c.owner_id=$1 AND u.id = ANY($2::uuid[])`,
      [currentUser.id, [...new Set(userIds)]],
    )
    if (contacts.rowCount !== new Set(userIds).size) {
      return reply.code(400).send({ error: 'contact_required', message: 'Пригласить можно только пользователя из контактов.' })
    }

    for (const contact of contacts.rows) {
      const linkedByEmail = await pool.query(
        `UPDATE meeting_attendees
         SET user_id=$2, response='invited', joined_at=NULL, left_at=NULL
         WHERE meeting_id=$1 AND user_id IS NULL AND lower(email)=lower($3)
         RETURNING id`,
        [meeting.id, contact.id, contact.email],
      )
      if (!linkedByEmail.rowCount) {
        await pool.query(
          `INSERT INTO meeting_attendees (meeting_id, user_id, email, response)
           VALUES ($1,$2,$3,'invited')
           ON CONFLICT (meeting_id, user_id) WHERE user_id IS NOT NULL
           DO UPDATE SET response='invited', joined_at=NULL, left_at=NULL`,
          [meeting.id, contact.id, contact.email],
        )
      }
      io.to(`user:${String(contact.id)}`).emit('call:incoming', {
        meeting: camelizeRow(meeting),
        caller: currentUser,
        invitation: true,
      })
      scheduleMeetingInvitationTimeout(String(meeting.id), String(contact.id))
    }
    await emitMeetingUpdated(String(meeting.id), { meetingId: meeting.id })
    return { invited: contacts.rows.map((contact) => String(contact.id)) }
  })

  app.post<{ Params: IdParams }>('/api/meetings/:id/invitations/decline', async (request, reply) => {
    const result = await pool.query(
      `UPDATE meeting_attendees SET response='declined'
       WHERE meeting_id=$1 AND user_id=$2 AND response='invited' RETURNING id`,
      [request.params.id, currentUser.id],
    )
    if (!result.rowCount) {
      return reply.code(404).send({ error: 'invitation_not_found', message: 'Активное приглашение не найдено.' })
    }
    clearMeetingInvitationTimer(request.params.id, currentUser.id)
    await emitMeetingUpdated(request.params.id, {
      meetingId: request.params.id,
      invitationUserId: currentUser.id,
    })
    return { success: true }
  })

  app.post<{ Params: IdParams }>('/api/meetings/:id/token', async (request, reply) => {
    const result = await pool.query('SELECT * FROM meetings WHERE id = $1', [request.params.id])
    const meeting = result.rows[0] as Record<string, unknown> | undefined
    if (!meeting) return reply.code(404).send({ error: 'meeting_not_found' })
    if (meeting.status === 'ended' || meeting.status === 'cancelled') {
      return reply.code(409).send({ error: 'meeting_ended', message: 'Встреча уже завершена.' })
    }

    const isHost = meeting.host_id === currentUser.id
    if (!isHost) {
      await pool.query(
        `UPDATE meeting_attendees SET response='accepted', joined_at=now(), left_at=NULL
         WHERE meeting_id=$1 AND user_id=$2`,
        [request.params.id, currentUser.id],
      )
      clearMeetingInvitationTimer(request.params.id, currentUser.id)
      await emitMeetingUpdated(request.params.id, {
        meetingId: request.params.id,
        invitationUserId: currentUser.id,
      })
    }
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
    try {
      const synced = await syncAdContactsForUser(currentUser)
      if (synced) app.log.info({ userId: currentUser.id, synced }, 'AD contact sync completed')
    } catch (error) {
      app.log.warn({ err: error, userId: currentUser.id }, 'AD contact sync failed')
    }
    const result = await pool.query(
      `SELECT u.id, u.phone, u.email, u.display_name, u.first_name, u.last_name,
              u.department, u.position, u.avatar_url,
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
            'department', u.department, 'position', u.position, 'avatarUrl', u.avatar_url,
            'status', CASE WHEN u.presence = 'online' AND u.last_seen_at >= now() - interval '90 seconds'
              THEN 'online' ELSE 'offline' END,
            'role', member.role
          ) ORDER BY u.display_name), '[]') AS members,
          (SELECT json_build_object(
           'id', m.id, 'body', m.body, 'kind', m.kind, 'createdAt', m.created_at,
            'senderId', m.sender_id
           ) FROM messages m WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
             AND NOT (m.kind = 'system' AND m.metadata->>'type' = 'call' AND m.metadata->>'status' = 'started')
             ORDER BY m.created_at DESC LIMIT 1) AS last_message,
          (SELECT count(*)::int FROM messages unread
           WHERE unread.conversation_id = c.id
             AND unread.sender_id IS DISTINCT FROM $1
             AND NOT (unread.kind = 'system' AND unread.metadata->>'type' = 'call' AND unread.metadata->>'status' = 'started')
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
          'url', COALESCE(a.storage_url, $2 || '/uploads/' || a.storage_name)
        )) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN attachments a ON a.message_id = m.id
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
         AND NOT (m.kind = 'system' AND m.metadata->>'type' = 'call' AND m.metadata->>'status' = 'started')
       GROUP BY m.id, u.display_name, u.avatar_url
       ORDER BY m.created_at`,
      [request.params.id, config.apiUrl],
    )
    const read = await pool.query(
      `UPDATE conversation_members member SET last_read_at = latest.created_at
       FROM (
         SELECT max(created_at) AS created_at FROM messages
         WHERE conversation_id = $1 AND sender_id IS DISTINCT FROM $2 AND deleted_at IS NULL
           AND NOT (kind = 'system' AND metadata->>'type' = 'call' AND metadata->>'status' = 'started')
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
           AND NOT (kind = 'system' AND metadata->>'type' = 'call' AND metadata->>'status' = 'started')
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
    await emitConversationUpdated(request.params.id)
    return reply.code(201).send({ message })
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/calls', async (request, reply) => {
    const input = callLogStartSchema.parse(request.body)
    const allowed = await pool.query(
      `SELECT 1 FROM conversations conversation
       JOIN conversation_members caller
         ON caller.conversation_id = conversation.id AND caller.user_id = $2
       JOIN meetings meeting ON meeting.id = $3 AND meeting.host_id = $2
       WHERE conversation.id = $1
         AND EXISTS (
           SELECT 1 FROM conversation_members other
           WHERE other.conversation_id = conversation.id AND other.user_id <> $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM meeting_attendees attendee
           WHERE attendee.meeting_id = meeting.id
             AND attendee.user_id IS NOT NULL
             AND attendee.user_id <> $2
             AND NOT EXISTS (
               SELECT 1 FROM conversation_members member
               WHERE member.conversation_id = conversation.id AND member.user_id = attendee.user_id
             )
         )`,
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
    const message = {
      ...camelizeRow(result.rows[0] as Record<string, unknown>),
      senderName: currentUser.displayName,
      senderAvatarUrl: currentUser.avatarUrl,
      deliveryStatus: 'delivered',
      attachments: [],
    }
    return reply.code(201).send({ message })
  })

  app.patch<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId', async (request, reply) => {
    const input = callLogFinishSchema.parse(request.body)
    const body = callSummary(input.status, input.durationMs)
    let result = await pool.query(
      `UPDATE messages message SET
         body = $4,
         metadata = message.metadata || jsonb_build_object(
           'status',$3::text,'durationMs',$5::int,'endedAt',now()
         ),
         edited_at = now()
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND message.metadata->>'status' = 'started'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $6
         )
       RETURNING *`,
      [request.params.id, request.params.messageId, input.status, body, input.durationMs, currentUser.id],
    )
    const firstCompletion = Boolean(result.rowCount)
    if (!firstCompletion) {
      result = await pool.query(
        `SELECT message.* FROM messages message
         WHERE message.id = $2 AND message.conversation_id = $1
           AND message.kind = 'system' AND message.metadata->>'type' = 'call'
           AND EXISTS (
             SELECT 1 FROM conversation_members member
             WHERE member.conversation_id = message.conversation_id AND member.user_id = $3
           )`,
        [request.params.id, request.params.messageId, currentUser.id],
      )
    }
    if (!result.rowCount) return reply.code(404).send({ error: 'call_log_not_found' })
    const attachments = await pool.query(
      'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
      [request.params.messageId],
    )
    const message = {
      ...camelizeRow(result.rows[0] as Record<string, unknown>),
      deliveryStatus: 'delivered',
      attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
    }
    if (firstCompletion) {
      await pool.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      await emitMessageToMembers(request.params.id, message)
      await emitConversationUpdated(request.params.id)
    }
    return { message }
  })

  app.post<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId/recording', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'file_required' })
    const call = await pool.query(
      `SELECT message.id, meeting.id AS meeting_id, meeting.starts_at
       FROM messages message
       JOIN meetings meeting ON meeting.id = (message.metadata->>'meetingId')::uuid
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $3
         )`,
      [request.params.id, request.params.messageId, currentUser.id],
    )
    if (!call.rowCount) {
      data.file.resume()
      return reply.code(404).send({ error: 'call_log_not_found' })
    }
    const callRow = call.rows[0] as { meeting_id: string; starts_at: Date | string }
    const storage = await uploadStreamToS3({
      stream: data.file,
      originalName: data.filename,
      mimeType: data.mimetype,
      scopePath: buildStorageScope('meetings', callRow.meeting_id, 'recordings'),
      storageName: recordingStorageName(data.filename, callRow.starts_at),
    })
    const message = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms,
          storage_provider, storage_bucket, storage_key, storage_url
        ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10) RETURNING *`,
        [
          request.params.messageId,
          currentUser.id,
          storage.storageName,
          storage.storageName,
          data.mimetype,
          storage.byteSize,
          storage.storageProvider,
          storage.storageBucket,
          storage.storageKey,
          storage.storageUrl,
        ],
      )
      const updated = await client.query(
        `UPDATE messages SET
           metadata = metadata || jsonb_build_object(
             'recordingUrl',$1::text,'recordingName',$2::text
           ),
           edited_at = now()
         WHERE id = $3 AND conversation_id = $4
         RETURNING *`,
        [storage.storageUrl, storage.storageName, request.params.messageId, request.params.id],
      )
      const allAttachments = await client.query(
        'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
        [request.params.messageId],
      )
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      return {
        ...camelizeRow(updated.rows[0] as Record<string, unknown>),
        deliveryStatus: 'delivered',
        attachments: allAttachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
      }
    })
    await emitToConversationMembers(request.params.id, 'message:updated', message)
    return reply.code(201).send({ message })
  })

  app.post<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId/transcript', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'file_required' })
    const call = await pool.query(
      `SELECT message.id, meeting.id AS meeting_id, meeting.starts_at
       FROM messages message
       JOIN meetings meeting ON meeting.id = (message.metadata->>'meetingId')::uuid
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $3
         )`,
      [request.params.id, request.params.messageId, currentUser.id],
    )
    if (!call.rowCount) {
      data.file.resume()
      return reply.code(404).send({ error: 'call_log_not_found' })
    }
    const chunks: Buffer[] = []
    for await (const chunk of data.file) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const body = Buffer.concat(chunks)
    if (!body.byteLength) return reply.code(400).send({ error: 'file_empty' })
    const callRow = call.rows[0] as { meeting_id: string; starts_at: Date | string }
    const originalName = data.filename || 'transcript.txt'
    const storage = await uploadStreamToS3({
      stream: Readable.from(body),
      originalName,
      mimeType: data.mimetype || 'text/plain; charset=utf-8',
      scopePath: buildStorageScope('meetings', callRow.meeting_id, 'transcripts'),
      storageName: recordingStorageName(originalName, callRow.starts_at),
    })
    const message = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms,
          storage_provider, storage_bucket, storage_key, storage_url
        ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10) RETURNING *`,
        [
          request.params.messageId,
          currentUser.id,
          originalName,
          storage.storageName,
          data.mimetype || 'text/plain; charset=utf-8',
          storage.byteSize,
          storage.storageProvider,
          storage.storageBucket,
          storage.storageKey,
          storage.storageUrl,
        ],
      )
      const updated = await client.query(
        `UPDATE messages SET
           metadata = metadata || jsonb_build_object(
             'transcriptUrl',$1::text,'transcriptName',$2::text
           ),
           edited_at = now()
         WHERE id = $3 AND conversation_id = $4
         RETURNING *`,
        [storage.storageUrl, originalName, request.params.messageId, request.params.id],
      )
      const attachments = await client.query(
        'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
        [request.params.messageId],
      )
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      return {
        ...camelizeRow(updated.rows[0] as Record<string, unknown>),
        deliveryStatus: 'delivered',
        attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
      }
    })
    await emitToConversationMembers(request.params.id, 'message:updated', message)
    return reply.code(201).send({ message })
  })

  app.post<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId/analysis', async (request, reply) => {
    const input = request.body as { transcriptText?: unknown; name?: unknown } | null
    const transcriptText = typeof input?.transcriptText === 'string' ? input.transcriptText.trim() : ''
    if (!transcriptText) return reply.code(400).send({ error: 'transcript_required', message: 'Transcript is required.' })
    const call = await pool.query(
      `SELECT message.id, meeting.id AS meeting_id, meeting.starts_at, meeting.title, meeting.room_name
       FROM messages message
       JOIN meetings meeting ON meeting.id = (message.metadata->>'meetingId')::uuid
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $3
         )`,
      [request.params.id, request.params.messageId, currentUser.id],
    )
    if (!call.rowCount) return reply.code(404).send({ error: 'call_log_not_found' })
    const callRow = call.rows[0] as {
      meeting_id: string
      starts_at: Date | string
      title: string
      room_name: string
    }

    const pendingMessage = await inTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE messages SET
           metadata = (metadata || jsonb_build_object('analysisPending', true)) - 'analysisError',
           edited_at = now()
         WHERE id = $1 AND conversation_id = $2
         RETURNING *`,
        [request.params.messageId, request.params.id],
      )
      const attachments = await client.query(
        'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
        [request.params.messageId],
      )
      return {
        ...camelizeRow(updated.rows[0] as Record<string, unknown>),
        deliveryStatus: 'delivered',
        attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
      }
    })
    await emitToConversationMembers(request.params.id, 'message:updated', pendingMessage)

    const markAnalysisFailed = async (error: unknown): Promise<void> => {
      const errorMessage = error instanceof Error ? error.message : 'Alepha conspect failed'
      const failedMessage = await inTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE messages SET
             metadata = metadata || jsonb_build_object(
               'analysisPending', false,
               'analysisError', $1::text
             ),
             edited_at = now()
           WHERE id = $2 AND conversation_id = $3
           RETURNING *`,
          [errorMessage, request.params.messageId, request.params.id],
        )
        const attachments = await client.query(
          'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
          [request.params.messageId],
        )
        return {
          ...camelizeRow(updated.rows[0] as Record<string, unknown>),
          deliveryStatus: 'delivered',
          attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
        }
      })
      await emitToConversationMembers(request.params.id, 'message:updated', failedMessage)
    }

    const runAnalysis = async (): Promise<void> => {
      try {
        const conspect = await createAlephaConspect({
          chatId: callRow.meeting_id,
          transcriptText,
        })
        const originalName = typeof input?.name === 'string' && input.name.trim()
      ? input.name.trim()
      : 'analysis.txt'
    const body = Buffer.from(`${conspect.text.trim()}\n`, 'utf8')
    const storage = await uploadStreamToS3({
      stream: Readable.from(body),
      originalName,
      mimeType: 'text/plain; charset=utf-8',
      scopePath: buildStorageScope('meetings', callRow.meeting_id, 'analysis'),
      storageName: recordingStorageName(originalName, callRow.starts_at),
    })
    const callMessage = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms,
          storage_provider, storage_bucket, storage_key, storage_url
        ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10) RETURNING *`,
        [
          request.params.messageId,
          currentUser.id,
          originalName,
          storage.storageName,
          'text/plain; charset=utf-8',
          storage.byteSize,
          storage.storageProvider,
          storage.storageBucket,
          storage.storageKey,
          storage.storageUrl,
        ],
      )
      const updated = await client.query(
        `UPDATE messages SET
           metadata = (
             metadata || jsonb_build_object(
               'analysisUrl',$1::text,
               'analysisName',$2::text,
               'analysisPending', false,
               'analysisSummary', $5::text,
               'alephaDialogId', $6::text
             )
           ) - 'analysisError',
           edited_at = now()
         WHERE id = $3 AND conversation_id = $4
         RETURNING *`,
        [
          storage.storageUrl,
          originalName,
          request.params.messageId,
          request.params.id,
          conspect.text,
          conspect.dialogId,
        ],
      )
      const attachments = await client.query(
        'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
        [request.params.messageId],
      )
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      return {
        ...camelizeRow(updated.rows[0] as Record<string, unknown>),
        deliveryStatus: 'delivered',
        attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
      }
    })
    await emitToConversationMembers(request.params.id, 'message:updated', callMessage)
    await emitConversationUpdated(request.params.id)
    await sendCallMaterialsEmail(request.params.id, request.params.messageId, {
      id: callRow.meeting_id,
      title: callRow.title,
      room_name: callRow.room_name,
    })
      } catch (error) {
        app.log.error({ err: error, meetingId: callRow.meeting_id }, 'Failed to create meeting analysis')
        await markAnalysisFailed(error).catch((failure) => {
          app.log.error({ err: failure, meetingId: callRow.meeting_id }, 'Failed to mark meeting analysis as failed')
        })
      }
    }

    void runAnalysis()
    return reply.code(202).send({ message: pendingMessage })
  })

  app.post<{ Params: { id: string; messageId: string } }>('/api/conversations/:id/calls/:messageId/materials', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'file_required' })
    const query = request.query as { kind?: string }
    const kind = query.kind === 'whiteboard' ? 'whiteboard' : 'meeting-chat'
    const call = await pool.query(
      `SELECT message.id, meeting.id AS meeting_id
       FROM messages message
       JOIN meetings meeting ON meeting.id = (message.metadata->>'meetingId')::uuid
       WHERE message.id = $2 AND message.conversation_id = $1
         AND message.kind = 'system' AND message.metadata->>'type' = 'call'
         AND EXISTS (
           SELECT 1 FROM conversation_members member
           WHERE member.conversation_id = message.conversation_id AND member.user_id = $3
         )`,
      [request.params.id, request.params.messageId, currentUser.id],
    )
    if (!call.rowCount) {
      data.file.resume()
      return reply.code(404).send({ error: 'call_log_not_found' })
    }
    const callRow = call.rows[0] as { meeting_id: string }
    const storage = await uploadStreamToS3({
      stream: data.file,
      originalName: data.filename,
      mimeType: data.mimetype || 'application/octet-stream',
      scopePath: buildStorageScope('meetings', callRow.meeting_id, kind === 'whiteboard' ? 'whiteboards' : 'materials'),
      storageName: attachmentStorageName(data.filename),
    })
    const message = await inTransaction(async (client) => {
      await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms,
          storage_provider, storage_bucket, storage_key, storage_url
        ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10) RETURNING *`,
        [
          request.params.messageId,
          currentUser.id,
          data.filename,
          storage.storageName,
          data.mimetype || 'application/octet-stream',
          storage.byteSize,
          storage.storageProvider,
          storage.storageBucket,
          storage.storageKey,
          storage.storageUrl,
        ],
      )
      const updated = await client.query(
        `UPDATE messages SET
           metadata = metadata || jsonb_build_object('materialsUpdatedAt', now()),
           edited_at = now()
         WHERE id = $1 AND conversation_id = $2
         RETURNING *`,
        [request.params.messageId, request.params.id],
      )
      const attachments = await client.query(
        'SELECT * FROM attachments WHERE message_id=$1 ORDER BY created_at',
        [request.params.messageId],
      )
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [request.params.id])
      return {
        ...camelizeRow(updated.rows[0] as Record<string, unknown>),
        deliveryStatus: 'delivered',
        attachments: attachments.rows.map((row) => publicAttachment(row as Record<string, unknown>)),
      }
    })
    await emitToConversationMembers(request.params.id, 'message:updated', message)
    return reply.code(201).send({ message })
  })

  app.post<{ Params: IdParams }>('/api/conversations/:id/attachments', async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'file_required' })
    const query = request.query as { kind?: string; durationMs?: string }
    const kind = query.kind === 'audio' ? 'audio' : 'file'
    const membership = await pool.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [request.params.id, currentUser.id],
    )
    if (!membership.rowCount) {
      data.file.resume()
      return reply.code(404).send({ error: 'conversation_not_found' })
    }
    const durationMs = query.durationMs ? Number(query.durationMs) : null
    const storage = await uploadStreamToS3({
      stream: data.file,
      originalName: data.filename,
      mimeType: data.mimetype,
      scopePath: buildStorageScope('chats', request.params.id, kind === 'audio' ? 'audio' : 'attachments'),
      storageName: attachmentStorageName(data.filename),
    })

    const message = await inTransaction(async (client) => {
      const created = await client.query(
        `INSERT INTO messages (conversation_id, sender_id, kind) VALUES ($1,$2,$3) RETURNING *`,
        [request.params.id, currentUser.id, kind],
      )
      const row = created.rows[0] as Record<string, unknown>
      const attachment = await client.query(
        `INSERT INTO attachments (
          message_id, uploaded_by, original_name, storage_name, mime_type, byte_size, duration_ms,
          storage_provider, storage_bucket, storage_key, storage_url
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          row.id,
          currentUser.id,
          data.filename,
          storage.storageName,
          data.mimetype,
          storage.byteSize,
          Number.isFinite(durationMs) ? durationMs : null,
          storage.storageProvider,
          storage.storageBucket,
          storage.storageKey,
          storage.storageUrl,
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
            ...publicAttachment(attachment.rows[0] as Record<string, unknown>),
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
       RETURNING *`,
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
    const account = result.rows[0] as ExchangeAccountRow
    let sync: ExchangeSyncResult | null = null
    try {
      sync = await syncExchangeAccount(account, {
        id: currentUser.id,
        timezone: currentUser.timezone,
      })
    } catch (error) {
      app.log.warn(
        { err: error, accountId: account.id, userId: currentUser.id },
        'Initial Exchange calendar sync failed',
      )
    }
    const settingsResult = await pool.query(
      `SELECT id, server_url, email, username, domain, auth_method, verify_tls,
              sync_enabled, last_synced_at, last_sync_error
       FROM calendar_accounts WHERE id=$1`,
      [account.id],
    )
    return {
      configured: true,
      settings: camelizeRow(settingsResult.rows[0] as Record<string, unknown>),
      sync,
    }
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
    return syncExchangeAccount(account, {
      id: currentUser.id,
      timezone: currentUser.timezone,
    })
  })

  return app
}
