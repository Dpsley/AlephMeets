import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import process from 'node:process'
import type { PoolClient } from 'pg'
import { config, type CurrentUser } from './config.js'
import { inTransaction, pool } from './db.js'

interface IdpUser {
  id?: string
  uuid?: string
  phone?: string | null
  name?: string | null
  second_name?: string | null
  email?: string | null
  avatar?: string | null
  time_zone?: string | null
  department?: string | null
}

interface IdpResponse<T> {
  status: boolean
  message: T | string
}

interface LocalUserRow {
  id: string
  phone: string | null
  email: string | null
  display_name: string
  first_name: string | null
  last_name: string | null
  department: string | null
  avatar_url: string | null
  timezone: string
  locale: string
  presence: CurrentUser['status']
}

interface DirectoryUser {
  id?: string | null
  uuid?: string | null
  aleph_id?: string | null
  auid?: string | null
  dn?: string | null
  properties?: Record<string, unknown>
  phone?: string | null
  name?: string | null
  second_name?: string | null
  first_name?: string | null
  last_name?: string | null
  display_name?: string | null
  full_name?: string | null
  email?: string | null
  mail?: string | null
  avatar?: string | null
  avatar_url?: string | null
  time_zone?: string | null
  department?: string | null
}

export interface IdpTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

const accessLifetimeSeconds = 24 * 60 * 60
const refreshLifetimeSeconds = 30 * 24 * 60 * 60
const adUsersCacheTtlMs = 10 * 60 * 1000

let adUsersCache: { fetchedAt: number; users: DirectoryUser[] } | null = null
let adUsersFetchPromise: Promise<DirectoryUser[]> | null = null

export class IdpError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'IdpError'
    this.statusCode = statusCode
  }
}

export function normalizePhone(phone: string): string {
  let normalized = phone.replace(/\D/g, '')
  if (normalized.startsWith('8')) normalized = `7${normalized.slice(1)}`
  if (!normalized.startsWith('7')) normalized = `7${normalized}`
  normalized = normalized.slice(0, 11)
  if (normalized.length !== 11) {
    throw new IdpError('Введите корректный номер телефона.', 400)
  }
  return normalized
}

function requireIdpServiceConfig(): void {
  if (!config.idpEncodeKey || !config.idpDecodeKey || !config.idpAccessKey) {
    throw new IdpError('Сервисные ключи IDP не настроены на сервере.', 500)
  }
}

function requireAdServiceConfig(): void {
  requireIdpServiceConfig()
  if (!config.adControlSecret) {
    throw new IdpError('AD contact API is not configured on the server.', 500)
  }
}

function aesKey(secret: string): Buffer {
  const key = Buffer.alloc(32)
  Buffer.from(secret, 'utf8').copy(key, 0, 0, 32)
  return key
}

function utcHourString(now = new Date()): string {
  const year = String(now.getUTCFullYear()).padStart(4, '0')
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const day = String(now.getUTCDate()).padStart(2, '0')
  const hour = String(now.getUTCHours()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:00`
}

export function encryptIdpPayload(payload: unknown, secret = config.idpEncodeKey): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', aesKey(secret), iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64')
  return Buffer.concat([Buffer.from(`${encrypted}::`, 'ascii'), iv]).toString('base64')
}

export function encryptAdServicePayload(payload: unknown, secret = config.idpEncodeKey): string {
  const iv = randomBytes(8).toString('hex')
  const cipher = createCipheriv('aes-256-cbc', aesKey(secret), Buffer.from(iv, 'ascii'))
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64')
  return Buffer.from(`${encrypted}::${iv}`, 'ascii').toString('base64')
}

export function decryptIdpPayload<T>(value: string, secret = config.idpDecodeKey): T {
  const combined = Buffer.from(value, 'base64')
  const delimiter = combined.indexOf(Buffer.from('::'))
  if (delimiter < 1) throw new IdpError('IDP вернул данные в неизвестном формате.')
  const ciphertext = Buffer.from(combined.subarray(0, delimiter).toString('ascii'), 'base64')
  const iv = combined.subarray(delimiter + 2)
  if (iv.length !== 16) throw new IdpError('IDP вернул некорректный вектор шифрования.')
  const decipher = createDecipheriv('aes-256-cbc', aesKey(secret), iv)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  return JSON.parse(plaintext) as T
}

async function serviceIdpRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; payload?: unknown; auid?: string } = {},
): Promise<IdpResponse<T>> {
  requireIdpServiceConfig()
  let response: Response
  try {
    response = await fetch(`${config.idpBaseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.idpAccessKey}`,
        ...(options.auid ? { AUID: options.auid } : {}),
        ...(options.payload === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.payload === undefined
        ? undefined
        : JSON.stringify({ string: encryptIdpPayload(options.payload) }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdpError(`IDP недоступен: ${error instanceof Error ? error.message : String(error)}`)
  }

  const raw = await response.text()
  let encrypted = raw
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') encrypted = parsed[0]
    else if (typeof parsed === 'string') encrypted = parsed
  } catch {
    // The Python reference also accepts a raw encrypted response.
  }

  let payload: IdpResponse<T>
  try {
    const decoded = decryptIdpPayload<unknown>(encrypted)
    const wrapped = decoded as { original?: IdpResponse<T> }
    payload = wrapped.original ?? decoded as IdpResponse<T>
  } catch (error) {
    if (!response.ok) throw new IdpError(`IDP отклонил запрос (${response.status}).`, response.status)
    throw error
  }
  if (!response.ok || !payload.status) {
    const message = typeof payload.message === 'string' ? payload.message : 'Ошибка IDP'
    throw new IdpError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
  }
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim())
      if (typeof first === 'string') return first.trim()
    }
  }
  return null
}

function fieldValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      const first = value.find((item) => item !== undefined && item !== null && item !== '')
      if (first !== undefined) return first
      continue
    }
    if (value !== '') return value
  }
  return null
}

function directoryProperties(user: DirectoryUser): Record<string, unknown> {
  return isRecord(user.properties) ? user.properties : user as Record<string, unknown>
}

function objectGuidToUuid(value: unknown): string | null {
  const encoded = isRecord(value) && typeof value.value === 'string'
    ? value.value
    : typeof value === 'string'
      ? value
      : ''
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 16) return null
  const hex = (index: number): string => bytes[index]?.toString(16).padStart(2, '0') ?? '00'
  return [
    `${hex(3)}${hex(2)}${hex(1)}${hex(0)}`,
    `${hex(5)}${hex(4)}`,
    `${hex(7)}${hex(6)}`,
    `${hex(8)}${hex(9)}`,
    `${hex(10)}${hex(11)}${hex(12)}${hex(13)}${hex(14)}${hex(15)}`,
  ].join('-')
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function userCanLoadAdContacts(user: Pick<CurrentUser, 'department' | 'email'>): boolean {
  if (user.department?.trim()) return true
  const domain = user.email?.split('@').pop()?.trim().toLowerCase()
  return domain === 'alephtrade.com' || Boolean(domain?.endsWith('.alephtrade.com'))
}

function adControlPayload(now = new Date()): { control_string: string } {
  return {
    control_string: createHash('sha512')
      .update(`${config.adControlSecret}${utcHourString(now)}`)
      .digest('hex'),
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function decryptAdResponse(value: string): unknown {
  if (config.idpDecodeKey) {
    try {
      return decryptIdpPayload<unknown>(value, config.idpDecodeKey)
    } catch {
      // The AD endpoint may return plain JSON in non-production or test environments.
    }
  }
  return parseJson(value)
}

function unwrapAdResponse(payload: unknown): unknown {
  if (Array.isArray(payload) && typeof payload[0] === 'string') return decryptAdResponse(payload[0])
  if (typeof payload === 'string') return decryptAdResponse(payload)
  if (isRecord(payload) && 'original' in payload) return unwrapAdResponse(payload.original)
  return payload
}

function directoryUsersFromPayload(payload: unknown): DirectoryUser[] {
  const unwrapped = unwrapAdResponse(payload)
  if (Array.isArray(unwrapped)) return unwrapped.filter(isRecord) as DirectoryUser[]
  if (!isRecord(unwrapped)) return []

  if (unwrapped.status === false) {
    const message = typeof unwrapped.message === 'string' ? unwrapped.message : 'AD contact API returned an error.'
    throw new IdpError(message)
  }

  for (const key of ['message', 'users', 'data', 'items', 'result']) {
    if (key in unwrapped) {
      const users = directoryUsersFromPayload(unwrapped[key])
      if (users.length) return users
    }
  }
  return []
}

async function loadAdUsers(): Promise<DirectoryUser[]> {
  requireAdServiceConfig()
  const now = Date.now()
  if (adUsersCache && now - adUsersCache.fetchedAt < adUsersCacheTtlMs) {
    if (process.env.NODE_ENV !== 'production') {
      console.info(`[ad-sync] using cached ${adUsersCache.users.length} AD users`)
    }
    return adUsersCache.users
  }
  if (adUsersFetchPromise) return adUsersFetchPromise

  adUsersFetchPromise = fetchAdUsers()
    .then((users) => {
      adUsersCache = { fetchedAt: Date.now(), users }
      return users
    })
    .finally(() => {
      adUsersFetchPromise = null
    })
  return adUsersFetchPromise
}

async function fetchAdUsers(): Promise<DirectoryUser[]> {
  let response: Response
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[ad-sync] requesting ${config.idpBaseUrl}/service/ad/users`)
  }
  try {
    response = await fetch(`${config.idpBaseUrl}/service/ad/users`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.idpAccessKey}`,
      },
      body: JSON.stringify({ string: encryptAdServicePayload(adControlPayload()) }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdpError(`AD contact API is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const raw = await response.text()
  const payload = unwrapAdResponse(parseJson(raw))
  if (!response.ok) {
    throw new IdpError(`AD contact API rejected the request (${response.status}).`, response.status)
  }
  const users = directoryUsersFromPayload(payload)
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[ad-sync] received ${users.length} AD users`)
  }
  return users
}

function mapDirectoryUser(user: DirectoryUser): CurrentUser | null {
  const record = user as Record<string, unknown>
  const properties = directoryProperties(user)
  const objectGuid = objectGuidToUuid(fieldValue(properties, ['objectguid']))
  const id = stringField(record, ['id', 'uuid', 'aleph_id', 'auid']) ?? objectGuid
  if (!id || !isUuid(id)) return null
  const firstName = stringField(properties, ['first_name', 'givenname', 'name'])
  const lastName = stringField(properties, ['last_name', 'second_name', 'sn'])
  const email = stringField(properties, ['email', 'mail', 'userprincipalname'])?.toLowerCase() ?? null
  if (!email || (!email.endsWith('@alephtrade.com') && !email.endsWith('.alephtrade.com'))) return null
  const phone = stringField(properties, ['phone', 'mobile', 'telephonenumber'])?.replace(/\D/g, '') || null
  const displayName = stringField(properties, ['display_name', 'displayname', 'full_name', 'cn'])
    || [firstName, lastName].filter(Boolean).join(' ')
    || email
    || phone
    || id

  return {
    id,
    phone,
    email,
    displayName,
    firstName: firstName ?? '',
    lastName: lastName ?? '',
    department: stringField(properties, ['department']),
    avatarUrl: stringField(properties, ['avatar_url', 'thumbnailphoto', 'avatar']),
    timezone: stringField(properties, ['time_zone']) ?? 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'offline',
  }
}

async function upsertUserProfile(
  client: PoolClient,
  user: CurrentUser,
  options: { matchPhone?: boolean } = {},
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users
     WHERE id = $1
       OR ($2::text IS NOT NULL AND lower(email) = $2)
       OR ($4::boolean AND $3::text IS NOT NULL AND phone = $3)
     ORDER BY CASE
       WHEN id = $1 THEN 0
       WHEN $2::text IS NOT NULL AND lower(email) = $2 THEN 1
       ELSE 2
     END
     LIMIT 1`,
    [user.id, user.email, user.phone, Boolean(options.matchPhone)],
  )
  const userId = existing.rows[0]?.id ?? user.id

  const conflicts = await client.query<{ email_owner_id: string | null; phone_owner_id: string | null }>(
    `SELECT
       (
         SELECT id FROM users
         WHERE $2::text IS NOT NULL AND lower(email) = $2 AND id <> $1
         LIMIT 1
       ) AS email_owner_id,
       (
         SELECT id FROM users
         WHERE $3::text IS NOT NULL AND phone = $3 AND id <> $1
         LIMIT 1
       ) AS phone_owner_id`,
    [userId, user.email, user.phone],
  )
  const safeEmail = conflicts.rows[0]?.email_owner_id ? null : user.email
  const safePhone = conflicts.rows[0]?.phone_owner_id ? null : user.phone

  await client.query(
    `INSERT INTO users (
       id, phone, email, display_name, first_name, last_name, department,
       avatar_url, timezone, locale, presence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, users.phone),
       email = COALESCE(EXCLUDED.email, users.email),
       display_name = EXCLUDED.display_name,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       department = COALESCE(EXCLUDED.department, users.department),
       avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
       timezone = EXCLUDED.timezone,
       locale = EXCLUDED.locale`,
    [
      userId,
      safePhone,
      safeEmail,
      user.displayName,
      user.firstName || null,
      user.lastName || null,
      user.department,
      user.avatarUrl,
      user.timezone,
      user.locale,
      user.status,
    ],
  )
  return userId
}

export async function syncAdContactsForUser(user: CurrentUser): Promise<number> {
  if (!userCanLoadAdContacts(user)) return 0
  if (!config.adControlSecret) return 0
  const directoryUsers = (await loadAdUsers())
    .map(mapDirectoryUser)
    .filter((contact): contact is CurrentUser => Boolean(contact))

  return inTransaction(async (client) => {
    let synced = 0
    for (const contact of directoryUsers) {
      const contactUserId = await upsertUserProfile(client, contact)
      if (contactUserId === user.id) continue
      const result = await client.query(
        `INSERT INTO contacts (owner_id, contact_user_id)
         VALUES ($1,$2)
         ON CONFLICT DO NOTHING
         RETURNING contact_user_id`,
        [user.id, contactUserId],
      )
      synced += result.rowCount ?? 0
    }
    return synced
  })
}

function mapIdpUser(user: IdpUser, fallbackPhone: string): CurrentUser {
  const id = user.id ?? user.uuid
  if (!id) throw new IdpError('IDP не вернул идентификатор пользователя.')
  const firstName = user.name?.trim() ?? ''
  const lastName = user.second_name?.trim() ?? ''
  const phone = user.phone?.replace(/\D/g, '') || fallbackPhone || null
  return {
    id,
    phone,
    email: user.email?.trim().toLowerCase() || null,
    displayName: [firstName, lastName].filter(Boolean).join(' ') || phone || id,
    firstName,
    lastName,
    department: user.department?.trim() || null,
    avatarUrl: user.avatar || null,
    timezone: user.time_zone || 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'offline',
  }
}

function mapLocalUser(row: LocalUserRow): CurrentUser {
  return {
    id: row.id,
    phone: row.phone,
    email: row.email,
    displayName: row.display_name,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    department: row.department,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    locale: row.locale,
    status: row.presence,
  }
}

async function syncLocalUser(user: CurrentUser): Promise<CurrentUser> {
  return inTransaction(async (client) => {
    const userId = await upsertUserProfile(client, user, { matchPhone: true })
    const result = await client.query<LocalUserRow>(
      'SELECT * FROM users WHERE id = $1',
      [userId],
    )
    const row = result.rows[0]
    if (!row) throw new IdpError('Failed to load synchronized user.', 500)
    return mapLocalUser(row)
  })
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

async function createSession(client: PoolClient, userId: string): Promise<IdpTokens> {
  const accessToken = randomBytes(48).toString('base64url')
  const refreshToken = randomBytes(48).toString('base64url')
  await client.query(
    `INSERT INTO auth_sessions (
       user_id, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at
     ) VALUES ($1,$2,$3,now() + $4 * interval '1 second',now() + $5 * interval '1 second')`,
    [userId, tokenHash(accessToken), tokenHash(refreshToken), accessLifetimeSeconds, refreshLifetimeSeconds],
  )
  return { accessToken, refreshToken, expiresIn: accessLifetimeSeconds }
}

export async function issueSession(userId: string): Promise<IdpTokens> {
  return inTransaction((client) => createSession(client, userId))
}

async function findIdpAuid(phone: string): Promise<string> {
  const probe = await serviceIdpRequest<string>('/service/phone_probe', {
    method: 'POST',
    payload: { phone },
  })
  if (typeof probe.message !== 'string') throw new IdpError('IDP не вернул AUID пользователя.')
  return probe.message
}

async function loadIdpUser(auid: string, phone: string): Promise<CurrentUser> {
  const info = await serviceIdpRequest<IdpUser>('/service/user_info', { auid })
  if (typeof info.message === 'string') throw new IdpError(info.message)
  return syncLocalUser(mapIdpUser(info.message, phone))
}

export async function findIdpUserByEmail(email: string): Promise<CurrentUser> {
  const normalizedEmail = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new IdpError('Введите корректный email.', 400)
  }
  const lookup = await serviceIdpRequest<string>('/service/email/get/user', {
    method: 'POST',
    payload: { email: normalizedEmail },
  }) as IdpResponse<string> & { aleph_id?: string }
  if (!lookup.aleph_id) throw new IdpError('Пользователь с таким email не найден.', 404)
  return loadIdpUser(lookup.aleph_id, '')
}

export async function findIdpContact(identifier: string): Promise<CurrentUser> {
  const normalized = identifier.trim()
  if (normalized.includes('@')) return findIdpUserByEmail(normalized)
  const phone = normalizePhone(normalized)
  return loadIdpUser(await findIdpAuid(phone), phone)
}

export async function requestSms(phone: string): Promise<void> {
  const normalizedPhone = normalizePhone(phone)
  const auid = await findIdpAuid(normalizedPhone)
  await pool.query('DELETE FROM auth_login_challenges WHERE expires_at <= now()')
  await pool.query(
    `INSERT INTO auth_login_challenges (phone, auid, expires_at)
     VALUES ($1,$2,now() + interval '10 minutes')
     ON CONFLICT (phone) DO UPDATE SET
       auid = EXCLUDED.auid,
       attempts = 0,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [normalizedPhone, auid],
  )
  try {
    await serviceIdpRequest('/service/sms/send', {
      method: 'POST',
      payload: {
        phone: normalizedPhone,
        message: ' - код входа в AlephMeets. Никому не сообщайте его.',
      },
    })
  } catch (error) {
    // IDP rate-limits repeated sends for 60 seconds; the previous code remains valid.
    if (!(error instanceof IdpError) || !/send timeout/i.test(error.message)) throw error
  }
}

export async function verifySms(
  phone: string,
  code: string,
): Promise<{ tokens: IdpTokens; user: CurrentUser }> {
  const normalizedPhone = normalizePhone(phone)
  if (!/^\d{5,10}$/.test(code)) throw new IdpError('Код должен содержать от 5 до 10 цифр.', 400)
  const challengeResult = await pool.query<{ auid: string }>(
    `UPDATE auth_login_challenges SET attempts = attempts + 1, updated_at = now()
     WHERE phone = $1 AND expires_at > now() AND attempts < 5
     RETURNING auid`,
    [normalizedPhone],
  )
  const challenge = challengeResult.rows[0]
  if (!challenge) throw new IdpError('Запросите новый SMS-код.', 429)

  await serviceIdpRequest('/service/sms/validate', {
    method: 'POST',
    payload: { phone: normalizedPhone, code },
  })
  const user = await loadIdpUser(challenge.auid, normalizedPhone)
  const tokens = await issueSession(user.id)
  await pool.query('DELETE FROM auth_login_challenges WHERE phone = $1', [normalizedPhone])
  return { tokens, user }
}

export async function authenticateAccessToken(accessToken: string): Promise<CurrentUser> {
  if (!accessToken) throw new IdpError('Authentication required', 401)
  const result = await pool.query<LocalUserRow>(
    `SELECT users.* FROM auth_sessions session
     JOIN users ON users.id = session.user_id
     WHERE session.access_token_hash = $1
       AND session.revoked_at IS NULL
       AND session.access_expires_at > now()`,
    [tokenHash(accessToken)],
  )
  const user = result.rows[0]
  if (!user) throw new IdpError('Сессия истекла. Войдите снова.', 401)
  return mapLocalUser(user)
}

export async function refreshSession(refreshToken: string): Promise<IdpTokens> {
  if (!refreshToken) throw new IdpError('Refresh token is required', 400)
  return inTransaction(async (client) => {
    const result = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM auth_sessions
       WHERE refresh_token_hash = $1
         AND revoked_at IS NULL
         AND refresh_expires_at > now()
       FOR UPDATE`,
      [tokenHash(refreshToken)],
    )
    const session = result.rows[0]
    if (!session) throw new IdpError('Сессия истекла. Войдите снова.', 401)
    await client.query('UPDATE auth_sessions SET revoked_at = now(), updated_at = now() WHERE id = $1', [session.id])
    return createSession(client, session.user_id)
  })
}

export async function logoutSession(accessToken: string): Promise<void> {
  if (!accessToken) return
  await pool.query(
    `UPDATE auth_sessions SET revoked_at = now(), updated_at = now()
     WHERE access_token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash(accessToken)],
  )
}
