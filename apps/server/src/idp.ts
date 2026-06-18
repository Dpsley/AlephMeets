import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'
import type { PoolClient } from 'pg'
import { config, type CurrentUser } from './config.js'
import { inTransaction, pool } from './db.js'

interface IdpUser {
  id?: string
  uuid?: string
  phone?: string | null
  name?: string | null
  second_name?: string | null
  patronymic?: string | null
  email?: string | null
  avatar?: string | null
  time_zone?: string | null
}

interface IdpResponse<T> {
  status: boolean
  message: T | string
}

interface LocalUserRow {
  id: string
  phone: string | null
  email: string
  display_name: string
  first_name: string | null
  last_name: string | null
  avatar_url: string | null
  timezone: string
  locale: string
  presence: CurrentUser['status']
}

export interface IdpTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

const accessLifetimeSeconds = 24 * 60 * 60
const refreshLifetimeSeconds = 30 * 24 * 60 * 60

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
  if (normalized.length === 11 && normalized.startsWith('8')) normalized = `7${normalized.slice(1)}`
  if (normalized.length === 10) normalized = `7${normalized}`
  if (normalized.length < 10 || normalized.length > 15) {
    throw new IdpError('Введите корректный номер телефона.', 400)
  }
  return normalized
}

function requireIdpServiceConfig(): void {
  if (!config.idpEncodeKey || !config.idpDecodeKey || !config.idpAccessKey) {
    throw new IdpError('Сервисные ключи IDP не настроены на сервере.', 500)
  }
}

function aesKey(secret: string): Buffer {
  const key = Buffer.alloc(32)
  Buffer.from(secret, 'utf8').copy(key, 0, 0, 32)
  return key
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

async function directIdpRequest<T>(path: string, body: Record<string, string>): Promise<IdpResponse<T>> {
  let response: Response
  try {
    response = await fetch(`${config.idpBaseUrl}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdpError(`IDP недоступен: ${error instanceof Error ? error.message : String(error)}`)
  }
  const payload = await response.json().catch(() => ({
    status: false,
    message: response.statusText || 'IDP вернул некорректный ответ',
  })) as IdpResponse<T>
  if (!response.ok || !payload.status) {
    const message = typeof payload.message === 'string' ? payload.message : 'Ошибка IDP'
    throw new IdpError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
  }
  return payload
}

async function getIdpSessionUser(accessToken: string, fallbackPhone: string): Promise<CurrentUser | null> {
  let response: Response
  try {
    response = await fetch(`${config.idpBaseUrl}/login/session`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdpError(`IDP недоступен: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status === 404 || response.status === 405) return null
  const payload = await response.json().catch(() => ({
    status: false,
    message: response.statusText || 'IDP вернул некорректный ответ',
  })) as IdpResponse<{ user: IdpUser }>
  if (!response.ok || !payload.status || typeof payload.message === 'string') {
    const message = typeof payload.message === 'string' ? payload.message : 'Ошибка IDP'
    throw new IdpError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
  }
  return syncLocalUser(mapIdpUser(payload.message.user, fallbackPhone))
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
    // The reference client also accepts a raw encrypted response.
  }

  let payload: IdpResponse<T>
  try {
    payload = decryptIdpPayload<IdpResponse<T>>(encrypted)
  } catch (error) {
    if (!response.ok) {
      throw new IdpError(`IDP отклонил запрос (${response.status}).`, response.status)
    }
    throw error
  }
  if (!response.ok || !payload.status) {
    const message = typeof payload.message === 'string' ? payload.message : 'Ошибка IDP'
    throw new IdpError(message, response.status >= 400 && response.status < 500 ? response.status : 502)
  }
  return payload
}

function mapIdpUser(user: IdpUser, fallbackPhone: string): CurrentUser {
  const id = user.id ?? user.uuid
  if (!id) throw new IdpError('IDP не вернул идентификатор пользователя.')
  const firstName = user.name?.trim() ?? ''
  const lastName = user.second_name?.trim() ?? ''
  const phone = user.phone?.replace(/\D/g, '') || fallbackPhone
  return {
    id,
    phone,
    email: user.email?.trim().toLowerCase() || `${id}@aleph-id.local`,
    displayName: [firstName, lastName].filter(Boolean).join(' ') || phone,
    firstName,
    lastName,
    avatarUrl: user.avatar || null,
    timezone: user.time_zone || 'Europe/Moscow',
    locale: 'ru-RU',
    status: 'online',
  }
}

function mapLocalUser(row: LocalUserRow): CurrentUser {
  return {
    id: row.id,
    phone: row.phone ?? '',
    email: row.email,
    displayName: row.display_name,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    locale: row.locale,
    status: row.presence,
  }
}

async function syncLocalUser(user: CurrentUser): Promise<CurrentUser> {
  await pool.query(
    `INSERT INTO users (
       id, phone, email, display_name, first_name, last_name, avatar_url, timezone, locale, presence
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       phone = EXCLUDED.phone,
       email = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       avatar_url = EXCLUDED.avatar_url,
       timezone = EXCLUDED.timezone,
       locale = EXCLUDED.locale,
       presence = EXCLUDED.presence`,
    [
      user.id,
      user.phone,
      user.email,
      user.displayName,
      user.firstName || null,
      user.lastName || null,
      user.avatarUrl,
      user.timezone,
      user.locale,
      user.status,
    ],
  )
  return user
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

async function findIdpUser(phone: string): Promise<CurrentUser> {
  const probe = await serviceIdpRequest<string>('/service/phone_probe', {
    method: 'POST',
    payload: { phone },
  })
  if (typeof probe.message !== 'string') throw new IdpError('IDP не вернул AUID пользователя.')
  const info = await serviceIdpRequest<IdpUser>('/service/user_info', { auid: probe.message })
  if (typeof info.message === 'string') throw new IdpError(info.message)
  return syncLocalUser(mapIdpUser(info.message, phone))
}

export async function requestSms(phone: string): Promise<void> {
  await directIdpRequest<string>('/login/phone', { phone: normalizePhone(phone) })
}

export async function verifySms(
  phone: string,
  code: string,
): Promise<{ tokens: IdpTokens; user: CurrentUser }> {
  const normalizedPhone = normalizePhone(phone)
  if (!/^\d{6}$/.test(code)) throw new IdpError('Код должен содержать 6 цифр.', 400)
  const verified = await directIdpRequest<{
    access_token: string
    refresh_token: string
    expires_in: number
  }>('/login/phone_code', { phone: normalizedPhone, code })
  if (typeof verified.message === 'string') throw new IdpError(verified.message)
  const user = await getIdpSessionUser(verified.message.access_token, normalizedPhone)
    ?? await findIdpUser(normalizedPhone)
  const tokens = await issueSession(user.id)
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
