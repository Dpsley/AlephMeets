import { randomBytes } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import axios from 'axios'
import FormData from 'form-data'
import { config } from './config.js'

export interface UploadedStorageFile {
  storageName: string
  storageKey: string
  storageUrl: string
  storageBucket: string
  storageProvider: 's3'
  byteSize: number
}

interface UploadStreamInput {
  stream: Readable
  originalName: string
  mimeType: string
  scopePath: string
  storageName?: string
}

export function randomStorageSuffix(length = 16): string {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function sanitizeFilenamePart(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return sanitized || fallback
}

function splitFilename(filename: string): { name: string; extension: string } {
  const cleaned = sanitizeFilenamePart(filename, 'file')
  const dotIndex = cleaned.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === cleaned.length - 1) return { name: cleaned, extension: '' }
  return {
    name: sanitizeFilenamePart(cleaned.slice(0, dotIndex), 'file'),
    extension: cleaned.slice(dotIndex).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 24),
  }
}

function sanitizePathSegment(value: string): string {
  return sanitizeFilenamePart(value, 'item').replace(/\./g, '-')
}

export function buildStorageScope(...segments: string[]): string {
  return [config.s3RootPath, ...segments.map(sanitizePathSegment)]
    .map(trimSlashes)
    .filter(Boolean)
    .join('/')
}

export function attachmentStorageName(originalName: string, suffix = randomStorageSuffix()): string {
  const { name, extension } = splitFilename(originalName)
  return `${name}-${suffix}${extension}`
}

export function recordingStorageName(
  originalName: string,
  startsAt: Date | string | null | undefined,
  suffix = randomStorageSuffix(),
): string {
  const { extension } = splitFilename(originalName)
  const date = startsAt ? new Date(startsAt) : new Date()
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString()
  const safeStamp = stamp.replace('T', '_').replace(/[:.]/g, '-').replace(/Z$/, '')
  return `${safeStamp}-${suffix}${extension || '.webm'}`
}

export function buildStoragePublicUrl(bucket: string, storageKey: string): string {
  const encodedBucket = encodeURIComponent(bucket)
  const encodedKey = storageKey.split('/').map(encodeURIComponent).join('/')
  return `${config.s3PublicBaseUrl}/${encodedBucket}/${encodedKey}`
}

export async function uploadStreamToS3(input: UploadStreamInput): Promise<UploadedStorageFile> {
  if (!config.s3UploadAuth) {
    throw Object.assign(new Error('S3_UPLOAD_AUTH is not configured'), { statusCode: 500 })
  }

  const storageName = input.storageName ?? attachmentStorageName(input.originalName)
  const scopePath = trimSlashes(input.scopePath)
  const storageKey = `${scopePath}/${storageName}`
  const counter = new PassThrough()
  let byteSize = 0
  counter.on('data', (chunk: Buffer | string) => {
    byteSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
  })
  input.stream.on('error', (error) => counter.destroy(error))

  const form = new FormData()
  form.append('file', counter, {
    filename: storageName,
    contentType: input.mimeType || 'application/octet-stream',
  })
  form.append('path', `/${scopePath}`)

  const uploadUrl = `${config.s3UploadBaseUrl}/upload-by-path/${encodeURIComponent(config.s3Bucket)}/${encodeURIComponent(storageName)}/0`
  const request = axios.post(uploadUrl, form, {
    headers: {
      ...form.getHeaders(),
      auth: config.s3UploadAuth,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120_000,
  })

  input.stream.pipe(counter)

  try {
    await request
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      const suffix = status ? ` (${status})` : ''
      throw Object.assign(new Error(`S3 upload failed${suffix}`), { statusCode: 502 })
    }
    throw error
  }

  return {
    storageName,
    storageKey,
    storageUrl: buildStoragePublicUrl(config.s3Bucket, storageKey),
    storageBucket: config.s3Bucket,
    storageProvider: 's3',
    byteSize,
  }
}
