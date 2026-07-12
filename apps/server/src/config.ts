import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const moduleDir = dirname(fileURLToPath(import.meta.url))
export const rootDir = resolve(moduleDir, '../../..')
dotenv.config({ path: resolve(rootDir, '.env') })

export interface CurrentUser {
  id: string
  phone: string | null
  email: string | null
  displayName: string
  firstName: string
  lastName: string
  department: string | null
  position: string | null
  avatarUrl: string | null
  timezone: string
  locale: string
  status: 'online' | 'away' | 'busy' | 'offline'
}

const userContext = new AsyncLocalStorage<CurrentUser>()
const contextTarget = {} as CurrentUser

export const currentUser = new Proxy(contextTarget, {
  get(_target, property: keyof CurrentUser) {
    const user = userContext.getStore()
    if (!user) throw Object.assign(new Error('Authentication required'), { statusCode: 401 })
    return user[property]
  },
})

export function enterCurrentUserContext(user: CurrentUser): CurrentUser {
  userContext.enterWith(user)
  return user
}

export const config = {
  host: process.env.API_HOST ?? '127.0.0.1',
  port: Number(process.env.API_PORT ?? 4100),
  apiUrl: process.env.API_URL ?? 'http://127.0.0.1:4100',
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://aleph_meets:aleph_meets_dev@127.0.0.1:5432/aleph_meets',
  idpBaseUrl: (process.env.IDP_BASE_URL ?? 'https://api.alephtrade.com/id').replace(/\/$/, ''),
  idpEncodeKey: process.env.IDP_ENCODE_KEY ?? '',
  idpDecodeKey: process.env.IDP_DECODE_KEY ?? '',
  idpAccessKey: process.env.IDP_ACCESS_KEY ?? '',
  adControlSecret: process.env.AD_CONTOL_SECRET ?? process.env.AD_CONTROL_SECRET ?? '',
  livekitUrl: process.env.LIVEKIT_URL ?? 'ws://127.0.0.1:7880',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? 'devkey',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? 'secret',
  uploadDir: resolve(rootDir, process.env.UPLOAD_DIR ?? 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 100) * 1024 * 1024,
  s3UploadBaseUrl: (process.env.S3_UPLOAD_BASE_URL ?? 'https://api.alephtrade.com/s3').replace(/\/$/, ''),
  s3UploadAuth: process.env.S3_UPLOAD_AUTH ?? '',
  s3Bucket: process.env.S3_BUCKET ?? 'alephtrade-storage',
  s3PublicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? 'https://storage.yandexcloud.net').replace(/\/$/, ''),
  s3RootPath: (process.env.S3_ROOT_PATH ?? 'alephmeets').replace(/^\/+|\/+$/g, '') || 'alephmeets',
  alephaAgentBaseUrl: (process.env.ALEPHA_AGENT_BASE_URL ?? 'http://api.alephtrade.com/agent01').replace(/\/$/, ''),
  smtpHost: process.env.SMTP_HOST ?? '',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpSecure: /^true|1|yes$/i.test(process.env.SMTP_SECURE ?? ''),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPassword: process.env.SMTP_PASSWORD ?? '',
  smtpFrom: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
  smtpRejectUnauthorized: !/^false|0|no$/i.test(process.env.SMTP_REJECT_UNAUTHORIZED ?? 'true'),
  credentialEncryptionKey:
    process.env.CREDENTIAL_ENCRYPTION_KEY ?? 'aleph-meets-local-development-key-change-me',
}
